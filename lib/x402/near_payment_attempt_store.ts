import {
  existsSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { isValidNearAccountId, isValidNearHash } from "./near_networks.js";

const HASH = /^[0-9a-f]{64}$/;
const ATTEMPT_ID = /^paynear_[0-9a-f]{32}$/;

export type NearPaymentAttemptStatus = "settling" | "settled" | "indeterminate" | "failed";

export interface StoredNearSettlement {
  network: string; // "near:testnet" | "near:mainnet"
  asset: string; // "near-native"
  amountYocto: string;
  payer?: string; // NEAR account id
  receiver: string; // NEAR account id
  transaction?: string; // base58 tx hash
  externalReceiptId?: string;
  responseHeaders: Record<string, string>;
  resourceResponse: unknown;
}

export interface NearFinalityRecord {
  status: "pending" | "confirmed" | "not_found" | "mismatch" | "unavailable";
  checkedAt: string;
  confirmations?: number;
  reason?: string;
}

export interface NearPaymentAttempt {
  schemaVersion: 1;
  attemptId: string;
  paymentProofHash: string;
  requestHash: string;
  requestId: string;
  status: NearPaymentAttemptStatus;
  settlement?: StoredNearSettlement;
  finality?: NearFinalityRecord;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export type NearPaymentAttemptClaim =
  | { created: true; attempt: NearPaymentAttempt }
  | { created: false; attempt: NearPaymentAttempt };

/**
 * Durable exact-once replay barrier for NEAR x402 settlement — the same role
 * `QiePaymentAttemptStore` / `AlgorandPaymentAttemptStore` play for their
 * chains, reshaped for NEAR identity formats (account ids / base58 tx
 * hashes). Raw `PAYMENT-SIGNATURE` values are never written; files are keyed
 * by their SHA-256 digest.
 */
export class NearPaymentAttemptStore {
  private readonly memory = new Map<string, NearPaymentAttempt>();
  private readonly attemptById = new Map<string, string>();
  private readonly directory?: string;
  // Second, independent claim index keyed by the REAL on-chain transaction
  // hash rather than the self-declared PAYMENT-SIGNATURE header bytes. A
  // transaction hash is public blockchain data: anyone can read a past
  // payer's (signerId, transaction) pair off an explorer and re-submit it,
  // re-encoded with different-but-ignored JSON fields (reordered keys, an
  // extra padding field, etc.), to mint a brand-new `paymentProofHash` that
  // decodes to the SAME already-settled transfer. Without this index, each
  // such resubmission looks like a fresh, never-before-seen proof and sails
  // through settlement, letting one real payment buy an unlimited number of
  // paid resources for free. `txOwner` makes "this transaction already paid
  // for something" its own durable fact, independent of how many different
  // ways the proof can be re-encoded.
  private readonly txOwner = new Map<string, string>();
  private readonly txDirectory?: string;

  constructor(dataDir?: string) {
    if (dataDir) {
      this.directory = join(dataDir, "near-payment-attempts");
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.loadExisting();
      this.txDirectory = join(dataDir, "near-payment-attempts-by-tx");
      mkdirSync(this.txDirectory, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Atomically claim `transaction` (a real NEAR tx hash) as proof for
   * `paymentProofHash`. Returns the `paymentProofHash` that actually owns
   * this transaction: either the one just passed in (first claim wins) or
   * an earlier one if this transaction was already used as proof — in
   * which case the caller must NOT treat the current request as a fresh,
   * unpaid-for settlement. First-claim-wins is enforced durably via an
   * exclusive (`wx`) file create, the same primitive `claim()` uses for
   * `paymentProofHash`, so two concurrent requests racing the same real
   * transaction can never both win.
   */
  claimTransaction(transaction: string, paymentProofHash: string): string {
    if (!isValidNearHash(transaction)) throw new Error("invalid NEAR transaction hash");
    this.assertHash(paymentProofHash);
    const cached = this.txOwner.get(transaction);
    if (cached) return cached;

    if (!this.txDirectory) {
      // No durable data dir configured (dev/in-memory mode) — best-effort,
      // process-local uniqueness only.
      this.txOwner.set(transaction, paymentProofHash);
      return paymentProofHash;
    }

    const path = join(this.txDirectory, `${transaction}.json`);
    try {
      writeFileSync(path, JSON.stringify({ paymentProofHash }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      this.syncFile(path);
      this.txOwner.set(transaction, paymentProofHash);
      return paymentProofHash;
    } catch (error) {
      if (this.isAlreadyExists(error)) {
        const existingOwner = this.readTxOwner(path);
        if (existingOwner) {
          this.txOwner.set(transaction, existingOwner);
          return existingOwner;
        }
      }
      throw error;
    }
  }

  private readTxOwner(path: string): string | undefined {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { paymentProofHash?: unknown };
      return typeof parsed.paymentProofHash === "string" && HASH.test(parsed.paymentProofHash)
        ? parsed.paymentProofHash
        : undefined;
    } catch {
      return undefined;
    }
  }

  claim(input: { paymentProofHash: string; requestHash: string; requestId: string }): NearPaymentAttemptClaim {
    this.assertHash(input.paymentProofHash);
    this.assertHash(input.requestHash);
    const existing = this.getByProofHash(input.paymentProofHash);
    if (existing) return { created: false, attempt: existing };

    const now = new Date().toISOString();
    const attempt: NearPaymentAttempt = {
      schemaVersion: 1,
      attemptId: `paynear_${randomBytes(16).toString("hex")}`,
      paymentProofHash: input.paymentProofHash,
      requestHash: input.requestHash,
      requestId: input.requestId.slice(0, 128),
      status: "settling",
      createdAt: now,
      updatedAt: now,
    };

    if (this.directory) {
      try {
        writeFileSync(this.pathFor(input.paymentProofHash), this.serialize(attempt), {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        this.syncFile(this.pathFor(input.paymentProofHash));
      } catch (error) {
        if (this.isAlreadyExists(error)) {
          const winner = this.readFile(input.paymentProofHash);
          if (winner) return { created: false, attempt: winner };
        }
        throw error;
      }
    }

    this.remember(attempt);
    return { created: true, attempt: structuredClone(attempt) };
  }

  getByProofHash(paymentProofHash: string): NearPaymentAttempt | undefined {
    if (!HASH.test(paymentProofHash)) return undefined;
    const remembered = this.memory.get(paymentProofHash);
    if (remembered) return structuredClone(remembered);
    const persisted = this.readFile(paymentProofHash);
    if (persisted) this.remember(persisted);
    return persisted ? structuredClone(persisted) : undefined;
  }

  getByAttemptId(attemptId: string): NearPaymentAttempt | undefined {
    if (!ATTEMPT_ID.test(attemptId)) return undefined;
    const proofHash = this.attemptById.get(attemptId);
    return proofHash ? this.getByProofHash(proofHash) : undefined;
  }

  list(): NearPaymentAttempt[] {
    return [...this.memory.values()]
      .map((attempt) => structuredClone(attempt))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  settle(paymentProofHash: string, settlement: StoredNearSettlement): NearPaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({
      ...attempt,
      status: "settled",
      settlement,
      errorCode: undefined,
    }));
  }

  markIndeterminate(paymentProofHash: string): NearPaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({
      ...attempt,
      status: "indeterminate",
      errorCode: "x402_settlement_indeterminate",
    }));
  }

  markFailed(paymentProofHash: string, errorCode: string): NearPaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({
      ...attempt,
      status: "failed",
      errorCode: errorCode.slice(0, 128),
    }));
  }

  recordFinality(paymentProofHash: string, check: NearFinalityRecord): NearPaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({ ...attempt, finality: check }));
  }

  private update(
    paymentProofHash: string,
    mutate: (attempt: NearPaymentAttempt) => NearPaymentAttempt,
  ): NearPaymentAttempt {
    const current = this.getByProofHash(paymentProofHash);
    if (!current) throw new Error("unknown NEAR payment attempt");
    const updated = { ...mutate(current), updatedAt: new Date().toISOString() };
    this.persist(updated);
    return structuredClone(updated);
  }

  private persist(attempt: NearPaymentAttempt): void {
    if (this.directory) {
      const target = this.pathFor(attempt.paymentProofHash);
      const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(temporary, this.serialize(attempt), { encoding: "utf8", mode: 0o600 });
      this.syncFile(temporary);
      renameSync(temporary, target);
    }
    this.remember(attempt);
  }

  private loadExisting(): void {
    if (!this.directory) return;
    for (const name of readdirSync(this.directory)) {
      const match = name.match(/^([0-9a-f]{64})\.json$/);
      if (!match) continue;
      const attempt = this.readFile(match[1]!);
      if (attempt) this.remember(attempt);
    }
  }

  private readFile(paymentProofHash: string): NearPaymentAttempt | undefined {
    if (!this.directory) return undefined;
    const path = this.pathFor(paymentProofHash);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as NearPaymentAttempt;
      if (!this.valid(parsed) || parsed.paymentProofHash !== paymentProofHash) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private valid(value: NearPaymentAttempt): boolean {
    const settlementValid = value?.status !== "settled" || (
      typeof value.settlement?.network === "string"
      && typeof value.settlement.asset === "string"
      && /^\d+$/.test(value.settlement.amountYocto)
      && isValidNearAccountId(value.settlement.receiver)
      && (value.settlement.transaction === undefined || isValidNearHash(value.settlement.transaction))
      && typeof value.settlement.responseHeaders === "object"
      && value.settlement.responseHeaders !== null
    );
    return value?.schemaVersion === 1
      && ATTEMPT_ID.test(value.attemptId)
      && HASH.test(value.paymentProofHash)
      && HASH.test(value.requestHash)
      && ["settling", "settled", "indeterminate", "failed"].includes(value.status)
      && settlementValid
      && typeof value.createdAt === "string"
      && typeof value.updatedAt === "string";
  }

  private remember(attempt: NearPaymentAttempt): void {
    this.memory.set(attempt.paymentProofHash, structuredClone(attempt));
    this.attemptById.set(attempt.attemptId, attempt.paymentProofHash);
  }

  private serialize(attempt: NearPaymentAttempt): string {
    return `${JSON.stringify(attempt, null, 2)}\n`;
  }

  private pathFor(paymentProofHash: string): string {
    this.assertHash(paymentProofHash);
    return join(this.directory!, `${paymentProofHash}.json`);
  }

  private assertHash(value: string): void {
    if (!HASH.test(value)) throw new Error("invalid payment attempt hash");
  }

  private isAlreadyExists(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error
      && (error as { code?: unknown }).code === "EEXIST";
  }

  private syncFile(path: string): void {
    const descriptor = openSync(path, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

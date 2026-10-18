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

const HASH = /^[0-9a-f]{64}$/;
const ATTEMPT_ID = /^payqie_[0-9a-f]{32}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export type QiePaymentAttemptStatus = "settling" | "settled" | "indeterminate" | "failed";

export interface StoredQieSettlement {
  network: string;
  asset: string; // ERC-20 contract address
  amountBaseUnits: string;
  payer?: string;
  receiver: string;
  transaction?: string; // 0x tx hash
  responseHeaders: Record<string, string>;
  resourceResponse: unknown;
}

export interface QieFinalityRecord {
  status: "pending" | "confirmed" | "not_found" | "mismatch" | "unavailable";
  checkedAt: string;
  confirmations?: number;
  reason?: string;
}

export interface QiePaymentAttempt {
  schemaVersion: 1;
  attemptId: string;
  paymentProofHash: string;
  requestHash: string;
  requestId: string;
  status: QiePaymentAttemptStatus;
  settlement?: StoredQieSettlement;
  finality?: QieFinalityRecord;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export type QiePaymentAttemptClaim =
  | { created: true; attempt: QiePaymentAttempt }
  | { created: false; attempt: QiePaymentAttempt };

/**
 * Durable exact-once replay barrier for QIE x402 settlement — the same role
 * `AlgorandPaymentAttemptStore` plays for Algorand, reshaped for EVM identity
 * formats (0x addresses / 0x tx hashes instead of Algorand's base32 forms).
 * Raw `PAYMENT-SIGNATURE` values are never written; files are keyed by their
 * SHA-256 digest.
 */
export class QiePaymentAttemptStore {
  private readonly memory = new Map<string, QiePaymentAttempt>();
  private readonly attemptById = new Map<string, string>();
  private readonly directory?: string;

  constructor(dataDir?: string) {
    if (dataDir) {
      this.directory = join(dataDir, "qie-payment-attempts");
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.loadExisting();
    }
  }

  claim(input: { paymentProofHash: string; requestHash: string; requestId: string }): QiePaymentAttemptClaim {
    this.assertHash(input.paymentProofHash);
    this.assertHash(input.requestHash);
    const existing = this.getByProofHash(input.paymentProofHash);
    if (existing) return { created: false, attempt: existing };

    const now = new Date().toISOString();
    const attempt: QiePaymentAttempt = {
      schemaVersion: 1,
      attemptId: `payqie_${randomBytes(16).toString("hex")}`,
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

  getByProofHash(paymentProofHash: string): QiePaymentAttempt | undefined {
    if (!HASH.test(paymentProofHash)) return undefined;
    const remembered = this.memory.get(paymentProofHash);
    if (remembered) return structuredClone(remembered);
    const persisted = this.readFile(paymentProofHash);
    if (persisted) this.remember(persisted);
    return persisted ? structuredClone(persisted) : undefined;
  }

  getByAttemptId(attemptId: string): QiePaymentAttempt | undefined {
    if (!ATTEMPT_ID.test(attemptId)) return undefined;
    const proofHash = this.attemptById.get(attemptId);
    return proofHash ? this.getByProofHash(proofHash) : undefined;
  }

  list(): QiePaymentAttempt[] {
    return [...this.memory.values()]
      .map((attempt) => structuredClone(attempt))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  settle(paymentProofHash: string, settlement: StoredQieSettlement): QiePaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({
      ...attempt,
      status: "settled",
      settlement,
      errorCode: undefined,
    }));
  }

  markIndeterminate(paymentProofHash: string): QiePaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({
      ...attempt,
      status: "indeterminate",
      errorCode: "x402_settlement_indeterminate",
    }));
  }

  markFailed(paymentProofHash: string, errorCode: string): QiePaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({
      ...attempt,
      status: "failed",
      errorCode: errorCode.slice(0, 128),
    }));
  }

  recordFinality(paymentProofHash: string, check: QieFinalityRecord): QiePaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({ ...attempt, finality: check }));
  }

  private update(
    paymentProofHash: string,
    mutate: (attempt: QiePaymentAttempt) => QiePaymentAttempt,
  ): QiePaymentAttempt {
    const current = this.getByProofHash(paymentProofHash);
    if (!current) throw new Error("unknown QIE payment attempt");
    const updated = { ...mutate(current), updatedAt: new Date().toISOString() };
    this.persist(updated);
    return structuredClone(updated);
  }

  private persist(attempt: QiePaymentAttempt): void {
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

  private readFile(paymentProofHash: string): QiePaymentAttempt | undefined {
    if (!this.directory) return undefined;
    const path = this.pathFor(paymentProofHash);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as QiePaymentAttempt;
      if (!this.valid(parsed) || parsed.paymentProofHash !== paymentProofHash) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private valid(value: QiePaymentAttempt): boolean {
    const settlementValid = value?.status !== "settled" || (
      typeof value.settlement?.network === "string"
      && EVM_ADDRESS.test(value.settlement.asset)
      && /^\d+$/.test(value.settlement.amountBaseUnits)
      && EVM_ADDRESS.test(value.settlement.receiver)
      && (value.settlement.transaction === undefined || EVM_TX_HASH.test(value.settlement.transaction))
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

  private remember(attempt: QiePaymentAttempt): void {
    this.memory.set(attempt.paymentProofHash, structuredClone(attempt));
    this.attemptById.set(attempt.attemptId, attempt.paymentProofHash);
  }

  private serialize(attempt: QiePaymentAttempt): string {
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

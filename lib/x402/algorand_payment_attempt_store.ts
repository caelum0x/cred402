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
const ATTEMPT_ID = /^pay_[0-9a-f]{32}$/;

export type AlgorandPaymentAttemptStatus =
  | "settling"
  | "settled"
  | "indeterminate"
  | "failed";

export interface StoredAlgorandSettlement {
  network: string;
  asset: string;
  amountMicroUsdc: string;
  payer?: string;
  receiver: string;
  transaction?: string;
  externalReceiptId?: string;
  responseHeaders: Record<string, string>;
  resourceResponse: unknown;
}

export interface AlgorandFinalityCheck {
  status: "pending" | "confirmed" | "not_found" | "mismatch" | "unavailable";
  checkedAt: string;
  confirmedRound?: number;
  currentRound?: number;
  confirmations?: number;
  consecutiveMisses: number;
  reason?: string;
}

export interface AlgorandPaymentAttempt {
  schemaVersion: 1;
  attemptId: string;
  paymentProofHash: string;
  requestHash: string;
  requestId: string;
  status: AlgorandPaymentAttemptStatus;
  settlement?: StoredAlgorandSettlement;
  finality?: AlgorandFinalityCheck;
  errorCode?: string;
  refund: {
    status: "not_required" | "pending_reconciliation" | "review_required" | "completed";
    reason?: string;
    transaction?: string;
    updatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export type PaymentAttemptClaim =
  | { created: true; attempt: AlgorandPaymentAttempt }
  | { created: false; attempt: AlgorandPaymentAttempt };

/**
 * Durable replay barrier for Algorand x402 settlement. Raw PAYMENT-SIGNATURE
 * values are never written; files are keyed by their SHA-256 digest.
 */
export class AlgorandPaymentAttemptStore {
  private readonly memory = new Map<string, AlgorandPaymentAttempt>();
  private readonly attemptById = new Map<string, string>();
  private readonly directory?: string;

  constructor(dataDir?: string) {
    if (dataDir) {
      this.directory = join(dataDir, "algorand-payment-attempts");
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.loadExisting();
    }
  }

  claim(input: {
    paymentProofHash: string;
    requestHash: string;
    requestId: string;
  }): PaymentAttemptClaim {
    this.assertHash(input.paymentProofHash);
    this.assertHash(input.requestHash);
    const existing = this.getByProofHash(input.paymentProofHash);
    if (existing) return { created: false, attempt: existing };

    const now = new Date().toISOString();
    const attempt: AlgorandPaymentAttempt = {
      schemaVersion: 1,
      attemptId: `pay_${randomBytes(16).toString("hex")}`,
      paymentProofHash: input.paymentProofHash,
      requestHash: input.requestHash,
      requestId: input.requestId.slice(0, 128),
      status: "settling",
      refund: { status: "not_required", updatedAt: now },
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

  getByProofHash(paymentProofHash: string): AlgorandPaymentAttempt | undefined {
    if (!HASH.test(paymentProofHash)) return undefined;
    const remembered = this.memory.get(paymentProofHash);
    if (remembered) return structuredClone(remembered);
    const persisted = this.readFile(paymentProofHash);
    if (persisted) this.remember(persisted);
    return persisted ? structuredClone(persisted) : undefined;
  }

  getByAttemptId(attemptId: string): AlgorandPaymentAttempt | undefined {
    if (!ATTEMPT_ID.test(attemptId)) return undefined;
    const proofHash = this.attemptById.get(attemptId);
    return proofHash ? this.getByProofHash(proofHash) : undefined;
  }

  list(): AlgorandPaymentAttempt[] {
    return [...this.memory.values()]
      .map((attempt) => structuredClone(attempt))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  settle(paymentProofHash: string, settlement: StoredAlgorandSettlement): AlgorandPaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({
      ...attempt,
      status: "settled",
      settlement,
      errorCode: undefined,
      refund: attempt.refund.status === "review_required" || attempt.refund.status === "completed"
        ? attempt.refund
        : { status: "not_required", updatedAt: new Date().toISOString() },
    }));
  }

  markIndeterminate(paymentProofHash: string): AlgorandPaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({
      ...attempt,
      status: "indeterminate",
      errorCode: "x402_settlement_indeterminate",
      refund: {
        status: "pending_reconciliation",
        reason: "Settlement outcome is unknown; do not submit another payment",
        updatedAt: new Date().toISOString(),
      },
    }));
  }

  markFailed(paymentProofHash: string, errorCode: string): AlgorandPaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({
      ...attempt,
      status: "failed",
      errorCode: errorCode.slice(0, 128),
      refund: { status: "not_required", updatedAt: new Date().toISOString() },
    }));
  }

  requireRefundReview(paymentProofHash: string, reason: string, transaction?: string): AlgorandPaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({
      ...attempt,
      refund: {
        status: "review_required",
        reason: reason.slice(0, 500),
        transaction,
        updatedAt: new Date().toISOString(),
      },
    }));
  }

  completeRefund(paymentProofHash: string, transaction: string): AlgorandPaymentAttempt {
    if (!/^[A-Z2-7]{52}$/.test(transaction)) throw new Error("invalid Algorand refund transaction id");
    return this.update(paymentProofHash, (attempt) => {
      if (attempt.refund.status !== "review_required") {
        throw new Error("payment attempt is not awaiting refund review");
      }
      return {
        ...attempt,
        refund: {
          status: "completed",
          reason: "Operator recorded independently executed refund",
          transaction,
          updatedAt: new Date().toISOString(),
        },
      };
    });
  }

  recordFinality(
    paymentProofHash: string,
    check: Omit<AlgorandFinalityCheck, "checkedAt" | "consecutiveMisses">,
  ): AlgorandPaymentAttempt {
    return this.update(paymentProofHash, (attempt) => ({
      ...attempt,
      finality: {
        ...check,
        checkedAt: new Date().toISOString(),
        consecutiveMisses: check.status === "not_found"
          ? (attempt.finality?.consecutiveMisses ?? 0) + 1
          : 0,
      },
    }));
  }

  private update(
    paymentProofHash: string,
    mutate: (attempt: AlgorandPaymentAttempt) => AlgorandPaymentAttempt,
  ): AlgorandPaymentAttempt {
    const current = this.getByProofHash(paymentProofHash);
    if (!current) throw new Error("unknown Algorand payment attempt");
    const updated = { ...mutate(current), updatedAt: new Date().toISOString() };
    this.persist(updated);
    return structuredClone(updated);
  }

  private persist(attempt: AlgorandPaymentAttempt): void {
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

  private readFile(paymentProofHash: string): AlgorandPaymentAttempt | undefined {
    if (!this.directory) return undefined;
    const path = this.pathFor(paymentProofHash);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as AlgorandPaymentAttempt;
      if (!this.valid(parsed) || parsed.paymentProofHash !== paymentProofHash) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private valid(value: AlgorandPaymentAttempt): boolean {
    const refundStatuses = ["not_required", "pending_reconciliation", "review_required", "completed"];
    const settlementValid = value?.status !== "settled" || (
      typeof value.settlement?.network === "string"
      && typeof value.settlement.asset === "string"
      && /^\d+$/.test(value.settlement.asset)
      && /^\d+$/.test(value.settlement.amountMicroUsdc)
      && typeof value.settlement.receiver === "string"
      && typeof value.settlement.responseHeaders === "object"
      && value.settlement.responseHeaders !== null
    );
    return value?.schemaVersion === 1
      && ATTEMPT_ID.test(value.attemptId)
      && HASH.test(value.paymentProofHash)
      && HASH.test(value.requestHash)
      && ["settling", "settled", "indeterminate", "failed"].includes(value.status)
      && typeof value.refund?.status === "string"
      && refundStatuses.includes(value.refund.status)
      && settlementValid
      && typeof value.createdAt === "string"
      && typeof value.updatedAt === "string";
  }

  private remember(attempt: AlgorandPaymentAttempt): void {
    this.memory.set(attempt.paymentProofHash, structuredClone(attempt));
    this.attemptById.set(attempt.attemptId, attempt.paymentProofHash);
  }

  private serialize(attempt: AlgorandPaymentAttempt): string {
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

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

import type { ExternalReceipt } from "../ledger/contracts/external_receipt_registry.js";
import { verifyUniversalReceipt } from "../../crosschain/standards/receipts.js";

const RECEIPT_ID = /^0x[0-9a-f]{64}$/;

/** Durable, content-addressed copies used by the public x402 proof endpoint. */
export class ExternalReceiptProofStore {
  private readonly directory: string;

  constructor(dataDir: string) {
    this.directory = join(dataDir, "external-receipts");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  put(receipt: ExternalReceipt): void {
    this.assertReceiptId(receipt.receipt_id);
    const integrity = verifyUniversalReceipt(receipt.envelope, receipt.receipt_id);
    if (!integrity.ok) {
      throw new Error(`refusing to persist invalid external receipt: ${integrity.reason}`);
    }

    const target = this.pathFor(receipt.receipt_id);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const descriptor = openSync(temporary, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
  }

  get(receiptId: string): ExternalReceipt | undefined {
    if (!RECEIPT_ID.test(receiptId)) return undefined;
    const target = this.pathFor(receiptId);
    if (!existsSync(target)) return undefined;

    try {
      const parsed = JSON.parse(readFileSync(target, "utf8")) as ExternalReceipt;
      if (parsed.receipt_id !== receiptId) return undefined;
      const integrity = verifyUniversalReceipt(parsed.envelope, receiptId);
      return integrity.ok ? parsed : undefined;
    } catch {
      // A corrupt proof is treated as absent; never serve an unverifiable file.
      return undefined;
    }
  }

  list(): ExternalReceipt[] {
    return readdirSync(this.directory)
      .filter((name) => /^0x[0-9a-f]{64}\.json$/.test(name))
      .map((name) => this.get(name.slice(0, -5)))
      .filter((receipt): receipt is ExternalReceipt => receipt !== undefined);
  }

  private pathFor(receiptId: string): string {
    return join(this.directory, `${receiptId}.json`);
  }

  private assertReceiptId(receiptId: string): void {
    if (!RECEIPT_ID.test(receiptId)) {
      throw new Error("invalid external receipt id");
    }
  }
}

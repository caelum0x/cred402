import { resolve } from "node:path";
import { AlgorandPaymentAttemptStore } from "../lib/x402/algorand_payment_attempt_store.js";

const args = process.argv.slice(2);
const dataDir = process.env.CRED402_DATA_DIR?.trim();
if (!dataDir) throw new Error("CRED402_DATA_DIR is required");
const store = new AlgorandPaymentAttemptStore(resolve(dataDir));

const completeId = value("--complete=");
if (!completeId) {
  const queue = store.list()
    .filter((attempt) =>
      attempt.refund.status === "review_required" || attempt.status === "indeterminate",
    )
    .map((attempt) => ({
      attempt_id: attempt.attemptId,
      created_at: attempt.createdAt,
      network: attempt.settlement?.network,
      amount_micro_usdc: attempt.settlement?.amountMicroUsdc,
      settlement_transaction: attempt.settlement?.transaction,
      reason: attempt.refund.reason,
      action: attempt.refund.status === "review_required"
        ? "verify and execute refund through treasury workflow"
        : "reconcile facilitator and chain state; do not retry settlement",
    }));
  process.stdout.write(`${JSON.stringify({ schema_version: "cred402.algorand-refund-queue.v1", queue }, null, 2)}\n`);
} else {
  const attempt = store.getByAttemptId(completeId);
  if (!attempt) throw new Error("unknown payment attempt");
  const refundTransaction = value("--refund-transaction=");
  if (!refundTransaction) throw new Error("--refund-transaction=ALGORAND_TX_ID is required");
  const expectedConfirmation = `REFUND_RECORDED ${attempt.attemptId} ${refundTransaction}`;
  if (value("--confirm=") !== expectedConfirmation) {
    throw new Error(`Refusing to change refund state. Pass --confirm=\"${expectedConfirmation}\" after independently verifying the refund.`);
  }
  const updated = store.completeRefund(attempt.paymentProofHash, refundTransaction);
  process.stdout.write(`${JSON.stringify({
    schema_version: "cred402.algorand-refund-completion.v1",
    attempt_id: updated.attemptId,
    refund_status: updated.refund.status,
    refund_transaction: updated.refund.transaction,
    updated_at: updated.refund.updatedAt,
  }, null, 2)}\n`);
}

function value(prefix: string): string | undefined {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() || undefined;
}

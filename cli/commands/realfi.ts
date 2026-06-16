/**
 * `realfi` command group: operator verification, fiat receipts, and state view.
 */
import { type CommandContext, emit, requireArg, UsageError } from "../lib/context.js";
import { idempotencyKey } from "../lib/http.js";
import { color, heading, keyValues, statusBadge, table } from "../lib/render.js";

interface OperatorVerification {
  operator_id?: string;
  verification_level?: string;
  jurisdiction?: string;
  verification_status?: string;
}

interface FiatReceipt {
  receipt_id?: string;
  seller_agent?: string;
  operator_id?: string;
  amount?: string;
  currency?: string;
}

interface RealFiState {
  fiatReceipts: FiatReceipt[];
  operatorVerifications: OperatorVerification[];
  attestations: unknown[];
}

const USAGE = `realfi — RealFi bridge: operator verification + fiat billing

Usage:
  cred402 realfi show
  cred402 realfi verify-operator <operator_id> <jurisdiction>
  cred402 realfi fiat-receipt <seller_agent> <operator_id> <amount>`;

export async function realfiCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "show":
    case undefined:
      return show(ctx);
    case "verify-operator":
      return verifyOperator(ctx);
    case "fiat-receipt":
      return fiatReceipt(ctx);
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: realfi ${sub}\n\n${USAGE}`);
  }
}

async function show(ctx: CommandContext): Promise<void> {
  const s = await ctx.client.get<RealFiState>("/api/realfi");
  emit(ctx, s, () => {
    const opRows = s.operatorVerifications.map((o) => [
      color.bold(o.operator_id ?? "—"),
      o.jurisdiction ?? "—",
      o.verification_level ?? "—",
      statusBadge(o.verification_status ?? "unknown"),
    ]);
    const rcRows = s.fiatReceipts.map((r) => [
      (r.receipt_id ?? "—").slice(0, 18),
      r.seller_agent ?? "—",
      r.operator_id ?? "—",
      `${r.amount ?? "—"} ${r.currency ?? ""}`.trim(),
    ]);
    return (
      heading(`Operator Verifications (${s.operatorVerifications.length})`) +
      "\n" +
      table(
        [{ header: "OPERATOR" }, { header: "JURISDICTION" }, { header: "LEVEL" }, { header: "STATUS" }],
        opRows,
      ) +
      heading(`Fiat Receipts (${s.fiatReceipts.length})`) +
      "\n" +
      table([{ header: "RECEIPT" }, { header: "SELLER" }, { header: "OPERATOR" }, { header: "AMOUNT" }], rcRows) +
      heading(`Attestations`) +
      "\n" +
      color.dim(`${s.attestations.length} on-chain attestation(s)`)
    );
  });
}

async function verifyOperator(ctx: CommandContext): Promise<void> {
  const operatorId = requireArg(ctx.args, 1, "operator_id");
  const jurisdiction = requireArg(ctx.args, 2, "jurisdiction");
  if (jurisdiction.length !== 2) throw new UsageError(`jurisdiction must be a 2-letter ISO code, got "${jurisdiction}"`);
  const result = await ctx.client.post<{
    attestation_hash: string;
    envelope: { verification_level: string; verification_status: string; jurisdiction: string };
  }>(
    "/v1/realfi/operators",
    {
      operator_id: operatorId,
      jurisdiction: jurisdiction.toUpperCase(),
      verification_reference: `cli_idv_${Date.now()}`,
    },
    idempotencyKey("verify-op"),
  );
  emit(ctx, result, () =>
    heading(`Verified Operator — ${operatorId}`) +
    "\n" +
    keyValues([
      ["status", statusBadge(result.envelope.verification_status)],
      ["level", result.envelope.verification_level],
      ["jurisdiction", result.envelope.jurisdiction],
      ["attestation_hash", color.gray(result.attestation_hash)],
    ]),
  );
}

async function fiatReceipt(ctx: CommandContext): Promise<void> {
  const seller = requireArg(ctx.args, 1, "seller_agent");
  const operatorId = requireArg(ctx.args, 2, "operator_id");
  const amount = requireArg(ctx.args, 3, "amount");
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new UsageError(`amount must be a decimal like 100.00, got "${amount}"`);
  const stamp = Date.now();
  const result = await ctx.client.post<{
    receipt_id: string;
    envelope: { amount: string; currency: string; seller_agent: string; operator_id: string };
  }>(
    "/v1/realfi/fiat-receipts",
    {
      seller_agent: seller,
      operator_id: operatorId,
      amount,
      provider_event_id: `cli_evt_${stamp}`,
      provider_receipt_id: `cli_ch_${stamp}`,
    },
    idempotencyKey("fiat-receipt"),
  );
  emit(ctx, result, () =>
    heading(`Recorded Fiat Receipt`) +
    "\n" +
    keyValues([
      ["receipt_id", color.gray(result.receipt_id)],
      ["seller_agent", result.envelope.seller_agent],
      ["operator_id", result.envelope.operator_id],
      ["amount", `${result.envelope.amount} ${result.envelope.currency}`],
    ]),
  );
}

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerState } from "../state.js";
import { cspr } from "../../lib/core/units.js";
import {
  challengeHeaders,
  decodePaymentHeader,
  verifyPayment,
} from "../../lib/x402/index.js";

/**
 * Paid evidence server — the real HTTP x402 flow.
 *
 *   GET /verify/energy_output?rwa_id=SOLAR-A17
 *     -> 402 Payment Required + X-Payment-* headers + challenge body
 *   GET /verify/energy_output?rwa_id=SOLAR-A17   (with X-Payment: <base64 proof>)
 *     -> 200 signed verification report; receipt + evidence recorded on Casper
 *
 * Demonstrate it live with `scripts/x402_client.ts`.
 */
export async function handlePaidEvidence(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
  url: URL,
): Promise<void> {
  const evidence_type = url.pathname.replace(/^\/verify\//, "");
  const rwa_id = url.searchParams.get("rwa_id") ?? "SOLAR-A17";
  const payer = url.searchParams.get("buyer") ?? "external.agent";
  const seller = state.economy.seller;
  const bounty = cspr(0.002);

  const paymentHeader = req.headers["x-payment"];

  // Unpaid request -> issue a 402 challenge.
  if (!paymentHeader || typeof paymentHeader !== "string") {
    let challenge;
    try {
      challenge = seller.quote({ rwa_id, evidence_type, amount_motes: bounty });
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message });
      return;
    }
    state.pendingChallenges.set(challenge.payment_id, challenge);
    const headers = challengeHeaders(challenge);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    writeJson(res, 402, {
      status: "Payment Required",
      challenge,
      how_to_pay: "sign the PaymentAuthorization and retry with header `X-Payment: <base64 proof>`",
    });
    return;
  }

  // Paid request -> verify proof and deliver the report.
  try {
    const proof = decodePaymentHeader(paymentHeader);
    const challenge = state.pendingChallenges.get(proof.authorization.payment_id);
    if (!challenge) {
      writeJson(res, 409, { error: "unknown or expired payment_id; request a fresh 402 first" });
      return;
    }
    const check = verifyPayment({ challenge, proof });
    if (!check.ok) {
      writeJson(res, 402, { error: `payment rejected: ${check.reason}` });
      return;
    }
    const { report, receipt, evidence } = await seller.fulfill({
      rwa_id,
      evidence_type,
      challenge,
      proof,
      payer_agent: proof.authorization.payer_agent || payer,
    });
    state.pendingChallenges.delete(challenge.payment_id);
    // Buyer-side settlement so the dashboard shows a finalized receipt.
    state.ledger.receipts.settle_receipt(receipt.receipt_id);
    state.ledger.evidence.verify_evidence(evidence.evidence_id);
    state.ledger.receipts.finalize_receipt(receipt.receipt_id);
    writeJson(res, 200, { report, receipt_id: receipt.receipt_id, evidence_id: evidence.evidence_id });
  } catch (err) {
    writeJson(res, 400, { error: (err as Error).message });
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(json);
}

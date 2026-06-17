import { randomBytes } from "node:crypto";
import {
  X402_DOMAIN,
  challengeHeaders,
  decodePaymentHeader,
  verifyPayment,
  paymentProofHash,
  type PaymentChallenge,
  type PaymentProof,
} from "./x402.js";

/**
 * Cred402 x402 Gateway middleware (roadmap p2) — the adoption wedge.
 *
 * Drop one handler in front of any route and it becomes x402-payable AND
 * receipt-generating: unpaid requests get a `402 Payment Required` + signed
 * challenge; paid requests are verified (EIP-712 / ed25519, replay-protected),
 * a receipt commitment is emitted to your sink, and the request proceeds. Every
 * wrapped endpoint feeds the Cred402 credit-data moat — this is how any API, not
 * just RWA verifiers, starts building agent credit history.
 *
 * Framework-agnostic core + Express and Web (Fetch) adapters.
 */

export interface ReceiptCommitment {
  receipt_id: string;
  payer_agent: string;
  seller_agent: string;
  service_type: string;
  amount_motes: string;
  resource: string;
  payment_proof_hash: string;
  nonce: string;
  created_at: number;
}

/** Replay protection: a used nonce or proof hash can never be reused. */
export interface NonceStore {
  seen(key: string): boolean;
  remember(key: string): void;
}

class MemoryNonceStore implements NonceStore {
  private readonly used = new Set<string>();
  seen(k: string): boolean {
    return this.used.has(k);
  }
  remember(k: string): void {
    this.used.add(k);
  }
}

export interface GatewayAnalytics {
  record(resource: string, event: "challenged" | "paid" | "rejected", amountMotes?: bigint): void;
  snapshot(): Record<string, { challenged: number; paid: number; rejected: number; revenue_motes: string }>;
}

class MemoryAnalytics implements GatewayAnalytics {
  private readonly m = new Map<string, { challenged: number; paid: number; rejected: number; revenue: bigint }>();
  private row(r: string) {
    let x = this.m.get(r);
    if (!x) this.m.set(r, (x = { challenged: 0, paid: 0, rejected: 0, revenue: 0n }));
    return x;
  }
  record(resource: string, event: "challenged" | "paid" | "rejected", amount?: bigint): void {
    const x = this.row(resource);
    x[event]++;
    if (event === "paid" && amount) x.revenue += amount;
  }
  snapshot() {
    const out: Record<string, { challenged: number; paid: number; rejected: number; revenue_motes: string }> = {};
    for (const [r, x] of this.m) out[r] = { challenged: x.challenged, paid: x.paid, rejected: x.rejected, revenue_motes: x.revenue.toString() };
    return out;
  }
}

export interface X402GatewayOptions {
  /** Service category (p1 taxonomy), e.g. "inference.llm", "data.market". */
  serviceType: string;
  /** Price per request, in motes. */
  priceMotes: bigint;
  /** The receiving agent (CAID) that earns this revenue. */
  sellerAgent: string;
  challengeTtlSec?: number;
  nonceStore?: NonceStore;
  analytics?: GatewayAnalytics;
  /** Called with a receipt commitment on every verified payment (anchor it). */
  onReceipt?: (r: ReceiptCommitment) => void | Promise<void>;
  now?: () => number;
  /** id/nonce generator (override for deterministic tests). */
  randomId?: () => string;
}

export type GatewayDecision =
  | { kind: "challenge"; status: 402; headers: Record<string, string>; body: unknown; challenge: PaymentChallenge }
  | { kind: "paid"; payer_agent: string; receipt: ReceiptCommitment }
  | { kind: "rejected"; status: number; body: { error: string } };

export class X402Gateway {
  private readonly pending = new Map<string, PaymentChallenge>();
  private readonly nonces: NonceStore;
  readonly analytics: GatewayAnalytics;
  private readonly now: () => number;
  private readonly rid: () => string;

  constructor(private readonly opts: X402GatewayOptions) {
    this.nonces = opts.nonceStore ?? new MemoryNonceStore();
    this.analytics = opts.analytics ?? new MemoryAnalytics();
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.rid = opts.randomId ?? (() => randomBytes(8).toString("hex"));
  }

  /** Build a signed-shape 402 challenge for a resource and remember it. */
  buildChallenge(resource: string): PaymentChallenge {
    const challenge: PaymentChallenge = {
      payment_id: `pay-${this.rid()}`,
      amount_motes: this.opts.priceMotes.toString(),
      network: "casper",
      asset: "CSPR",
      resource,
      service_type: this.opts.serviceType,
      seller_agent: this.opts.sellerAgent,
      nonce: `nonce-${this.rid()}`,
      expires_at: this.now() + (this.opts.challengeTtlSec ?? 300),
    };
    this.pending.set(challenge.payment_id, challenge);
    return challenge;
  }

  /** Core decision: given the resource + optional X-Payment header, decide. */
  async decide(resource: string, paymentHeader: string | undefined): Promise<GatewayDecision> {
    if (!paymentHeader) {
      const challenge = this.buildChallenge(resource);
      this.analytics.record(resource, "challenged");
      return {
        kind: "challenge",
        status: 402,
        headers: { ...challengeHeaders(challenge), "Content-Type": "application/json" },
        body: { status: "Payment Required", challenge, how_to_pay: "sign the PaymentAuthorization and retry with header `X-Payment: <base64 proof>`" },
        challenge,
      };
    }
    let proof: PaymentProof;
    try {
      proof = decodePaymentHeader(paymentHeader);
    } catch {
      this.analytics.record(resource, "rejected");
      return { kind: "rejected", status: 400, body: { error: "malformed X-Payment header" } };
    }
    const challenge = this.pending.get(proof.authorization.payment_id);
    if (!challenge) {
      this.analytics.record(resource, "rejected");
      return { kind: "rejected", status: 409, body: { error: "unknown or expired payment_id; request a fresh 402 first" } };
    }
    // Replay protection: nonce + proof hash are single-use.
    const proofHash = paymentProofHash(proof);
    if (this.nonces.seen(challenge.nonce) || this.nonces.seen(proofHash)) {
      this.analytics.record(resource, "rejected");
      return { kind: "rejected", status: 409, body: { error: "payment replay detected" } };
    }
    const check = verifyPayment({ challenge, proof, now: this.now() });
    if (!check.ok) {
      this.analytics.record(resource, "rejected");
      return { kind: "rejected", status: 402, body: { error: `payment rejected: ${check.reason}` } };
    }
    // Consume: one-time challenge + nonce + proof.
    this.pending.delete(challenge.payment_id);
    this.nonces.remember(challenge.nonce);
    this.nonces.remember(proofHash);
    const receipt: ReceiptCommitment = {
      receipt_id: `rcpt-${this.rid()}`,
      payer_agent: proof.authorization.payer_agent,
      seller_agent: challenge.seller_agent,
      service_type: challenge.service_type,
      amount_motes: challenge.amount_motes,
      resource,
      payment_proof_hash: proofHash,
      nonce: challenge.nonce,
      created_at: this.now(),
    };
    this.analytics.record(resource, "paid", BigInt(challenge.amount_motes));
    if (this.opts.onReceipt) await this.opts.onReceipt(receipt);
    return { kind: "paid", payer_agent: receipt.payer_agent, receipt };
  }

  /** Express/Connect adapter: 402 on unpaid, attach `req.cred402` + next() on paid. */
  express() {
    return async (req: any, res: any, next: () => void): Promise<void> => {
      const resource = req.originalUrl ?? req.url ?? "/";
      const header = req.headers?.["x-payment"];
      const d = await this.decide(resource, typeof header === "string" ? header : undefined);
      if (d.kind === "paid") {
        req.cred402 = { receipt: d.receipt, payer: d.payer_agent };
        return next();
      }
      const status = d.kind === "challenge" ? d.status : d.status;
      if (d.kind === "challenge") for (const [k, v] of Object.entries(d.headers)) res.setHeader(k, v);
      res.statusCode = status;
      res.setHeader?.("Content-Type", "application/json");
      res.end(JSON.stringify(d.kind === "challenge" ? d.body : d.body));
    };
  }

  /** Web/Fetch adapter (Next.js route handlers, edge): wrap the protected handler. */
  web(handler: (req: Request, ctx: { receipt: ReceiptCommitment; payer: string }) => Response | Promise<Response>) {
    return async (req: Request): Promise<Response> => {
      const resource = new URL(req.url).pathname + (new URL(req.url).search || "");
      const header = req.headers.get("x-payment") ?? undefined;
      const d = await this.decide(resource, header);
      if (d.kind === "paid") return handler(req, { receipt: d.receipt, payer: d.payer_agent });
      const headers = d.kind === "challenge" ? d.headers : { "Content-Type": "application/json" };
      return new Response(JSON.stringify(d.body), { status: d.status, headers });
    };
  }
}

/** Convenience factory mirroring the documented one-liner. */
export function cred402X402(opts: X402GatewayOptions): X402Gateway {
  return new X402Gateway(opts);
}

export { X402_DOMAIN };

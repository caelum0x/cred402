import { cspr } from "../core/units.js";
import { X402Gateway, type ReceiptCommitment, type GatewayDecision, type NonceStore } from "../x402/gateway.js";
import type { ServiceType } from "../core/types.js";

/** Shared in-memory nonce store so replay protection spans every service. */
class SharedNonceStore implements NonceStore {
  private readonly used = new Set<string>();
  seen(k: string): boolean {
    return this.used.has(k);
  }
  remember(k: string): void {
    this.used.add(k);
  }
}

/**
 * Cred402 x402 Credit-Service Marketplace.
 *
 * Everything Cred402 knows — credit checks, TEE-attested confidential scores, FTSO
 * position health, ML risk scores, underwriting simulations — is exposed as a
 * discoverable catalog of services other agents can BUY per call over x402. A request
 * without payment gets a `402 Payment Required` challenge; the caller signs the
 * PaymentAuthorization, retries with `X-Payment: <proof>`, and receives the result
 * plus a receipt. This is the same pay-per-call shape KeeperHub's marketplace uses
 * (`call_workflow` → 402), built on Cred402's real x402 verifier ({@link X402Gateway},
 * ed25519 over an EIP-712 digest, with nonce + proof replay protection).
 *
 * The loop closes on itself: those x402 receipts ARE Cred402's own machine-to-machine
 * revenue — the exact cash-flow events Cred402 turns into on-chain reputation and
 * credit. A marketplace seller's paid calls make the marketplace seller more
 * creditworthy.
 */

export interface ServiceDef {
  id: string;
  name: string;
  description: string;
  service_type: ServiceType;
  price_cspr: number;
  /** Required parameter names the caller must supply (validated before charging). */
  params: string[];
}

/** The credit services Cred402 sells over x402. */
export const CREDIT_SERVICES: ServiceDef[] = [
  { id: "credit-check", name: "Credit check", description: "Creditworthiness assessment for an agent: score, limit, tier and reason codes.", service_type: "credit.check", price_cspr: 0.005, params: ["agent_id"] },
  { id: "confidential-score", name: "Confidential credit score (TEE)", description: "Flare Confidential Compute score — attested, raw features never revealed.", service_type: "credit.confidential_score", price_cspr: 0.01, params: ["agent_id"] },
  { id: "position-health", name: "FTSO position health", description: "FTSO-priced FXRP position: borrowing power, health factor, deleverage-to-cure.", service_type: "credit.position_health", price_cspr: 0.003, params: ["agent_id"] },
  { id: "risk-score", name: "ML risk score (PD)", description: "Probability-of-default from the risk-engine v2, blended with the rules score.", service_type: "credit.risk_score", price_cspr: 0.008, params: ["agent_id"] },
  { id: "underwrite", name: "Underwriting simulation", description: "What-if credit line + rate for hypothetical agent signals (no registration).", service_type: "credit.underwrite", price_cspr: 0.004, params: ["monthly_revenue_cspr"] },
];

const SERVICE_BY_ID = new Map(CREDIT_SERVICES.map((s) => [s.id, s]));

/** Runs a service's business logic once payment is verified. Injected by the caller. */
export type ServiceRunner = (serviceId: string, params: Record<string, unknown>) => Promise<unknown> | unknown;

export interface ServiceListing extends ServiceDef {
  price_motes: string;
  resource: string;
  calls: number;
  revenue_motes: string;
}

export type MarketplaceCall =
  | { kind: "challenge"; status: 402; headers: Record<string, string>; body: unknown }
  | { kind: "rejected"; status: number; body: { error: string } }
  | { kind: "paid"; status: 200; payer_agent: string; receipt: ReceiptCommitment; result: unknown };

export interface MarketplaceOptions {
  onReceipt?: (r: ReceiptCommitment) => void | Promise<void>;
  /** Bind the signing key to the claimed payer_agent (reject spoofed identities). */
  authenticatePayer?: (payerAgent: string, payerPublicKey: string) => boolean;
  now?: () => number;
  randomId?: () => string;
}

export class CreditServiceMarketplace {
  private readonly gateways = new Map<string, X402Gateway>();
  private readonly nonces = new SharedNonceStore();
  private readonly receipts: ReceiptCommitment[] = [];

  constructor(
    private readonly sellerAgent: string,
    private readonly runner: ServiceRunner,
    private readonly opts: MarketplaceOptions = {},
  ) {}

  private resource(id: string): string {
    return `/x402/services/${id}`;
  }

  private gateway(def: ServiceDef): X402Gateway {
    let g = this.gateways.get(def.id);
    if (!g) {
      g = new X402Gateway({
        serviceType: def.service_type,
        priceMotes: cspr(def.price_cspr),
        sellerAgent: this.sellerAgent,
        nonceStore: this.nonces,
        now: this.opts.now,
        randomId: this.opts.randomId,
        authenticatePayer: this.opts.authenticatePayer,
        onReceipt: async (r) => {
          this.receipts.push(r);
          if (this.opts.onReceipt) await this.opts.onReceipt(r);
        },
      });
      this.gateways.set(def.id, g);
    }
    return g;
  }

  /** Discovery catalog with live per-service call + revenue counters. */
  listings(): ServiceListing[] {
    return CREDIT_SERVICES.map((def) => {
      const rs = this.receipts.filter((r) => r.resource === this.resource(def.id));
      return {
        ...def,
        price_motes: cspr(def.price_cspr).toString(),
        resource: this.resource(def.id),
        calls: rs.length,
        revenue_motes: rs.reduce((s, r) => s + BigInt(r.amount_motes), 0n).toString(),
      };
    });
  }

  /** All settled marketplace receipts (newest last). */
  receiptLog(): ReceiptCommitment[] {
    return [...this.receipts];
  }

  /** Revenue rollup across the marketplace. */
  stats(): { total_calls: number; total_revenue_motes: string; by_service: Record<string, number> } {
    const by_service: Record<string, number> = {};
    for (const r of this.receipts) {
      const id = r.resource.replace("/x402/services/", "");
      by_service[id] = (by_service[id] ?? 0) + 1;
    }
    return {
      total_calls: this.receipts.length,
      total_revenue_motes: this.receipts.reduce((s, r) => s + BigInt(r.amount_motes), 0n).toString(),
      by_service,
    };
  }

  /**
   * Buy a service. With no `X-Payment` header → a 402 challenge. With a valid proof →
   * verify, run the service, and return the result + receipt. Params are validated
   * BEFORE issuing a challenge so a caller is never charged for a malformed request.
   */
  async call(serviceId: string, paymentHeader: string | undefined, params: Record<string, unknown>): Promise<MarketplaceCall> {
    const def = SERVICE_BY_ID.get(serviceId);
    if (!def) return { kind: "rejected", status: 404, body: { error: `unknown service: ${serviceId}` } };
    const missing = def.params.filter((p) => params[p] === undefined || params[p] === null || params[p] === "");
    if (missing.length) return { kind: "rejected", status: 400, body: { error: `missing required params: ${missing.join(", ")}` } };

    const decision: GatewayDecision = await this.gateway(def).decide(this.resource(serviceId), paymentHeader);
    if (decision.kind === "challenge") {
      return { kind: "challenge", status: 402, headers: decision.headers, body: decision.body };
    }
    if (decision.kind === "rejected") {
      return { kind: "rejected", status: decision.status, body: decision.body };
    }
    // Paid + verified → execute the service.
    const result = await this.runner(serviceId, params);
    return { kind: "paid", status: 200, payer_agent: decision.payer_agent, receipt: decision.receipt, result };
  }
}

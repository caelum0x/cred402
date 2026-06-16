import type { Ledger } from "../ledger/ledger.js";
import type { CreditAgent } from "../../agents/credit_agent.js";
import { hashObject, deployHash } from "../core/hash.js";

const CONTRACT = "CreditOffers";

/**
 * Credit pre-approval offers — a real lending workflow distinct from instant
 * underwriting. An underwriter issues a time-bounded offer (terms computed from the
 * live risk policy) that an agent can ACCEPT to open a credit line at the locked
 * terms, or that simply expires. This separates "what credit you qualify for" from
 * "when you draw it", and gives counterparties a quotable, expiring commitment.
 */

export type OfferStatus = "pending" | "accepted" | "declined" | "expired";

export interface CreditOffer {
  offer_id: string;
  agent_id: string;
  max_credit_motes: string;
  interest_rate_bps: number;
  origination_fee_bps: number;
  credit_score: number;
  term_seconds: number; // term of the line once opened
  issued_at: number;
  expires_at: number; // offer acceptance deadline
  status: OfferStatus;
  decided_at?: number;
  rationale: string[];
}

const DEFAULT_OFFER_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days to accept
const DEFAULT_LINE_TERM_SECONDS = 30 * 24 * 60 * 60; // 30-day line

export class CreditOffers {
  private readonly offers = new Map<string, CreditOffer>();

  constructor(
    private readonly ledger: Ledger,
    private readonly credit: CreditAgent,
  ) {}

  /** Issue a pre-approval offer for an agent, with terms from the live underwriter. */
  issue(agentId: string, opts: { ttl_seconds?: number; term_seconds?: number } = {}): CreditOffer | { error: string } {
    const agent = this.ledger.agents.get(agentId);
    if (!agent) return { error: `unknown agent: ${agentId}` };
    const explain = this.credit.explain(agentId);
    if ("error" in explain) return { error: explain.error };
    if (!explain.eligible) return { error: `not eligible for credit: ${explain.ineligible_reason}` };

    const now = this.ledger.clock.now();
    const ttl = Math.max(60, opts.ttl_seconds ?? DEFAULT_OFFER_TTL_SECONDS);
    const decision = explain.decision;
    const origination_fee_bps = this.ledger.governance.get().origination_fee_bps;
    const offer: CreditOffer = {
      offer_id: `offer:${hashObject({ agentId, now, n: this.offers.size }).slice(0, 16)}`,
      agent_id: agentId,
      max_credit_motes: decision.credit_line.toString(),
      interest_rate_bps: decision.interest_rate_bps,
      origination_fee_bps,
      credit_score: decision.credit_score,
      term_seconds: opts.term_seconds ?? DEFAULT_LINE_TERM_SECONDS,
      issued_at: now,
      expires_at: now + ttl,
      status: "pending",
      rationale: [...decision.rationale],
    };
    this.offers.set(offer.offer_id, offer);
    this.ledger.bus.emit("CreditOfferIssued", CONTRACT, deployHash(), {
      offer_id: offer.offer_id,
      agent_id: agentId,
      max_credit: offer.max_credit_motes,
      interest_rate_bps: offer.interest_rate_bps,
      expires_at: offer.expires_at,
    });
    return { ...offer };
  }

  /** Accept a pending, unexpired offer → opens a real credit line at the terms. */
  accept(offerId: string): { offer: CreditOffer; credit_line: unknown } | { error: string } {
    const offer = this.offers.get(offerId);
    if (!offer) return { error: `unknown offer: ${offerId}` };
    const now = this.ledger.clock.now();
    if (offer.status !== "pending") return { error: `offer is ${offer.status}` };
    if (now > offer.expires_at) {
      offer.status = "expired";
      offer.decided_at = now;
      return { error: "offer has expired" };
    }
    const line = this.ledger.pool.open_credit_line({
      agent_id: offer.agent_id,
      max_credit: BigInt(offer.max_credit_motes),
      interest_rate_bps: offer.interest_rate_bps,
      origination_fee_bps: offer.origination_fee_bps,
      term_seconds: offer.term_seconds,
    });
    this.ledger.agents.set_credit_score(offer.agent_id, offer.credit_score);
    offer.status = "accepted";
    offer.decided_at = now;
    this.ledger.bus.emit("CreditOfferAccepted", CONTRACT, deployHash(), {
      offer_id: offer.offer_id,
      agent_id: offer.agent_id,
      max_credit: offer.max_credit_motes,
    });
    return { offer: { ...offer }, credit_line: line };
  }

  /** Decline a pending offer. */
  decline(offerId: string): CreditOffer | { error: string } {
    const offer = this.offers.get(offerId);
    if (!offer) return { error: `unknown offer: ${offerId}` };
    if (offer.status !== "pending") return { error: `offer is ${offer.status}` };
    offer.status = "declined";
    offer.decided_at = this.ledger.clock.now();
    this.ledger.bus.emit("CreditOfferDeclined", CONTRACT, deployHash(), { offer_id: offer.offer_id, agent_id: offer.agent_id });
    return { ...offer };
  }

  get(offerId: string): CreditOffer | undefined {
    const o = this.offers.get(offerId);
    return o ? { ...this.refreshExpiry(o) } : undefined;
  }

  /** List offers, optionally for one agent. Expired offers are reflected lazily. */
  list(agentId?: string): CreditOffer[] {
    return [...this.offers.values()]
      .map((o) => ({ ...this.refreshExpiry(o) }))
      .filter((o) => (agentId ? o.agent_id === agentId : true))
      .sort((a, b) => b.issued_at - a.issued_at);
  }

  private refreshExpiry(o: CreditOffer): CreditOffer {
    if (o.status === "pending" && this.ledger.clock.now() > o.expires_at) {
      o.status = "expired";
      o.decided_at = this.ledger.clock.now();
    }
    return o;
  }
}

import type { Ledger } from "../ledger/ledger.js";
import { loadChainManifest } from "./chain_manifest.js";

/**
 * Protocol explorer — universal search across the canonical ledger.
 *
 * One query box that resolves agents, x402 receipts, RWA assets & evidence,
 * credit lines, disputes, on-chain contracts, and Casper transaction (deploy)
 * hashes from the event log. This is what powers the console Explorer page: paste
 * any id/hash and jump straight to the object — and out to cspr.live when the
 * object (a deployed contract) lives on-chain.
 */

export type ResultKind = "agent" | "receipt" | "evidence" | "asset" | "credit_line" | "dispute" | "contract" | "transaction";

export interface SearchResult {
  kind: ResultKind;
  id: string;
  label: string;
  detail: string;
  /** Absolute cspr.live URL when the result is verifiable on-chain. */
  url?: string;
}

export class ExplorerService {
  constructor(private readonly ledger: Ledger) {}

  search(query: string, limit = 25): SearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: SearchResult[] = [];
    const push = (r: SearchResult) => {
      if (out.length < limit) out.push(r);
    };
    const hit = (...vals: (string | undefined)[]) => vals.some((v) => v?.toLowerCase().includes(q));

    for (const a of this.ledger.agents.list()) {
      if (hit(a.agent_id, a.service_type)) {
        push({ kind: "agent", id: a.agent_id, label: a.agent_id, detail: `${a.service_type} · rep ${a.reputation_score} · score ${a.credit_score}` });
      }
    }
    for (const r of this.ledger.receipts.list()) {
      if (hit(r.receipt_id, r.payer_agent, r.seller_agent, r.result_hash, r.payment_proof_hash)) {
        push({ kind: "receipt", id: r.receipt_id, label: r.receipt_id, detail: `${r.payer_agent} → ${r.seller_agent} · ${r.status}` });
      }
    }
    for (const e of this.ledger.evidence.list()) {
      if (hit(e.evidence_id, e.rwa_id, e.agent_id, e.evidence_hash, e.evidence_type)) {
        push({ kind: "evidence", id: e.evidence_id, label: e.evidence_id, detail: `${e.evidence_type} for ${e.rwa_id} · conf ${e.confidence}${e.verified ? " · verified" : ""}` });
      }
    }
    for (const asset of this.ledger.assets.list()) {
      if (hit(asset.rwa_id, asset.asset_type, asset.issuer, asset.jurisdiction_code)) {
        push({ kind: "asset", id: asset.rwa_id, label: asset.rwa_id, detail: `${asset.asset_type} · ${asset.jurisdiction_code}` });
      }
    }
    for (const l of this.ledger.pool.list()) {
      if (hit(l.agent_id)) {
        push({ kind: "credit_line", id: l.agent_id, label: `credit:${l.agent_id}`, detail: `${l.status} · ${fmt(l.drawn)}/${fmt(l.max_credit)} CSPR` });
      }
    }
    for (const d of this.ledger.disputes.list()) {
      if (hit(d.dispute_id, d.respondent_agent, d.complainant, d.dispute_type)) {
        push({ kind: "dispute", id: d.dispute_id, label: d.dispute_id, detail: `${d.dispute_type} vs ${d.respondent_agent} · ${d.status}` });
      }
    }
    // Real deployed contracts — resolvable on cspr.live by name or hash.
    const manifest = loadChainManifest();
    for (const c of manifest.contracts) {
      if (hit(c.name, c.crate, c.contract_hash)) {
        push({ kind: "contract", id: c.contract_hash, label: c.name, detail: `${manifest.chain} · ${c.status} · ${c.contract_hash.slice(0, 16)}…`, url: c.explorer_url });
      }
    }
    for (const ev of this.ledger.bus.all()) {
      if (hit(ev.deploy_hash)) {
        push({ kind: "transaction", id: ev.deploy_hash, label: ev.deploy_hash.slice(0, 18) + "…", detail: `${ev.name} (${ev.contract}) · seq ${ev.seq}` });
      }
    }
    return out;
  }
}

function fmt(motes: bigint): string {
  return (Number(motes) / 1e9).toFixed(2);
}

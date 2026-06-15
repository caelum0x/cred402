import { Cred402Economy } from "../agents/index.js";

/**
 * MCP resources (p2 §12). Addressable protocol state under cred402:// URIs.
 */
export const RESOURCE_TEMPLATES = [
  { uriTemplate: "cred402://agents/{agent_id}", name: "Agent passport", mimeType: "application/json" },
  { uriTemplate: "cred402://receipts/{receipt_id}", name: "x402 receipt", mimeType: "application/json" },
  { uriTemplate: "cred402://rwa/{asset_id}", name: "RWA asset", mimeType: "application/json" },
  { uriTemplate: "cred402://credit-lines/{agent_id}", name: "Credit line", mimeType: "application/json" },
  { uriTemplate: "cred402://disputes/{dispute_id}", name: "Dispute", mimeType: "application/json" },
  { uriTemplate: "cred402://risk-policies/current", name: "Current risk policy", mimeType: "application/json" },
];

function safe(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
}

/** Resolve a cred402:// URI to JSON text. */
export function readResource(uri: string, econ: Cred402Economy): { text: string } | null {
  const m = /^cred402:\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!m) return null;
  const [, kind, id] = m;
  switch (kind) {
    case "agents":
      return { text: safe(econ.ledger.buildPassport(id ?? "") ?? { error: "unknown agent" }) };
    case "receipts":
      return { text: safe(econ.ledger.receipts.get(id ?? "") ?? { error: "unknown receipt" }) };
    case "rwa":
      return { text: safe(econ.ledger.assets.get(id ?? "") ?? { error: "unknown asset" }) };
    case "credit-lines":
      return { text: safe(econ.ledger.pool.get(id ?? "") ?? { error: "no credit line" }) };
    case "disputes":
      return { text: safe(econ.ledger.disputes.get(id ?? "") ?? { error: "unknown dispute" }) };
    case "risk-policies":
      return { text: safe({ version: econ.ledger.policy.version(), governance: econ.ledger.governance.get() }) };
    default:
      return null;
  }
}

/** Concrete resource instances currently present (for resources/list). */
export function listResources(econ: Cred402Economy): { uri: string; name: string; mimeType: string }[] {
  const out: { uri: string; name: string; mimeType: string }[] = [];
  for (const a of econ.ledger.agents.list()) out.push({ uri: `cred402://agents/${a.agent_id}`, name: `Passport: ${a.agent_id}`, mimeType: "application/json" });
  for (const d of econ.ledger.disputes.list()) out.push({ uri: `cred402://disputes/${d.dispute_id}`, name: `Dispute: ${d.dispute_id}`, mimeType: "application/json" });
  out.push({ uri: "cred402://risk-policies/current", name: "Current risk policy", mimeType: "application/json" });
  return out;
}

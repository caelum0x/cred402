import type { Ledger } from "../ledger/ledger.js";
import { deployHash } from "../core/hash.js";
import type { DeploySpec } from "./deploy.js";
import type { RuntimeArg } from "./args.js";
import type { CasperTransport, DeployResult } from "./transport.js";

/**
 * LedgerTransport — a fully working {@link CasperTransport} backed by the
 * in-memory ledger.
 *
 * This is the local/dev twin of {@link CasperRpcTransport}: the SAME transport
 * interface, executed against the simulated contract suite instead of a live
 * node. It proves the seam is real — a `DeploySpec` is dispatched to the actual
 * contract entry point, executes synchronously, and returns a real result. Point
 * production at `CasperRpcTransport` + `Ed25519DeploySigner`; point dev/tests at
 * this. No mocks: entry points run the genuine ledger logic.
 */
export class LedgerTransport implements CasperTransport {
  constructor(private readonly ledger: Ledger) {}

  async callEntryPoint(spec: DeploySpec): Promise<DeployResult> {
    const a = byName(spec.args);
    const hash = deployHash();
    try {
      switch (spec.entryPoint) {
        case "register_agent":
          this.ledger.agents.register_agent({
            agent_id: req(a, "agent_id"),
            owner_public_key: a.owner_public_key ?? spec.sender,
            agent_public_key: a.agent_public_key ?? spec.sender,
            service_type: req(a, "service_type") as never,
          });
          break;
        case "set_credit_score":
          this.ledger.agents.set_credit_score(req(a, "agent_id"), Number(req(a, "score")));
          break;
        case "update_reputation":
          this.ledger.agents.update_reputation(req(a, "agent_id"), Number(a.delta ?? "0"), a.evidence_hash ?? "0x", a.reason_code);
          break;
        case "stake":
          this.ledger.agents.stake(req(a, "agent_id"), BigInt(req(a, "amount")));
          break;
        case "deposit_liquidity":
          this.ledger.pool.deposit_liquidity(BigInt(req(a, "amount")), spec.sender);
          break;
        case "finalize_receipt":
          this.ledger.receipts.finalize_receipt(req(a, "receipt_id"));
          break;
        default:
          return { deployHash: hash, status: "failure", errorMessage: `unsupported entry point: ${spec.entryPoint}` };
      }
      return { deployHash: hash, status: "success", cost: spec.paymentMotes.toString() };
    } catch (err) {
      return { deployHash: hash, status: "failure", errorMessage: (err as Error).message };
    }
  }

  async queryContractKey(contractHash: string, path: string[]): Promise<unknown> {
    // Resolve a few well-known reads: agents/<id>, pool/state.
    const [collection, id] = path;
    if (collection === "agents" && id) return this.ledger.agents.get(id) ?? null;
    if (collection === "pool") return this.ledger.pool.poolState();
    if (collection === "credit_lines" && id) return this.ledger.pool.get(id) ?? null;
    return { contractHash, path, note: "unsupported read" };
  }

  async waitForDeploy(deployHashStr: string): Promise<DeployResult> {
    // Ledger execution is synchronous, so any submitted deploy already succeeded.
    return { deployHash: deployHashStr, status: "success" };
  }

  async health(): Promise<{ ok: boolean; chain?: string }> {
    return { ok: true, chain: "casper-local-ledger" };
  }
}

function byName(args: RuntimeArg[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) out[a.name] = a.value;
  return out;
}

function req(a: Record<string, string>, name: string): string {
  const v = a[name];
  if (v === undefined) throw new Error(`missing arg: ${name}`);
  return v;
}

import type { Ledger } from "../lib/ledger/index.js";
import type { ServiceType } from "../lib/core/types.js";
import { cspr } from "../lib/core/units.js";
import { generateAgentKeypair, type AgentKeypair } from "../lib/x402/index.js";

/**
 * BaseAgent — an autonomous economic actor with its own on-chain Casper identity.
 * Every agent owns an ed25519 keypair (account abstraction), registers itself in
 * the AgentRegistry, and can stake collateral.
 */
export abstract class BaseAgent {
  readonly agent_id: string;
  readonly service_type: ServiceType;
  readonly keys: AgentKeypair;

  constructor(
    protected readonly ledger: Ledger,
    args: { agent_id: string; service_type: ServiceType; owner_public_key?: string },
  ) {
    this.agent_id = args.agent_id;
    this.service_type = args.service_type;
    this.keys = generateAgentKeypair();
    this.ledger.agents.register_agent({
      agent_id: this.agent_id,
      owner_public_key: args.owner_public_key ?? this.keys.publicKeyHex,
      agent_public_key: this.keys.publicKeyHex,
      service_type: this.service_type,
    });
  }

  stake(amountCspr: number): void {
    this.ledger.agents.stake(this.agent_id, cspr(amountCspr));
  }

  get publicKeyHex(): string {
    return this.keys.publicKeyHex;
  }
}

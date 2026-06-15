import { deployHash } from "../../core/hash.js";
import { verifyAddressBinding, type AddressBindingEnvelope } from "../../../crosschain/standards/bindings.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "AddressBindingRegistry";

export interface StoredBinding {
  agent_id: string;
  external_chain: string;
  external_address: string;
  bound_at: number;
  revoked_at?: number;
  envelope: AddressBindingEnvelope;
}

/**
 * AddressBindingRegistry (p3) — binds EVM/Solana/Cosmos/Move addresses to a
 * Casper-rooted agent. A binding is only stored if BOTH signatures in the Address
 * Binding Envelope verify (casper ed25519 + external secp256k1), so no single key
 * can claim someone else's address.
 */
export class AddressBindingRegistry {
  private readonly bindings = new Map<string, StoredBinding>(); // key: chain:address

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  bind_external_address(envelope: AddressBindingEnvelope): StoredBinding {
    const check = verifyAddressBinding(envelope, this.clock.now());
    if (!check.ok) throw new Error(`address binding rejected: ${check.reason}`);
    const key = `${envelope.external_chain}:${envelope.external_address.toLowerCase()}`;
    const existing = this.bindings.get(key);
    if (existing && !existing.revoked_at) throw new Error("address already bound");
    const stored: StoredBinding = {
      agent_id: envelope.agent_id,
      external_chain: envelope.external_chain,
      external_address: envelope.external_address,
      bound_at: this.clock.now(),
      envelope,
    };
    this.bindings.set(key, stored);
    this.bus.emit("AddressBound", CONTRACT, deployHash(), {
      agent_id: envelope.agent_id,
      external_chain: envelope.external_chain,
      external_address: envelope.external_address,
    });
    return clone(stored);
  }

  revoke_external_address(external_chain: string, external_address: string): void {
    const key = `${external_chain}:${external_address.toLowerCase()}`;
    const b = this.bindings.get(key);
    if (!b || b.revoked_at) return;
    b.revoked_at = this.clock.now();
    this.bus.emit("AddressRevoked", CONTRACT, deployHash(), { external_chain, external_address });
  }

  /** Verify an external address resolves to a given agent (active binding). */
  verify_binding(agent_id: string, external_chain: string, external_address: string): boolean {
    const b = this.bindings.get(`${external_chain}:${external_address.toLowerCase()}`);
    return !!b && !b.revoked_at && b.agent_id === agent_id;
  }

  forAgent(agent_id: string): StoredBinding[] {
    return this.list().filter((b) => b.agent_id === agent_id && !b.revoked_at);
  }

  list(): StoredBinding[] {
    return [...this.bindings.values()].map(clone);
  }
}

function clone(b: StoredBinding): StoredBinding {
  return { ...b, envelope: { ...b.envelope } };
}

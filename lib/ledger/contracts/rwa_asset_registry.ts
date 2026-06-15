import type { AssetStatus, AssetType, RwaAsset } from "../../core/protocol_types.js";
import { deployHash } from "../../core/hash.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "RWAAssetRegistry";

/**
 * RWAAssetRegistry (p2 §6.4) — canonical registry of real-world asset references.
 * Each asset type carries its own risk policy and legal wrapper in production;
 * here we record the identity, issuer, jurisdiction and document hashes.
 */
export class RWAAssetRegistry {
  private readonly assets = new Map<string, RwaAsset>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  register_asset(args: {
    rwa_id: string;
    asset_type: AssetType;
    issuer: string;
    jurisdiction_code: string;
    metadata_hash: string;
    document_bundle_hash: string;
  }): RwaAsset {
    const now = this.clock.now();
    const asset: RwaAsset = {
      ...args,
      status: "active",
      created_at: now,
      updated_at: now,
    };
    this.assets.set(asset.rwa_id, asset);
    this.bus.emit("RwaAssetRegistered", CONTRACT, deployHash(), {
      rwa_id: asset.rwa_id,
      asset_type: asset.asset_type,
      jurisdiction_code: asset.jurisdiction_code,
    });
    return { ...asset };
  }

  set_status(rwa_id: string, status: AssetStatus): void {
    const a = this.assets.get(rwa_id);
    if (!a) return;
    a.status = status;
    a.updated_at = this.clock.now();
  }

  get(rwa_id: string): RwaAsset | undefined {
    const a = this.assets.get(rwa_id);
    return a ? { ...a } : undefined;
  }

  list(): RwaAsset[] {
    return [...this.assets.values()].map((a) => ({ ...a }));
  }
}

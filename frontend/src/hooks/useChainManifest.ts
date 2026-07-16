import { useEffect, useState } from "react";
import { getChainManifest, type ChainManifest } from "../api";

/**
 * useChainManifest — loads the canonical Casper Testnet deployment manifest once.
 * It never changes at runtime, so a single fetch is enough; components use it to
 * link protocol activity to the real cspr.live block explorer.
 */
export function useChainManifest(): ChainManifest | null {
  const [manifest, setManifest] = useState<ChainManifest | null>(null);
  useEffect(() => {
    let alive = true;
    getChainManifest()
      .then((m) => alive && setManifest(m))
      .catch(() => alive && setManifest(null));
    return () => {
      alive = false;
    };
  }, []);
  return manifest;
}

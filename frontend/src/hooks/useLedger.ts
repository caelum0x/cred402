import { useCallback, useEffect, useRef, useState } from "react";
import type { ChainEvent, Snapshot } from "../types";
import { getSnapshot } from "../api";
import { streamUrl } from "../lib/config";

/**
 * useLedger — keeps a live mirror of on-chain state. Subscribes to the SSE event
 * stream and refetches the full snapshot whenever a new chain event arrives, so
 * the dashboard updates in real time as agents act.
 */
export function useLedger() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [liveEvents, setLiveEvents] = useState<ChainEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await getSnapshot());
    } catch {
      /* transient */
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(refresh, 120);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const es = new EventSource(streamUrl("/api/events/stream"));
    es.addEventListener("hello", () => setConnected(true));
    es.addEventListener("chain", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as ChainEvent;
        setLiveEvents((prev) => [data, ...prev].slice(0, 200));
        scheduleRefresh();
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [refresh, scheduleRefresh]);

  return { snapshot, liveEvents, connected, refresh };
}

import type { ChainEvent, EventName } from "../core/types.js";

export type EventListener = (e: ChainEvent) => void;

/**
 * EventBus — Casper streaming-events analogue.
 *
 * Real Casper emits events for deploys, transfers and contract calls that agents
 * (e.g. the WatchdogAgent) subscribe to in real time. Here we keep an append-only
 * log with monotonic sequence numbers and fan out to live subscribers; the API
 * server re-broadcasts these over Server-Sent Events to the dashboard.
 */
export class EventBus {
  private seq = 0;
  private readonly log: ChainEvent[] = [];
  private readonly listeners = new Set<EventListener>();

  emit(name: EventName, contract: string, deploy_hash: string, data: Record<string, unknown>): ChainEvent {
    const event: ChainEvent = {
      seq: ++this.seq,
      name,
      contract,
      deploy_hash,
      timestamp: Math.floor(Date.now() / 1000),
      data,
    };
    this.log.push(event);
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // a faulty subscriber must never break consensus / other listeners
      }
    }
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events after a given sequence number (for SSE catch-up / polling). */
  since(seq: number): ChainEvent[] {
    return this.log.filter((e) => e.seq > seq);
  }

  all(): ChainEvent[] {
    return [...this.log];
  }

  /** Empty the event log (used on demo reset) while keeping subscribers attached
   * and the sequence counter monotonic so client-side keys never collide. */
  clearLog(): void {
    this.log.length = 0;
  }
}

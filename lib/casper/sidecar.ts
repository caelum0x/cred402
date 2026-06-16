/**
 * Casper Sidecar event feed (wires `casper-network/casper-sidecar`).
 *
 * The Sidecar re-emits a node's events as Server-Sent Events at `GET /events`
 * (default port 19999). Cred402's WatchdogAgent and indexer consume protocol
 * activity from this real stream in production — contract-emitted events ride in
 * each `TransactionProcessed` frame's `messages[]`.
 *
 * The in-process `EventBus` remains the default; set `CRED402_SIDECAR_URL` to
 * consume a live Sidecar instead. The SSE frame parser and event decoder are pure
 * and unit-tested with the exact frame shapes from the Sidecar docs; only
 * {@link streamEvents} opens a network connection.
 */

export type SidecarEventKind =
  | "ApiVersion"
  | "BlockAdded"
  | "TransactionProcessed"
  | "TransactionAccepted"
  | "TransactionExpired"
  | "Step"
  | "FinalitySignature"
  | "Fault"
  | "Shutdown"
  | "Unknown";

export interface SidecarEvent {
  id?: string;
  kind: SidecarEventKind;
  data: unknown;
}

/** A contract-emitted message extracted from a TransactionProcessed event. */
export interface ContractMessage {
  entity_addr: string;
  topic_name: string;
  topic_index?: number;
  payload: unknown;
}

const KNOWN_KINDS = new Set<SidecarEventKind>([
  "ApiVersion",
  "BlockAdded",
  "TransactionProcessed",
  "TransactionAccepted",
  "TransactionExpired",
  "Step",
  "FinalitySignature",
  "Fault",
  "Shutdown",
]);

/** Decode one SSE `data:` JSON payload into a typed SidecarEvent. */
export function decodeSidecarData(json: string, id?: string): SidecarEvent {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  // Sidecar events are single-key objects: { "<Kind>": <payload> }.
  const key = Object.keys(parsed)[0];
  const kind: SidecarEventKind = key && KNOWN_KINDS.has(key as SidecarEventKind) ? (key as SidecarEventKind) : "Unknown";
  return { id, kind, data: key ? parsed[key] : parsed };
}

/**
 * Parse complete SSE frames from a text blob. Returns the decoded events and the
 * trailing partial frame (carry it into the next chunk). Keep-alive `:` comment
 * lines are ignored. Faithful to the Sidecar's `data:`/`id:` framing.
 */
export function parseSseFrames(buffer: string): { events: SidecarEvent[]; rest: string } {
  const events: SidecarEvent[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const frame of parts) {
    let data = "";
    let id: string | undefined;
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue; // keep-alive / comment
      const idx = line.indexOf(":");
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
      if (field === "data") data += data ? "\n" + value : value;
      else if (field === "id") id = value;
    }
    if (!data) continue;
    try {
      events.push(decodeSidecarData(data, id));
    } catch {
      // skip malformed frame rather than break the stream
    }
  }
  return { events, rest };
}

/** Pull the contract-emitted messages out of a TransactionProcessed event. */
export function extractContractMessages(event: SidecarEvent): ContractMessage[] {
  if (event.kind !== "TransactionProcessed") return [];
  const msgs = (event.data as { messages?: Array<Record<string, unknown>> }).messages ?? [];
  return msgs.map((m) => ({
    entity_addr: String(m.entity_addr ?? ""),
    topic_name: String(m.topic_name ?? ""),
    topic_index: typeof m.topic_index === "number" ? m.topic_index : undefined,
    payload: m.message,
  }));
}

export interface SidecarClientOptions {
  baseUrl: string; // e.g. http://127.0.0.1:19999
  fetchFn?: typeof fetch;
}

export class CasperSidecarClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: SidecarClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /**
   * Stream live events from the Sidecar's `/events` SSE endpoint. Yields decoded
   * SidecarEvents until `signal` aborts or the stream ends.
   */
  async *streamEvents(signal?: AbortSignal): AsyncGenerator<SidecarEvent> {
    const res = await this.fetchFn(`${this.baseUrl}/events`, {
      headers: { Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`sidecar /events -> HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseFrames(buffer);
      buffer = rest;
      for (const e of events) yield e;
    }
  }

  /** Subscribe with a callback; returns an unsubscribe function. */
  subscribe(handler: (e: SidecarEvent) => void, signal?: AbortSignal): () => void {
    const controller = new AbortController();
    const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    void (async () => {
      try {
        for await (const e of this.streamEvents(merged)) handler(e);
      } catch {
        // stream ended or aborted
      }
    })();
    return () => controller.abort();
  }
}

export function sidecarFromEnv(env: NodeJS.ProcessEnv = process.env): CasperSidecarClient | null {
  const url = env.CRED402_SIDECAR_URL;
  return url ? new CasperSidecarClient({ baseUrl: url }) : null;
}

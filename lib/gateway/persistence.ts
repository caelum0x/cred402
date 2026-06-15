import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ChainEvent } from "../core/types.js";
import type { EventBus } from "../ledger/events.js";

/**
 * Durable persistence (p2 §7.4 — replaces the in-memory-only hackathon shortcut).
 *
 * The event stream is the protocol's system of record. {@link LedgerJournal}
 * subscribes to the in-process {@link EventBus} and appends every emitted event
 * to an append-only NDJSON journal that survives restarts and is exactly what a
 * downstream indexer (Postgres/ClickHouse) would consume. {@link writeSnapshot}
 * atomically persists periodic full snapshots for fast recovery and audit.
 */
export class LedgerJournal {
  private readonly path: string;
  private readonly unsubscribe: () => void;
  private count = 0;

  constructor(dataDir: string, bus: EventBus) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "events.ndjson");
    // Re-journal any events already emitted before we attached.
    for (const e of bus.all()) this.append(e);
    this.unsubscribe = bus.subscribe((e) => this.append(e));
  }

  private append(event: ChainEvent): void {
    appendFileSync(
      this.path,
      JSON.stringify(event, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n",
    );
    this.count++;
  }

  /** Replay the persisted journal (indexer backfill / audit). */
  readAll(): ChainEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChainEvent);
  }

  journaledCount(): number {
    return this.count;
  }

  close(): void {
    this.unsubscribe();
  }
}

/** Atomically write a JSON snapshot (temp file + rename — never a torn file). */
export function writeSnapshot(dataDir: string, snapshot: unknown): string {
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, "snapshot.json");
  const tmp = join(dataDir, `snapshot.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(snapshot, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  renameSync(tmp, target);
  return target;
}

export function readSnapshot(dataDir: string): unknown {
  const target = join(dataDir, "snapshot.json");
  if (!existsSync(target)) return undefined;
  return JSON.parse(readFileSync(target, "utf8"));
}

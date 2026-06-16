# Cred402 event indexer (Go)

Replays the durable NDJSON event journal (`lib/gateway/persistence.ts`, written
when the API runs with `CRED402_DATA_DIR` set) into queryable projections —
agents, credit pool, disputes — with a `seq` checkpoint so re-runs are
incremental and idempotent (p2 §7.4).

The journal is the protocol's **system of record**; this is what a
Postgres/ClickHouse projection layer consumes. The `sink.Sink` interface is the
production seam — `StdoutSink`/`FileSink` ship here; a DB writer implements the
same interface.

## Run

```bash
# produce a journal
CRED402_DATA_DIR=/tmp/cred402data npm start   # in the repo root, then exercise the API

# project it
cd services/event-indexer
go run ./cmd/indexer --journal /tmp/cred402data/events.ndjson            # once → stdout
go run ./cmd/indexer --journal /tmp/cred402data/events.ndjson --out p.json --watch 2s
```

## Layout

```
cmd/indexer          entrypoint (flags: --journal --out --watch)
internal/event       ChainEvent model + NDJSON decoder
internal/projections deterministic fold: agents, pool, disputes (+ checkpoint)
internal/sink        Sink interface; Stdout + File (Postgres = same interface)
```

`go build ./...` and `go vet ./...` are clean.

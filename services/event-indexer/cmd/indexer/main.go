// Command indexer replays the Cred402 durable event journal (NDJSON) into
// queryable projections (p2 §7.4). It consumes exactly what
// lib/gateway/persistence.ts writes, maintains a seq checkpoint, and can either
// run once or watch the journal for new events.
//
//	go run ./cmd/indexer --journal /path/to/events.ndjson
//	go run ./cmd/indexer --journal events.ndjson --out projections.json --watch 2s
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/cred402/event-indexer/internal/event"
	"github.com/cred402/event-indexer/internal/projections"
	"github.com/cred402/event-indexer/internal/sink"
)

func main() {
	journalPath := flag.String("journal", "", "path to the NDJSON event journal (required)")
	outPath := flag.String("out", "", "write projections JSON to this file (default: stdout)")
	watch := flag.Duration("watch", 0, "poll the journal at this interval (e.g. 2s); 0 = run once")
	flag.Parse()

	if *journalPath == "" {
		fmt.Fprintln(os.Stderr, "error: --journal is required")
		flag.Usage()
		os.Exit(2)
	}

	var out sink.Sink = sink.StdoutSink{}
	if *outPath != "" {
		out = sink.FileSink{Path: *outPath}
	}

	store := projections.NewStore()

	run := func() error {
		f, err := os.Open(*journalPath)
		if err != nil {
			return err
		}
		defer f.Close()
		events, err := event.DecodeJournal(f)
		if err != nil {
			return err
		}
		// Replay only events beyond the current checkpoint (incremental + idempotent).
		store.ApplyAll(events, store.LastSeq)
		return out.Write(store)
	}

	if *watch == 0 {
		if err := run(); err != nil {
			log.Fatalf("indexer: %v", err)
		}
		return
	}

	log.Printf("indexer watching %s every %s", *journalPath, *watch)
	ticker := time.NewTicker(*watch)
	defer ticker.Stop()
	for {
		if err := run(); err != nil {
			log.Printf("indexer: %v", err)
		}
		<-ticker.C
	}
}

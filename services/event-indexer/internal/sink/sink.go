// Package sink persists projections. The Sink interface is what a Postgres /
// ClickHouse writer implements in production; here we ship Stdout and File sinks
// so the indexer is fully runnable without a database.
package sink

import (
	"encoding/json"
	"io"
	"os"

	"github.com/cred402/event-indexer/internal/projections"
)

type Sink interface {
	Write(store *projections.Store) error
}

// StdoutSink pretty-prints the projection set.
type StdoutSink struct{ W io.Writer }

func (s StdoutSink) Write(store *projections.Store) error {
	w := s.W
	if w == nil {
		w = os.Stdout
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(view(store))
}

// FileSink writes the projection set to a JSON file atomically.
type FileSink struct{ Path string }

func (s FileSink) Write(store *projections.Store) error {
	tmp := s.Path + ".tmp"
	b, err := json.MarshalIndent(view(store), "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.Path)
}

// view is the JSON-serializable projection (sorted agents + pool + checkpoint).
func view(store *projections.Store) map[string]any {
	return map[string]any{
		"checkpoint":      store.LastSeq,
		"events_applied":  store.EventsApplied,
		"disputes_opened": store.Disputes,
		"pool":            store.Pool,
		"agents":          store.SortedAgents(),
	}
}

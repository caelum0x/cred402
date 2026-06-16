// Package event models the Cred402 protocol event as written to the durable
// NDJSON journal (lib/gateway/persistence.ts). The journal is the system of
// record; the indexer replays it to build queryable projections.
package event

import (
	"bufio"
	"encoding/json"
	"io"
	"math/big"
)

// ChainEvent mirrors the TypeScript ChainEvent emitted by the EventBus.
type ChainEvent struct {
	Seq        int64          `json:"seq"`
	Name       string         `json:"name"`
	Contract   string         `json:"contract"`
	DeployHash string         `json:"deploy_hash"`
	Timestamp  int64          `json:"timestamp"`
	Data       map[string]any `json:"data"`
}

// Str returns a string field from the event data, or "" if absent.
func (e ChainEvent) Str(key string) string {
	if v, ok := e.Data[key].(string); ok {
		return v
	}
	return ""
}

// Amount parses a stringified integer field (motes / smallest units) as big.Int.
func (e ChainEvent) Amount(key string) *big.Int {
	n := new(big.Int)
	if s, ok := e.Data[key].(string); ok {
		n.SetString(s, 10)
	}
	return n
}

// Num returns a numeric field as int64 (JSON numbers decode to float64).
func (e ChainEvent) Num(key string) int64 {
	if f, ok := e.Data[key].(float64); ok {
		return int64(f)
	}
	return 0
}

// DecodeJournal streams a newline-delimited JSON journal into events.
func DecodeJournal(r io.Reader) ([]ChainEvent, error) {
	var events []ChainEvent
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var e ChainEvent
		if err := json.Unmarshal(line, &e); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, sc.Err()
}

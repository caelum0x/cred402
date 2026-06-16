// Package projections folds the Cred402 event stream into queryable read models
// (agents, pool, disputes) — exactly what a Postgres/ClickHouse projection layer
// would maintain. Pure, deterministic, replay-safe: applying the same journal
// always yields the same state, and the checkpoint is the last applied seq.
package projections

import (
	"math/big"
	"sort"

	"github.com/cred402/event-indexer/internal/event"
)

// AgentProjection is the per-agent read model.
type AgentProjection struct {
	AgentID        string   `json:"agent_id"`
	ServiceType    string   `json:"service_type"`
	Receipts       int      `json:"receipts"`
	FinalizedRcpts int      `json:"finalized_receipts"`
	Revenue        *big.Int `json:"-"`
	RevenueStr     string   `json:"revenue"`
	Reputation     int64    `json:"reputation"`
	CreditMax      *big.Int `json:"-"`
	CreditMaxStr   string   `json:"credit_max"`
	Drawn          *big.Int `json:"-"`
	DrawnStr       string   `json:"drawn"`
	FiatReceipts   int      `json:"fiat_receipts"`
}

// PoolProjection is the credit-pool read model.
type PoolProjection struct {
	Liquidity       *big.Int `json:"-"`
	LiquidityStr    string   `json:"total_liquidity"`
	Outstanding     *big.Int `json:"-"`
	OutstandingStr  string   `json:"outstanding_credit"`
	InterestToPool  *big.Int `json:"-"`
	InterestStr     string   `json:"interest_accrued"`
	OpenCreditLines int      `json:"open_credit_lines"`
}

// Store is the in-memory projection set; a real sink persists these to a DB.
type Store struct {
	Agents        map[string]*AgentProjection `json:"agents"`
	Pool          *PoolProjection             `json:"pool"`
	Disputes      int                         `json:"disputes_opened"`
	LastSeq       int64                       `json:"last_seq"`
	EventsApplied int                         `json:"events_applied"`
}

func NewStore() *Store {
	return &Store{
		Agents: map[string]*AgentProjection{},
		Pool:   &PoolProjection{Liquidity: new(big.Int), Outstanding: new(big.Int), InterestToPool: new(big.Int)},
	}
}

func (s *Store) agent(id string) *AgentProjection {
	a, ok := s.Agents[id]
	if !ok {
		a = &AgentProjection{AgentID: id, Revenue: new(big.Int), CreditMax: new(big.Int), Drawn: new(big.Int)}
		s.Agents[id] = a
	}
	return a
}

// Apply folds a single event into the projections.
func (s *Store) Apply(e event.ChainEvent) {
	switch e.Name {
	case "AgentRegistered":
		s.agent(e.Str("agent_id")).ServiceType = e.Str("service_type")
	case "ReceiptRecorded":
		a := s.agent(e.Str("seller_agent"))
		a.Receipts++
		a.Revenue.Add(a.Revenue, e.Amount("amount"))
	case "ReceiptFinalized":
		// finalized receipts are counted via FinalizeReceipt's own seller lookup;
		// here we approximate from the running total when seller is present.
		if seller := e.Str("seller_agent"); seller != "" {
			s.agent(seller).FinalizedRcpts++
		}
	case "ReputationUpdated":
		s.agent(e.Str("agent_id")).Reputation = e.Num("current")
	case "FiatReceiptRecorded":
		s.agent(e.Str("seller_agent")).FiatReceipts++
	case "LiquidityDeposited":
		if t := e.Amount("total_liquidity"); t.Sign() > 0 {
			s.Pool.Liquidity.Set(t)
		} else {
			s.Pool.Liquidity.Add(s.Pool.Liquidity, e.Amount("amount"))
		}
	case "CreditLineOpened":
		a := s.agent(e.Str("agent_id"))
		a.CreditMax.Set(e.Amount("max_credit"))
		s.Pool.OpenCreditLines++
	case "CreditDrawn":
		a := s.agent(e.Str("agent_id"))
		a.Drawn.Add(a.Drawn, e.Amount("amount"))
		s.Pool.Outstanding.Add(s.Pool.Outstanding, e.Amount("amount"))
	case "CreditRepaid":
		a := s.agent(e.Str("agent_id"))
		a.Drawn.Sub(a.Drawn, e.Amount("principal"))
		if a.Drawn.Sign() < 0 {
			a.Drawn.SetInt64(0)
		}
		s.Pool.Outstanding.Sub(s.Pool.Outstanding, e.Amount("principal"))
		if s.Pool.Outstanding.Sign() < 0 {
			s.Pool.Outstanding.SetInt64(0)
		}
		s.Pool.InterestToPool.Add(s.Pool.InterestToPool, e.Amount("interest"))
	case "DisputeOpened":
		s.Disputes++
	}
	s.LastSeq = e.Seq
	s.EventsApplied++
}

// ApplyAll replays a batch of events from a checkpoint (seq > after).
func (s *Store) ApplyAll(events []event.ChainEvent, after int64) {
	for _, e := range events {
		if e.Seq <= after {
			continue
		}
		s.Apply(e)
	}
	s.finalizeStrings()
}

// finalizeStrings renders big.Int values into JSON-safe strings.
func (s *Store) finalizeStrings() {
	for _, a := range s.Agents {
		a.RevenueStr = a.Revenue.String()
		a.CreditMaxStr = a.CreditMax.String()
		a.DrawnStr = a.Drawn.String()
	}
	s.Pool.LiquidityStr = s.Pool.Liquidity.String()
	s.Pool.OutstandingStr = s.Pool.Outstanding.String()
	s.Pool.InterestStr = s.Pool.InterestToPool.String()
}

// SortedAgents returns agents ordered by id for stable output.
func (s *Store) SortedAgents() []*AgentProjection {
	out := make([]*AgentProjection, 0, len(s.Agents))
	for _, a := range s.Agents {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AgentID < out[j].AgentID })
	return out
}

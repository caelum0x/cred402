package cred402

import (
	"encoding/json"
	"fmt"
	"math/big"
)

// motesPerCSPR is the number of motes in one CSPR (1 CSPR = 1e9 motes).
const motesPerCSPR = 1_000_000_000

// Motes is an integer amount of Casper motes. The Cred402 API encodes mote
// amounts as decimal strings (e.g. "50000000000") to avoid float precision
// loss, so Motes marshals to and from a JSON string backed by math/big.Int.
type Motes struct {
	Int *big.Int
}

// NewMotes wraps an existing big.Int (nil becomes zero).
func NewMotes(v *big.Int) Motes {
	if v == nil {
		return Motes{Int: big.NewInt(0)}
	}
	return Motes{Int: new(big.Int).Set(v)}
}

// MotesFromString parses a decimal mote string.
func MotesFromString(s string) (Motes, error) {
	if s == "" {
		return Motes{Int: big.NewInt(0)}, nil
	}
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return Motes{}, fmt.Errorf("cred402: %q is not a valid mote amount", s)
	}
	return Motes{Int: n}, nil
}

// UnmarshalJSON accepts either a JSON string ("123") or a JSON number (123).
func (m *Motes) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		m.Int = big.NewInt(0)
		return nil
	}
	// Strip surrounding quotes if the value is a JSON string.
	s := string(data)
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		s = s[1 : len(s)-1]
	}
	if s == "" {
		m.Int = big.NewInt(0)
		return nil
	}
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return fmt.Errorf("cred402: cannot parse %q as motes", s)
	}
	m.Int = n
	return nil
}

// MarshalJSON encodes the amount as a decimal string, matching the API.
func (m Motes) MarshalJSON() ([]byte, error) {
	if m.Int == nil {
		return []byte(`"0"`), nil
	}
	return []byte(`"` + m.Int.String() + `"`), nil
}

// String returns the raw decimal mote value.
func (m Motes) String() string {
	if m.Int == nil {
		return "0"
	}
	return m.Int.String()
}

// CSPR returns the amount expressed in whole CSPR as a float64. This is a
// display convenience; it may lose precision for very large amounts.
func (m Motes) CSPR() float64 {
	if m.Int == nil {
		return 0
	}
	f := new(big.Float).SetInt(m.Int)
	f.Quo(f, big.NewFloat(motesPerCSPR))
	out, _ := f.Float64()
	return out
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

// Receipt is a single x402 revenue receipt in an agent's history.
type Receipt struct {
	ReceiptID   string `json:"receipt_id"`
	Amount      Motes  `json:"amount"`
	Timestamp   int64  `json:"timestamp"`
	ServiceType string `json:"service_type"`
}

// Agent is the on-ledger record for a registered agent.
type Agent struct {
	AgentID            string    `json:"agent_id"`
	OwnerPublicKey     string    `json:"owner_public_key"`
	AgentPublicKey     string    `json:"agent_public_key"`
	ServiceType        string    `json:"service_type"`
	Stake              Motes     `json:"stake"`
	TotalJobsCompleted int64     `json:"total_jobs_completed"`
	X402RevenueHistory []Receipt `json:"x402_revenue_history"`
	AccuracyScore      float64   `json:"accuracy_score"`
	DisputeRate        float64   `json:"dispute_rate"`
	ReputationScore    float64   `json:"reputation_score"`
	CreditScore        float64   `json:"credit_score"`
	Active             bool      `json:"active"`
	RegisteredAt       int64     `json:"registered_at"`
}

// Passport is the derived public credit passport for an agent, returned by the
// passport endpoint and by agent registration.
type Passport struct {
	AgentID         string   `json:"agent_id"`
	ServiceType     string   `json:"service_type"`
	Operator        string   `json:"operator"`
	Stake           Motes    `json:"stake"`
	ReputationScore float64  `json:"reputation_score"`
	CreditScore     float64  `json:"credit_score"`
	CreditLimit     Motes    `json:"credit_limit"`
	OutstandingDebt Motes    `json:"outstanding_debt"`
	TotalReceipts   int64    `json:"total_receipts"`
	TotalRevenue    Motes    `json:"total_revenue"`
	DisputeRate     float64  `json:"dispute_rate"`
	Capabilities    []string `json:"capabilities"`
	SpendingLimit   Motes    `json:"spending_limit"`
	LastActiveAt    int64    `json:"last_active_at"`
	RiskFlags       []string `json:"risk_flags"`
}

// ---------------------------------------------------------------------------
// Credit
// ---------------------------------------------------------------------------

// CreditLine is an underwritten credit line for an agent.
type CreditLine struct {
	AgentID         string `json:"agent_id"`
	MaxCredit       Motes  `json:"max_credit"`
	Drawn           Motes  `json:"drawn"`
	InterestRateBps int    `json:"interest_rate_bps"`
	OriginationBps  int    `json:"origination_fee_bps"`
	HealthFactorBps int    `json:"health_factor_bps"`
	OpenedAt        int64  `json:"opened_at"`
	DueTimestamp    int64  `json:"due_timestamp"`
	Status          string `json:"status"`
}

// ReasonCode is a single explainability factor in an underwriting decision.
type ReasonCode struct {
	Code     string `json:"code"`
	Polarity string `json:"polarity"`
	Detail   string `json:"detail"`
}

// CreditDecision is the underwriting decision for a credit line.
type CreditDecision struct {
	PolicyVersion      string       `json:"policy_version"`
	Last30DayRevenue   Motes        `json:"last_30_day_revenue"`
	BaseLimit          Motes        `json:"base_limit"`
	StakeMultiplier    float64      `json:"stake_multiplier"`
	DisputePenalty     float64      `json:"dispute_penalty"`
	AccuracyMultiplier float64      `json:"accuracy_multiplier"`
	CreditLine         Motes        `json:"credit_line"`
	InterestRateBps    int          `json:"interest_rate_bps"`
	CreditScore        float64      `json:"credit_score"`
	Rationale          []string     `json:"rationale"`
	ReasonCodes        []ReasonCode `json:"reason_codes"`
}

// CreditExplanation is the full credit-explain response for an agent.
type CreditExplanation struct {
	Decision         CreditDecision `json:"decision"`
	FraudScore       float64        `json:"fraud_score"`
	RealfiMultiplier float64        `json:"realfi_multiplier"`
	Eligible         bool           `json:"eligible"`
}

// CreditLineResult is the response from opening a credit line.
type CreditLineResult struct {
	Decision CreditDecision `json:"decision"`
	Line     CreditLine     `json:"line"`
}

// RepayResult is the response from a repayment.
type RepayResult struct {
	Line     CreditLine `json:"line"`
	Interest Motes      `json:"interest"`
}

// CreditPool is the aggregate state of the shared credit pool.
type CreditPool struct {
	TotalLiquidity    Motes        `json:"total_liquidity"`
	OutstandingCredit Motes        `json:"outstanding_credit"`
	InterestAccrued   Motes        `json:"interest_accrued"`
	Defaults          int          `json:"defaults"`
	CreditLines       []CreditLine `json:"creditLines"`
}

// ---------------------------------------------------------------------------
// Marketplace & economics
// ---------------------------------------------------------------------------

// MarketListing is a single service listing in the marketplace.
type MarketListing struct {
	ListingID       string   `json:"listing_id"`
	AgentID         string   `json:"agent_id"`
	Category        string   `json:"category"`
	Strategy        string   `json:"strategy"`
	BasePrice       Motes    `json:"base_price"`
	MinPayment      Motes    `json:"min_payment"`
	MarginBps       int      `json:"margin_bps"`
	PeriodSeconds   int64    `json:"period_seconds"`
	ReputationScore float64  `json:"reputation_score"`
	DisputeRate     float64  `json:"dispute_rate"`
	ReceiptCount    int      `json:"receipt_count"`
	Stake           Motes    `json:"stake"`
	SupportedChains []string `json:"supported_chains"`
}

// EconomicsFees describes the protocol fee schedule.
type EconomicsFees struct {
	FacilitatorFeeBps int `json:"facilitator_fee_bps"`
	OriginationFeeBps int `json:"origination_fee_bps"`
	InterestSpreadBps int `json:"interest_spread_bps"`
	LateFeeBps        int `json:"late_fee_bps"`
}

// EconomicsHealth describes pool health metrics.
type EconomicsHealth struct {
	Utilization   float64  `json:"utilization"`
	RealizedAPY   float64  `json:"realized_apy"`
	RealizedYield Motes    `json:"realized_yield"`
	LossRate      float64  `json:"loss_rate"`
	RiskFlags     []string `json:"risk_flags"`
}

// EconomicsView is the protocol economics snapshot.
type EconomicsView struct {
	Fees   EconomicsFees   `json:"fees"`
	Health EconomicsHealth `json:"health"`
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

// ComplianceCheck is a single screening check.
type ComplianceCheck struct {
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
	Detail string `json:"detail"`
}

// ComplianceScreen is the sanctions/KYB screen for a subject.
type ComplianceScreen struct {
	Subject string            `json:"subject"`
	Cleared bool              `json:"cleared"`
	Checks  []ComplianceCheck `json:"checks"`
}

// RetentionPolicy describes data-retention rules for a data class.
type RetentionPolicy struct {
	DataClass     string `json:"dataClass"`
	RetentionDays int    `json:"retentionDays"`
	ContainsPii   bool   `json:"containsPii"`
	Notes         string `json:"notes"`
}

// ComplianceResult is the full compliance response for an agent.
type ComplianceResult struct {
	Screen    ComplianceScreen  `json:"screen"`
	Retention []RetentionPolicy `json:"retention"`
}

// ---------------------------------------------------------------------------
// RealFi
// ---------------------------------------------------------------------------

// OperatorRecord is a stored operator verification record.
type OperatorRecord struct {
	OperatorID        string `json:"operator_id"`
	Provider          string `json:"provider"`
	VerificationLevel string `json:"verification_level"`
	Jurisdiction      string `json:"jurisdiction"`
	Status            string `json:"status"`
	AttestationHash   string `json:"attestation_hash"`
	VerifiedAt        int64  `json:"verified_at"`
	ExpiresAt         int64  `json:"expires_at"`
}

// OperatorEnvelope is the signed verification envelope.
type OperatorEnvelope struct {
	Type                string `json:"type"`
	Version             string `json:"version"`
	OperatorID          string `json:"operator_id"`
	Provider            string `json:"provider"`
	VerificationLevel   string `json:"verification_level"`
	Jurisdiction        string `json:"jurisdiction"`
	VerificationStatus  string `json:"verification_status"`
	VerificationRefHash string `json:"verification_reference_hash"`
	VerifiedAt          int64  `json:"verified_at"`
	ExpiresAt           int64  `json:"expires_at"`
}

// OperatorVerification is the response from verifying an operator.
type OperatorVerification struct {
	AttestationHash string           `json:"attestation_hash"`
	Envelope        OperatorEnvelope `json:"envelope"`
	Record          OperatorRecord   `json:"record"`
}

// FiatReceipt is a recorded off-chain fiat receipt.
type FiatReceipt struct {
	SellerAgent     string `json:"seller_agent"`
	OperatorID      string `json:"operator_id"`
	Amount          string `json:"amount"`
	Currency        string `json:"currency"`
	ServiceType     string `json:"service_type"`
	ProviderEventID string `json:"provider_event_id"`
}

// FiatReceiptResult is the (free-form) response from recording a fiat receipt.
// The server returns an attestation envelope whose exact shape varies, so it is
// surfaced as a decoded JSON object the caller can inspect.
type FiatReceiptResult map[string]json.RawMessage

// RealfiState is the aggregate RealFi state snapshot.
type RealfiState struct {
	FiatReceipts          []json.RawMessage `json:"fiatReceipts"`
	OperatorVerifications []json.RawMessage `json:"operatorVerifications"`
	Attestations          []json.RawMessage `json:"attestations"`
}

// ---------------------------------------------------------------------------
// Disputes, admin, webhooks
// ---------------------------------------------------------------------------

// Dispute is an opened dispute record. The server returns a free-form record,
// so it is surfaced as a decoded JSON object.
type Dispute map[string]json.RawMessage

// APIKey is a newly issued API key.
type APIKey map[string]json.RawMessage

// Webhook is a webhook subscription record.
type Webhook map[string]json.RawMessage

// ---------------------------------------------------------------------------
// Health & demo
// ---------------------------------------------------------------------------

// Health is the /v1/health response.
type Health struct {
	OK     bool   `json:"ok"`
	Env    string `json:"env"`
	Policy string `json:"policy"`
}

// DemoScene is a single scene in the demo narrative.
type DemoScene struct {
	Scene string   `json:"scene"`
	Lines []string `json:"lines"`
}

// DemoResult is the response from running the demo flow.
type DemoResult struct {
	Scenes []DemoScene `json:"scenes"`
}

// Package cred402 is a Go SDK for the Cred402 protocol: credit lines for
// autonomous RWA agents on Casper. It wraps both the versioned /v1 gateway
// (envelope responses, scoped API keys, idempotency) and the raw /api console
// routes in typed methods.
package cred402

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the local Cred402 API address.
const DefaultBaseURL = "http://localhost:4021"

// Client is a Cred402 API client. The zero value is not usable; construct one
// with New.
type Client struct {
	// BaseURL is the API root (no trailing slash), e.g. http://localhost:4021.
	BaseURL string
	// APIKey is sent as a Bearer token when non-empty.
	APIKey string
	// HTTPClient performs the requests. Never nil after New.
	HTTPClient *http.Client
	// UserAgent is sent on every request.
	UserAgent string
}

// Option configures a Client.
type Option func(*Client)

// WithHTTPClient overrides the default *http.Client.
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) {
		if h != nil {
			c.HTTPClient = h
		}
	}
}

// WithAPIKey sets the bearer API key.
func WithAPIKey(key string) Option {
	return func(c *Client) { c.APIKey = key }
}

// New constructs a Client. An empty baseURL falls back to DefaultBaseURL.
func New(baseURL string, opts ...Option) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	c := &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
		UserAgent:  "cred402-go-sdk/1.0",
	}
	for _, o := range opts {
		o(c)
	}
	if c.HTTPClient == nil {
		c.HTTPClient = &http.Client{Timeout: 30 * time.Second}
	}
	return c
}

// envelope is the /v1 response wrapper.
type envelope struct {
	Success   bool            `json:"success"`
	Data      json.RawMessage `json:"data"`
	Error     *envelopeError  `json:"error"`
	RequestID string          `json:"request_id"`
}

type envelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// do performs an HTTP request and decodes the response into out. It transparently
// unwraps the /v1 envelope when present and decodes raw /api responses directly.
// idempotencyKey, when non-empty, is sent as the Idempotency-Key header (only
// meaningful for mutations). A typed *APIError is returned on any failure.
func (c *Client) do(ctx context.Context, method, path string, body any, idempotencyKey string, out any) error {
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return &APIError{Message: fmt.Sprintf("encoding request body: %v", err)}
		}
		reqBody = bytes.NewReader(buf)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reqBody)
	if err != nil {
		return &APIError{Message: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return &APIError{Message: fmt.Sprintf("request failed: %v", err)}
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return &APIError{StatusCode: resp.StatusCode, Message: fmt.Sprintf("reading response: %v", err)}
	}
	reqID := resp.Header.Get("X-Request-Id")

	// Attempt to interpret the body as a /v1 envelope. We only treat it as one
	// when it actually has the "success" field, so raw /api payloads (which may
	// themselves be objects or arrays) are passed straight through.
	if looksLikeEnvelope(raw) {
		var env envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			return &APIError{StatusCode: resp.StatusCode, RequestID: reqID, Message: fmt.Sprintf("decoding envelope: %v", err)}
		}
		if env.RequestID != "" {
			reqID = env.RequestID
		}
		if !env.Success || resp.StatusCode < 200 || resp.StatusCode >= 300 {
			apiErr := &APIError{StatusCode: resp.StatusCode, RequestID: reqID, Message: http.StatusText(resp.StatusCode)}
			if env.Error != nil {
				apiErr.Code = env.Error.Code
				apiErr.Message = env.Error.Message
			}
			return apiErr
		}
		if out != nil && len(env.Data) > 0 {
			if err := json.Unmarshal(env.Data, out); err != nil {
				return &APIError{StatusCode: resp.StatusCode, RequestID: reqID, Message: fmt.Sprintf("decoding data: %v", err)}
			}
		}
		return nil
	}

	// Raw /api path.
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{StatusCode: resp.StatusCode, RequestID: reqID, Message: rawErrorMessage(raw, resp.StatusCode)}
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return &APIError{StatusCode: resp.StatusCode, RequestID: reqID, Message: fmt.Sprintf("decoding response: %v", err)}
		}
	}
	return nil
}

// looksLikeEnvelope reports whether raw is a JSON object carrying a top-level
// "success" key, the marker of the /v1 gateway envelope.
func looksLikeEnvelope(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false
	}
	var probe struct {
		Success *bool `json:"success"`
	}
	if err := json.Unmarshal(trimmed, &probe); err != nil {
		return false
	}
	return probe.Success != nil
}

func rawErrorMessage(raw []byte, status int) string {
	msg := strings.TrimSpace(string(raw))
	if msg == "" {
		return http.StatusText(status)
	}
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

// Health returns the gateway health/policy status.
func (c *Client) Health(ctx context.Context) (*Health, error) {
	var out Health
	if err := c.do(ctx, http.MethodGet, "/v1/health", nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

// ListAgents returns all registered agents.
func (c *Client) ListAgents(ctx context.Context) ([]Agent, error) {
	var out []Agent
	if err := c.do(ctx, http.MethodGet, "/v1/agents", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetAgent returns a single agent by id.
func (c *Client) GetAgent(ctx context.Context, agentID string) (*Agent, error) {
	var out Agent
	if err := c.do(ctx, http.MethodGet, "/v1/agents/"+pathEscape(agentID), nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetPassport returns the derived credit passport for an agent.
func (c *Client) GetPassport(ctx context.Context, agentID string) (*Passport, error) {
	var out Passport
	if err := c.do(ctx, http.MethodGet, "/v1/agents/"+pathEscape(agentID)+"/passport", nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetCreditLine returns the active credit line for an agent.
func (c *Client) GetCreditLine(ctx context.Context, agentID string) (*CreditLine, error) {
	var out CreditLine
	if err := c.do(ctx, http.MethodGet, "/v1/agents/"+pathEscape(agentID)+"/credit-line", nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RegisterAgentInput is the payload for RegisterAgent.
type RegisterAgentInput struct {
	AgentID        string `json:"agent_id"`
	ServiceType    string `json:"service_type"`
	AgentPublicKey string `json:"agent_public_key,omitempty"`
	OwnerPublicKey string `json:"owner_public_key,omitempty"`
}

// RegisterAgent registers a new agent and returns its passport. Pass an
// idempotencyKey (may be empty) to make the mutation safely retryable.
func (c *Client) RegisterAgent(ctx context.Context, in RegisterAgentInput, idempotencyKey string) (*Passport, error) {
	var out Passport
	if err := c.do(ctx, http.MethodPost, "/v1/agents", in, idempotencyKey, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---------------------------------------------------------------------------
// Credit
// ---------------------------------------------------------------------------

// CreditPool returns the aggregate credit pool state.
func (c *Client) CreditPool(ctx context.Context) (*CreditPool, error) {
	var out CreditPool
	if err := c.do(ctx, http.MethodGet, "/v1/credit/pool", nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ExplainCredit returns the underwriting explanation for an agent.
func (c *Client) ExplainCredit(ctx context.Context, agentID string) (*CreditExplanation, error) {
	var out CreditExplanation
	if err := c.do(ctx, http.MethodGet, "/v1/agents/"+pathEscape(agentID)+"/credit-explain", nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// OpenCreditLine underwrites and opens a credit line for an agent. termDays of
// 0 lets the protocol choose the default term.
func (c *Client) OpenCreditLine(ctx context.Context, agentID string, termDays int, idempotencyKey string) (*CreditLineResult, error) {
	body := map[string]any{"agent_id": agentID}
	if termDays > 0 {
		body["term_days"] = termDays
	}
	var out CreditLineResult
	if err := c.do(ctx, http.MethodPost, "/v1/credit/lines", body, idempotencyKey, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DrawCredit draws amountCSPR (in whole CSPR) against an agent's credit line and
// returns the updated line.
func (c *Client) DrawCredit(ctx context.Context, lineID string, amountCSPR float64, idempotencyKey string) (*CreditLine, error) {
	body := map[string]any{"amount_cspr": amountCSPR}
	var out CreditLine
	if err := c.do(ctx, http.MethodPost, "/v1/credit/lines/"+pathEscape(lineID)+"/draw", body, idempotencyKey, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RepayCredit repays amountCSPR (in whole CSPR) against an agent's credit line.
func (c *Client) RepayCredit(ctx context.Context, lineID string, amountCSPR float64, idempotencyKey string) (*RepayResult, error) {
	body := map[string]any{"amount_cspr": amountCSPR}
	var out RepayResult
	if err := c.do(ctx, http.MethodPost, "/v1/credit/lines/"+pathEscape(lineID)+"/repay", body, idempotencyKey, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---------------------------------------------------------------------------
// Bureau analytics: discovery, trust, portfolio, benchmark, history, simulate, offers
// ---------------------------------------------------------------------------

// DiscoveryQuery filters the agent discovery ranking. Zero-valued fields are omitted.
type DiscoveryQuery struct {
	ServiceType   string
	MinReputation int
	MinScore      int
	Limit         int
}

// Discover ranks agents by the composite discovery score (GET /v1/discovery).
func (c *Client) Discover(ctx context.Context, q DiscoveryQuery) (map[string]any, error) {
	vals := url.Values{}
	if q.ServiceType != "" {
		vals.Set("service_type", q.ServiceType)
	}
	if q.MinReputation > 0 {
		vals.Set("min_reputation", strconv.Itoa(q.MinReputation))
	}
	if q.MinScore > 0 {
		vals.Set("min_score", strconv.Itoa(q.MinScore))
	}
	if q.Limit > 0 {
		vals.Set("limit", strconv.Itoa(q.Limit))
	}
	path := "/v1/discovery"
	if encoded := vals.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, path, nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Portfolio returns the LP portfolio & concentration-risk report (GET /v1/credit/portfolio).
func (c *Client) Portfolio(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/credit/portfolio", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreditCheck returns the credit-as-a-service oracle answer for an agent (GET /v1/credit/check/:id, p3).
func (c *Client) CreditCheck(ctx context.Context, agentID string) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/credit/check/"+pathEscape(agentID), nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreditChecks ranks a set of agents by creditworthiness (POST /v1/credit/check, p3).
func (c *Client) CreditChecks(ctx context.Context, agentIDs []string) ([]map[string]any, error) {
	var out []map[string]any
	if err := c.do(ctx, http.MethodPost, "/v1/credit/check", map[string]any{"agent_ids": agentIDs}, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// RiskScore returns the ML risk-engine v2 score for an agent (GET /v1/agents/:id/risk-score, p7).
func (c *Client) RiskScore(ctx context.Context, agentID string) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/agents/"+pathEscape(agentID)+"/risk-score", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DataCommons returns the anonymized public credit-data snapshot (GET /v1/credit/data-commons, p6).
func (c *Client) DataCommons(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/credit/data-commons", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Exposure returns omnichain exposure reconciliation across all agents (GET /v1/credit/exposure, p5).
func (c *Client) Exposure(ctx context.Context) ([]map[string]any, error) {
	var out []map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/credit/exposure", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AgentExposure returns an agent's Casper-rooted exposure + global headroom (GET /v1/agents/:id/exposure, p5).
func (c *Client) AgentExposure(ctx context.Context, agentID string) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/agents/"+pathEscape(agentID)+"/exposure", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Verticals returns the service-vertical underwriting profiles (GET /v1/verticals, p10).
func (c *Client) Verticals(ctx context.Context) ([]map[string]any, error) {
	var out []map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/verticals", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Vertical returns one service-vertical underwriting profile (GET /v1/verticals/:name, p10).
func (c *Client) Vertical(ctx context.Context, name string) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/verticals/"+pathEscape(name), nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AttestationGraph returns the web-of-trust graph (GET /v1/attestations/graph).
func (c *Client) AttestationGraph(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/attestations/graph", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Benchmark returns an agent's percentile vs its service-type cohort (GET /v1/agents/:id/benchmark).
func (c *Client) Benchmark(ctx context.Context, agentID string) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/agents/"+pathEscape(agentID)+"/benchmark", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreditHistory returns an agent's chronological credit file (GET /v1/agents/:id/history).
func (c *Client) CreditHistory(ctx context.Context, agentID string) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/agents/"+pathEscape(agentID)+"/history", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SimulationInput parameterizes a read-only what-if underwriting preview.
type SimulationInput struct {
	MonthlyRevenueCSPR float64 `json:"monthly_revenue_cspr"`
	Reputation         float64 `json:"reputation,omitempty"`
	StakeCSPR          float64 `json:"stake_cspr,omitempty"`
	Accuracy           float64 `json:"accuracy,omitempty"`
	DisputeRate        float64 `json:"dispute_rate,omitempty"`
}

// SimulateCredit runs the what-if underwriting preview (POST /v1/credit/simulate).
func (c *Client) SimulateCredit(ctx context.Context, in SimulationInput) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodPost, "/v1/credit/simulate", in, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreditOffers lists pre-approval offers, optionally for one agent (GET /v1/credit/offers).
func (c *Client) CreditOffers(ctx context.Context, agentID string) ([]map[string]any, error) {
	path := "/v1/credit/offers"
	if agentID != "" {
		path += "?agent_id=" + url.QueryEscape(agentID)
	}
	var out []map[string]any
	if err := c.do(ctx, http.MethodGet, path, nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// IssueCreditOffer issues a time-bounded pre-approval offer (POST /v1/credit/offers).
func (c *Client) IssueCreditOffer(ctx context.Context, agentID, idempotencyKey string) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodPost, "/v1/credit/offers", map[string]any{"agent_id": agentID}, idempotencyKey, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AcceptCreditOffer accepts a pending offer and opens a line (POST /v1/credit/offers/:id/accept).
func (c *Client) AcceptCreditOffer(ctx context.Context, offerID, idempotencyKey string) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodPost, "/v1/credit/offers/"+pathEscape(offerID)+"/accept", nil, idempotencyKey, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AgentBenchmark returns an agent's percentile vs its service-type cohort.
func (c *Client) AgentBenchmark(ctx context.Context, agentID string) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/agents/"+pathEscape(agentID)+"/benchmark", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AgentHealth returns an agent's green/amber/red health badge.
func (c *Client) AgentHealth(ctx context.Context, agentID string) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/agents/"+pathEscape(agentID)+"/health", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CompareAgents returns a side-by-side comparison of two agents.
func (c *Client) CompareAgents(ctx context.Context, a, b string) (map[string]any, error) {
	var out map[string]any
	path := "/v1/agents/compare?a=" + url.QueryEscape(a) + "&b=" + url.QueryEscape(b)
	if err := c.do(ctx, http.MethodGet, path, nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreditCost itemizes the cost of a specific draw against an agent's line.
func (c *Client) CreditCost(ctx context.Context, agentID string, drawCSPR float64) (map[string]any, error) {
	var out map[string]any
	path := "/v1/agents/" + pathEscape(agentID) + "/credit-cost?draw_cspr=" + strconv.FormatFloat(drawCSPR, 'f', -1, 64)
	if err := c.do(ctx, http.MethodGet, path, nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CategoryAnalytics returns market intelligence aggregated by service category.
func (c *Client) CategoryAnalytics(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/analytics/categories", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ReputationMovers returns the biggest reputation gainers and losers.
func (c *Client) ReputationMovers(ctx context.Context, limit int) (map[string]any, error) {
	var out map[string]any
	path := "/v1/analytics/reputation-movers"
	if limit > 0 {
		path += "?limit=" + strconv.Itoa(limit)
	}
	if err := c.do(ctx, http.MethodGet, path, nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DisputeStats returns protocol-level dispute statistics.
func (c *Client) DisputeStats(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/analytics/disputes", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// X402Stats returns x402 receipt-network statistics.
func (c *Client) X402Stats(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodGet, "/v1/analytics/x402", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Marketplace & economics
// ---------------------------------------------------------------------------

// Marketplace returns all marketplace listings.
func (c *Client) Marketplace(ctx context.Context) ([]MarketListing, error) {
	var out []MarketListing
	if err := c.do(ctx, http.MethodGet, "/v1/marketplace", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Economics returns the protocol economics snapshot.
func (c *Client) Economics(ctx context.Context) (*EconomicsView, error) {
	var out EconomicsView
	if err := c.do(ctx, http.MethodGet, "/v1/economics", nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

// ScreenCompliance runs the sanctions/KYB screen for an agent.
func (c *Client) ScreenCompliance(ctx context.Context, agentID string) (*ComplianceResult, error) {
	var out ComplianceResult
	if err := c.do(ctx, http.MethodGet, "/v1/compliance/agents/"+pathEscape(agentID), nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---------------------------------------------------------------------------
// RealFi
// ---------------------------------------------------------------------------

// RealfiState returns the aggregate RealFi state.
func (c *Client) RealfiState(ctx context.Context) (*RealfiState, error) {
	var out RealfiState
	if err := c.do(ctx, http.MethodGet, "/v1/realfi", nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// VerifyOperatorInput is the payload for VerifyOperator.
type VerifyOperatorInput struct {
	OperatorID            string `json:"operator_id"`
	Jurisdiction          string `json:"jurisdiction,omitempty"`
	VerificationLevel     string `json:"verification_level,omitempty"`
	VerificationReference string `json:"verification_reference"`
}

// VerifyOperator records a verified operator and returns the attestation.
func (c *Client) VerifyOperator(ctx context.Context, in VerifyOperatorInput, idempotencyKey string) (*OperatorVerification, error) {
	var out OperatorVerification
	if err := c.do(ctx, http.MethodPost, "/v1/realfi/operators", in, idempotencyKey, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// FiatReceiptInput is the payload for RecordFiatReceipt.
type FiatReceiptInput struct {
	SellerAgent       string `json:"seller_agent"`
	OperatorID        string `json:"operator_id"`
	Amount            string `json:"amount"`
	Currency          string `json:"currency,omitempty"`
	ServiceType       string `json:"service_type,omitempty"`
	ProviderEventID   string `json:"provider_event_id"`
	ProviderReceiptID string `json:"provider_receipt_id"`
}

// RecordFiatReceipt records an off-chain fiat receipt.
func (c *Client) RecordFiatReceipt(ctx context.Context, in FiatReceiptInput, idempotencyKey string) (FiatReceiptResult, error) {
	var out FiatReceiptResult
	if err := c.do(ctx, http.MethodPost, "/v1/realfi/fiat-receipts", in, idempotencyKey, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Disputes, admin, webhooks
// ---------------------------------------------------------------------------

// DisputeInput is the payload for OpenDispute.
type DisputeInput struct {
	RespondentAgent string `json:"respondent_agent"`
	DisputeType     string `json:"dispute_type,omitempty"`
	ReceiptID       string `json:"receipt_id,omitempty"`
	Note            string `json:"note,omitempty"`
}

// OpenDispute opens a dispute against an agent.
func (c *Client) OpenDispute(ctx context.Context, in DisputeInput, idempotencyKey string) (Dispute, error) {
	var out Dispute
	if err := c.do(ctx, http.MethodPost, "/v1/disputes", in, idempotencyKey, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateAPIKey issues a new scoped API key (requires an admin key).
func (c *Client) CreateAPIKey(ctx context.Context, name string, scopes []string, idempotencyKey string) (APIKey, error) {
	body := map[string]any{"name": name, "scopes": scopes}
	var out APIKey
	if err := c.do(ctx, http.MethodPost, "/v1/admin/api-keys", body, idempotencyKey, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SubscribeWebhook registers a webhook subscription (requires an admin key).
func (c *Client) SubscribeWebhook(ctx context.Context, url string, events []string, idempotencyKey string) (Webhook, error) {
	body := map[string]any{"url": url}
	if len(events) > 0 {
		body["events"] = events
	}
	var out Webhook
	if err := c.do(ctx, http.MethodPost, "/v1/webhooks", body, idempotencyKey, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Demo (raw /api surface)
// ---------------------------------------------------------------------------

// RunDemo runs the end-to-end demo flow via the raw /api/demo/run route. This
// route returns no envelope.
func (c *Client) RunDemo(ctx context.Context) (*DemoResult, error) {
	var out DemoResult
	if err := c.do(ctx, http.MethodPost, "/api/demo/run", nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RunRealfiDemo runs the RealFi demo flow via /api/demo/realfi.
func (c *Client) RunRealfiDemo(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	if err := c.do(ctx, http.MethodPost, "/api/demo/realfi", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// pathEscape escapes a single path segment, preserving readability for common
// agent ids while protecting against slashes and reserved characters.
func pathEscape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.', r == '~':
			b.WriteRune(r)
		default:
			for _, by := range []byte(string(r)) {
				fmt.Fprintf(&b, "%%%02X", by)
			}
		}
	}
	return b.String()
}

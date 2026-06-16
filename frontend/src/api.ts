import type { Snapshot } from "./types";

export async function getSnapshot(): Promise<Snapshot> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`state ${res.status}`);
  return res.json();
}

export async function runDemo(dispute = false): Promise<void> {
  await fetch(dispute ? "/api/demo/dispute" : "/api/demo/run", { method: "POST" });
}

export async function resetDemo(): Promise<void> {
  await fetch("/api/demo/reset", { method: "POST" });
}

export interface EconomicsView {
  fees: { facilitator_fee_bps: number; origination_fee_bps: number; interest_spread_bps: number; late_fee_bps: number };
  health: { utilization: number; realized_apy: number; realized_yield: string; loss_rate: number; risk_flags: string[] };
}

export async function getEconomics(): Promise<EconomicsView> {
  const res = await fetch("/api/economics");
  return res.json();
}

export interface LpView {
  total_liquidity_motes: string;
  outstanding_motes: string;
  interest_accrued_motes: string;
  utilization: number;
  positions: Array<{ provider: string; deposited_motes: string; share: number; estimated_yield_motes: string; estimated_apy: number }>;
}

export async function getLpView(): Promise<LpView> {
  const res = await fetch("/api/lp");
  return res.json();
}

export async function depositLiquidity(amountCspr: number): Promise<void> {
  await fetch("/api/credit/deposit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount_cspr: amountCspr }),
  });
}

export interface CreditReviewResult {
  agent_id: string;
  action: "increased" | "held" | "ineligible";
  previous_limit_motes: string;
  new_limit_motes: string;
  recommended_limit_motes: string;
  detail: string;
}

export async function reviewCreditLine(agentId: string): Promise<CreditReviewResult | { error: string }> {
  const res = await fetch(`/v1/credit/lines/${encodeURIComponent(agentId)}/review`, { method: "POST" });
  const body = (await res.json()) as { data: CreditReviewResult | { error: string } };
  return body.data;
}

export async function resolveDispute(disputeId: string, verdict: string, slashCspr: number): Promise<void> {
  await fetch(`/v1/disputes/${encodeURIComponent(disputeId)}/verdict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verdict, slash_cspr: slashCspr }),
  });
}

export async function advanceClock(days: number): Promise<void> {
  await fetch("/v1/admin/advance-clock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seconds: days * 86400 }),
  });
}

export async function withdrawLiquidity(amountCspr: number): Promise<{ error?: string }> {
  const res = await fetch("/v1/credit/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount_cspr: amountCspr }),
  });
  const body = (await res.json()) as { success?: boolean; data?: { error?: string }; error?: { message?: string } };
  return { error: body.data?.error ?? body.error?.message };
}

export interface ReasonCode { code: string; polarity: "positive" | "negative"; detail: string }
export interface CreditExplain {
  decision?: { credit_line: string; credit_score: number; interest_rate_bps: number; reason_codes?: ReasonCode[] };
  fraud_score?: number;
  realfi_multiplier?: number;
  eligible?: boolean;
  ineligible_reason?: string;
  error?: string;
}

export async function getCreditExplain(agentId: string): Promise<CreditExplain> {
  const res = await fetch(`/api/credit/explain/${encodeURIComponent(agentId)}`);
  return res.json();
}

export interface MarketListing {
  listing_id: string;
  agent_id: string;
  category: string;
  strategy: string;
  base_price: string;
  reputation_score: number;
  dispute_rate: number;
  receipt_count: number;
  supported_chains: string[];
}

export async function getMarketplace(): Promise<MarketListing[]> {
  const res = await fetch("/api/marketplace");
  return res.json();
}

export async function createListing(input: { agent_id: string; category: string; strategy: string; base_price_cspr: number }): Promise<{ success?: boolean; data?: { listing_id?: string; error?: string } }> {
  const res = await fetch("/v1/marketplace/listings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return res.json();
}

export async function purchaseListing(listingId: string, buyerAgent: string): Promise<{ receipt?: { receipt_id: string; amount: string }; error?: string }> {
  const res = await fetch("/api/marketplace/purchase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listing_id: listingId, buyer_agent: buyerAgent }),
  });
  return res.json();
}

export interface AnalyticsView {
  totals: Record<string, number>;
  pool: { tvl_motes: string; outstanding_motes: string; interest_accrued_motes: string; utilization: number; open_credit_lines: number; defaults: number };
  x402: { total_volume_motes: string; avg_receipt_motes: string; settled_rate: number };
  risk: { avg_reputation: number; avg_credit_score: number; high_fraud_agents: number; avg_dispute_rate: number };
  leaderboard: Array<{ agent_id: string; service_type: string; reputation: number; credit_score: number; revenue_motes: string; receipts: number; credit_line_motes: string; fraud_score: number; tier: string }>;
  credit_timeline: Array<{ seq: number; event: string; agent_id?: string; amount_motes?: string }>;
}

export async function getAnalytics(): Promise<AnalyticsView> {
  const res = await fetch("/api/analytics");
  return res.json();
}

export interface SeriesPoint {
  seq: number;
  liquidity: number;
  outstanding: number;
  receipts: number;
}

export async function getTimeseries(): Promise<SeriesPoint[]> {
  const res = await fetch("/api/timeseries");
  return res.json();
}

export interface Incidents {
  fraud_watchlist: Array<{ agent_id: string; score: number; flags: string[] }>;
  frozen_lines: string[];
  defaulted_lines: string[];
  open_disputes: Array<{ dispute_id: string; respondent: string; type: string; status: string }>;
  defaults_total: number;
  paused: { credit_draws: boolean; registrations: boolean; receipt_finalization: boolean };
}

export async function getIncidents(): Promise<Incidents> {
  const res = await fetch("/api/incidents");
  return res.json();
}

export interface CreditHealthLine {
  agent_id: string;
  status: string;
  drawn_motes: string;
  max_credit_motes: string;
  utilization: number;
  health_factor_bps: number;
  overdue: boolean;
  due_in_seconds: number;
}

export async function getCreditHealth(): Promise<CreditHealthLine[]> {
  const res = await fetch("/api/credit/health");
  return res.json();
}

export interface StressResult {
  default_rate: number;
  recovery_rate: number;
  net_loss_motes: string;
  liquidity_after_motes: string;
  coverage_ratio: number;
  solvent: boolean;
}

export async function getStressTest(): Promise<StressResult[]> {
  const res = await fetch("/v1/credit/stress-test");
  const body = (await res.json()) as { success?: boolean; data?: StressResult[] };
  return body.data ?? [];
}

export async function freezeLine(agentId: string): Promise<void> {
  await fetch(`/v1/credit/lines/${encodeURIComponent(agentId)}/freeze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "frozen from Ops console" }),
  });
}

export interface X402Trace {
  evidence_type: string;
  challenge_headers: Record<string, string>;
  receipt: { receipt_id: string; amount: string; status: string; result_hash: string; payment_proof_hash: string };
  report: { evidence_type: string; confidence: number; evidence_hash: string; fields?: Record<string, unknown> };
}

export async function x402Buy(evidenceType: string, tampered = false): Promise<X402Trace> {
  const res = await fetch("/api/x402/buy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ evidence_type: evidenceType, tampered }),
  });
  return res.json();
}

export async function pauseProtocol(area: "credit_draws" | "registrations" | "receipt_finalization", on: boolean): Promise<void> {
  await fetch("/api/governance/pause", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ area, on }),
  });
}

export interface Notification {
  id: string;
  seq: number;
  severity: "info" | "success" | "warning" | "critical";
  title: string;
  detail: string;
  agent_id?: string;
  timestamp: number;
}

export async function getNotifications(): Promise<Notification[]> {
  const res = await fetch("/api/notifications");
  return res.json();
}

export interface SearchResult {
  kind: string;
  id: string;
  label: string;
  detail: string;
}

export async function search(q: string): Promise<SearchResult[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  return res.json();
}

// -- Developer portal (production /v1 admin + GraphQL) ----------------------

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function v1<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/v1${path}`, init);
  const body = (await res.json()) as Envelope<T>;
  if (!body.success) throw new Error(body.error?.message ?? "request failed");
  return body.data as T;
}

export interface ApiKeyMeta {
  id: string;
  name: string;
  scopes: string[];
  created_at: number;
  revoked_at?: number;
}

export async function listApiKeys(): Promise<ApiKeyMeta[]> {
  return v1<ApiKeyMeta[]>("/admin/api-keys");
}

export async function createApiKey(name: string, scopes: string[]): Promise<{ id: string; secret: string; scopes: string[] }> {
  return v1("/admin/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, scopes }),
  });
}

export interface WebhookMeta {
  id: string;
  url: string;
  events: string[];
  created_at: number;
}

export async function listWebhooks(): Promise<WebhookMeta[]> {
  return v1<WebhookMeta[]>("/webhooks");
}

export async function createWebhook(url: string, events: string[]): Promise<WebhookMeta & { secret: string }> {
  return v1("/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, events }),
  });
}

export interface AgentProfile {
  passport?: { service_type?: string; operator?: string; reputation_score?: number; capabilities?: string[] };
  tier?: { tier?: string; score?: number; credit_multiplier?: number; origination_discount_bps?: number; next_tier?: string; points_to_next?: number };
  credit_explain?: { decision?: { credit_line?: string; reason_codes?: ReasonCode[] }; eligible?: boolean; ineligible_reason?: string; realfi_multiplier?: number };
  compliance?: { cleared?: boolean; checks?: Array<{ name: string; passed: boolean; detail: string }> };
  credit_line?: { drawn: string; max_credit: string; status: string } | null;
  receipts?: Array<{ receipt_id: string; amount: string; service_type: string; status: string }>;
  evidence?: Array<{ evidence_id: string; evidence_type: string; confidence: number; verified: boolean }>;
  realfi?: { operator_id?: string; verified?: boolean; fiat_receipts?: number };
  reputation_events?: Array<{ seq: number; previous?: number; current?: number; reason_code?: string }>;
  error?: string;
}

export async function getAgentProfile(id: string): Promise<AgentProfile> {
  const res = await fetch(`/api/agent-profile/${encodeURIComponent(id)}`);
  return res.json();
}

export interface CreditReport {
  agent_id: string;
  credit_score: number;
  score_band: string;
  pd_estimate: number;
  recommended_terms: { credit_line_motes: string; interest_rate_bps: number };
  factors: { positive: Array<{ code: string; detail: string }>; negative: Array<{ code: string; detail: string }> };
  payment_history: { receipts_total: number; receipts_finalized: number; receipts_disputed: number; repayments: number; on_time_rate: number };
  public_records: { disputes: Array<{ dispute_id: string; type: string; status: string; verdict?: string }>; slashes: Array<{ amount_motes: string; reason: string }> };
  inquiries: Array<{ seq: number; credit_score: number }>;
  revenue_summary: { revenue_30d_motes: string; revenue_total_motes: string; jobs_completed: number };
  compliance: { cleared: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> };
  error?: string;
}

export async function getCreditReport(id: string): Promise<CreditReport> {
  const res = await fetch(`/api/credit-report/${encodeURIComponent(id)}`);
  return res.json();
}

export async function runGraphQL(query: string): Promise<unknown> {
  const res = await fetch("/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

export interface Proposal {
  id: string;
  title: string;
  param_key: string;
  new_value: number | boolean;
  proposer: string;
  votes_for: number;
  votes_against: number;
  voters: string[];
  status: string;
  eta?: number;
}

export async function getProposals(): Promise<Proposal[]> {
  const res = await fetch("/v1/governance/proposals");
  const body = (await res.json()) as { data?: Proposal[] };
  return body.data ?? [];
}

export async function createProposal(input: { title: string; param_key: string; new_value: number; proposer: string }): Promise<void> {
  await fetch("/v1/governance/proposals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
}

export async function voteProposal(id: string, agent_id: string, support: boolean): Promise<void> {
  await fetch(`/v1/governance/proposals/${encodeURIComponent(id)}/vote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id, support }) });
}

export async function executeProposal(id: string): Promise<void> {
  await fetch(`/v1/governance/proposals/${encodeURIComponent(id)}/execute`, { method: "POST" });
}

export async function applyProposal(id: string): Promise<{ error?: { message?: string } }> {
  const res = await fetch(`/v1/governance/proposals/${encodeURIComponent(id)}/apply`, { method: "POST" });
  return res.json();
}

export async function upgradePolicy(version: string): Promise<void> {
  await fetch("/api/policy/upgrade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });
}

export interface JurisdictionRow {
  jurisdiction: string;
  operators: number;
  verified: number;
  sanctioned: boolean;
  agents: string[];
}

export interface ComplianceReport {
  generated_at: number;
  total_operators: number;
  verified_operators: number;
  kyb_coverage: number;
  sanctioned_exposure: number;
  by_jurisdiction: JurisdictionRow[];
}

export async function getComplianceReport(): Promise<ComplianceReport> {
  const res = await fetch("/v1/compliance/report");
  if (!res.ok) throw new Error(`compliance report failed: ${res.status}`);
  const body = (await res.json()) as { data: ComplianceReport };
  return body.data;
}

export interface AttestationEdge {
  from: string;
  to: string;
  weight: number;
  note: string;
  at: number;
}

export interface TrustNode {
  agent_id: string;
  in_degree: number;
  out_degree: number;
  trust_score: number;
  reputation: number;
}

export interface AttestationGraphView {
  nodes: TrustNode[];
  edges: AttestationEdge[];
  total_attestations: number;
}

export async function getAttestationGraph(): Promise<AttestationGraphView> {
  const res = await fetch("/v1/attestations/graph");
  if (!res.ok) throw new Error(`attestation graph failed: ${res.status}`);
  const body = (await res.json()) as { data: AttestationGraphView };
  return body.data;
}

export async function postAttestation(from: string, to: string, note: string): Promise<{ error?: string }> {
  const res = await fetch("/v1/attestations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, note }),
  });
  const body = (await res.json()) as { data?: { error?: string }; error?: string };
  return body.data ?? { error: body.error };
}

export interface DiscoveryRow {
  rank: number;
  agent_id: string;
  service_type: string;
  score: number;
  reputation: number;
  credit_score: number;
  tier: string;
  trust_score: number;
  vouches: number;
  revenue_motes: string;
  fraud_score: number;
  recommended: boolean;
}

export interface DiscoveryResult {
  query: { service_type?: string; min_reputation?: number; min_score?: number; limit?: number };
  count: number;
  results: DiscoveryRow[];
}

export async function getDiscovery(params: {
  service_type?: string;
  min_reputation?: number;
  min_score?: number;
}): Promise<DiscoveryResult> {
  const qs = new URLSearchParams();
  if (params.service_type) qs.set("service_type", params.service_type);
  if (params.min_reputation) qs.set("min_reputation", String(params.min_reputation));
  if (params.min_score) qs.set("min_score", String(params.min_score));
  const res = await fetch(`/v1/discovery?${qs.toString()}`);
  if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
  const body = (await res.json()) as { data: DiscoveryResult };
  return body.data;
}

export interface ExposureSlice {
  key: string;
  outstanding_motes: string;
  share_bps: number;
  lines: number;
}

export interface PortfolioReport {
  generated_at: number;
  total_liquidity_motes: string;
  outstanding_motes: string;
  free_liquidity_motes: string;
  utilization_bps: number;
  active_lines: number;
  defaults: number;
  hhi: number;
  concentration_band: "diversified" | "moderate" | "concentrated";
  largest_borrower: ExposureSlice | null;
  by_agent: ExposureSlice[];
  by_service_type: ExposureSlice[];
  by_tier: ExposureSlice[];
  by_health_band: ExposureSlice[];
}

export async function getPortfolio(): Promise<PortfolioReport> {
  const res = await fetch("/v1/credit/portfolio");
  if (!res.ok) throw new Error(`portfolio failed: ${res.status}`);
  const body = (await res.json()) as { data: PortfolioReport };
  return body.data;
}

export interface SimulationResult {
  input: {
    monthly_revenue_cspr: number;
    stake_cspr: number;
    reputation: number;
    accuracy: number;
    dispute_rate: number;
    jobs_completed: number;
    service_type: string;
  };
  decision: {
    credit_line: string;
    interest_rate_bps: number;
    credit_score: number;
    rationale: string[];
    reason_codes?: { code: string; polarity: string; detail: string }[];
  };
  estimated_credit_line_cspr: number;
  governance_capped: boolean;
  eligible: boolean;
  ineligible_reason?: string;
}

export async function simulateCredit(input: {
  monthly_revenue_cspr: number;
  stake_cspr?: number;
  reputation?: number;
  accuracy?: number;
  dispute_rate?: number;
  jobs_completed?: number;
}): Promise<SimulationResult> {
  const res = await fetch("/v1/credit/simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`simulate failed: ${res.status}`);
  const body = (await res.json()) as { data: SimulationResult };
  return body.data;
}

export interface MetricBenchmark {
  value: number;
  cohort_median: number;
  percentile: number;
  rank: number;
}

export interface PeerBenchmark {
  agent_id: string;
  service_type: string;
  cohort_size: number;
  reputation: MetricBenchmark;
  credit_score: MetricBenchmark;
  revenue: MetricBenchmark;
  fraud_score: MetricBenchmark;
  overall_percentile: number;
}

export async function getPeerBenchmark(agentId: string): Promise<PeerBenchmark | { error: string }> {
  const res = await fetch(`/v1/agents/${encodeURIComponent(agentId)}/benchmark`);
  if (!res.ok) throw new Error(`benchmark failed: ${res.status}`);
  const body = (await res.json()) as { data: PeerBenchmark | { error: string } };
  return body.data;
}

export interface CreditOffer {
  offer_id: string;
  agent_id: string;
  max_credit_motes: string;
  interest_rate_bps: number;
  origination_fee_bps: number;
  credit_score: number;
  term_seconds: number;
  issued_at: number;
  expires_at: number;
  status: "pending" | "accepted" | "declined" | "expired";
  rationale: string[];
}

export async function listCreditOffers(agentId?: string): Promise<CreditOffer[]> {
  const qs = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
  const res = await fetch(`/v1/credit/offers${qs}`);
  if (!res.ok) throw new Error(`offers failed: ${res.status}`);
  const body = (await res.json()) as { data: CreditOffer[] };
  return body.data;
}

export async function issueCreditOffer(agentId: string): Promise<CreditOffer | { error: string }> {
  const res = await fetch("/v1/credit/offers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  });
  const body = (await res.json()) as { data: CreditOffer | { error: string } };
  return body.data;
}

export async function decideCreditOffer(offerId: string, action: "accept" | "decline"): Promise<{ error?: string }> {
  const res = await fetch(`/v1/credit/offers/${encodeURIComponent(offerId)}/${action}`, { method: "POST" });
  const body = (await res.json()) as { data?: { error?: string }; error?: string };
  return body.data ?? { error: body.error };
}

export interface HistoryEntry {
  seq: number;
  timestamp: number;
  event: string;
  category: string;
  summary: string;
}

export interface CreditHistory {
  agent_id: string;
  entries: HistoryEntry[];
  counts: Record<string, number>;
  first_seen?: number;
  last_activity?: number;
}

export async function getCreditHistory(agentId: string): Promise<CreditHistory | { error: string }> {
  const res = await fetch(`/v1/agents/${encodeURIComponent(agentId)}/history`);
  if (!res.ok) throw new Error(`history failed: ${res.status}`);
  const body = (await res.json()) as { data: CreditHistory | { error: string } };
  return body.data;
}

export interface RiskAlert {
  severity: "critical" | "warning" | "info";
  code: string;
  subject: string;
  message: string;
}

export interface RiskAlertReport {
  generated_at: number;
  counts: { critical: number; warning: number; info: number };
  alerts: RiskAlert[];
}

export async function getRiskAlerts(): Promise<RiskAlertReport> {
  const res = await fetch("/v1/risk/alerts");
  if (!res.ok) throw new Error(`risk alerts failed: ${res.status}`);
  const body = (await res.json()) as { data: RiskAlertReport };
  return body.data;
}

export interface YieldHorizon {
  horizon_days: number;
  gross_interest_motes: string;
  lp_interest_motes: string;
  expected_loss_motes: string;
  net_lp_yield_motes: string;
  projected_apy: number;
}

export interface YieldProjection {
  generated_at: number;
  total_liquidity_motes: string;
  outstanding_motes: string;
  utilization: number;
  weighted_avg_apr_bps: number;
  loss_assumption: number;
  protocol_spread_bps: number;
  horizons: YieldHorizon[];
}

export async function getYieldProjection(): Promise<YieldProjection> {
  const res = await fetch("/v1/credit/yield-projection");
  if (!res.ok) throw new Error(`yield projection failed: ${res.status}`);
  const body = (await res.json()) as { data: YieldProjection };
  return body.data;
}

export interface ReadinessItem {
  requirement: string;
  met: boolean;
  detail: string;
  guidance: string;
  blocking: boolean;
}

export interface OnboardingScorecard {
  agent_id: string;
  ready: boolean;
  readiness_pct: number;
  items: ReadinessItem[];
}

export async function getReadiness(agentId: string): Promise<OnboardingScorecard | { error: string }> {
  const res = await fetch(`/v1/agents/${encodeURIComponent(agentId)}/readiness`);
  if (!res.ok) throw new Error(`readiness failed: ${res.status}`);
  const body = (await res.json()) as { data: OnboardingScorecard | { error: string } };
  return body.data;
}

export interface TrendPoint {
  seq: number;
  timestamp: number;
  value: number;
}

export interface ScoreTrend {
  agent_id: string;
  credit_score: { current: number; change: number; points: TrendPoint[] };
  reputation: { current: number; change: number; points: TrendPoint[] };
}

export async function getScoreTrend(agentId: string): Promise<ScoreTrend | { error: string }> {
  const res = await fetch(`/v1/agents/${encodeURIComponent(agentId)}/score-trend`);
  if (!res.ok) throw new Error(`score trend failed: ${res.status}`);
  const body = (await res.json()) as { data: ScoreTrend | { error: string } };
  return body.data;
}

export interface FleetAgentRow {
  agent_id: string;
  exists: boolean;
  service_type?: string;
  reputation?: number;
  credit_score?: number;
  discovery_score?: number;
  tier?: string;
  ready?: boolean;
  readiness_pct?: number;
  has_credit_line?: boolean;
  drawn_motes?: string;
}

export interface FleetOverview {
  count: number;
  ready: number;
  not_ready: number;
  unknown: number;
  agents: FleetAgentRow[];
}

export async function getFleetOverview(agentIds: string[]): Promise<FleetOverview> {
  const res = await fetch("/v1/operators/fleet-overview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_ids: agentIds }),
  });
  if (!res.ok) throw new Error(`fleet overview failed: ${res.status}`);
  const body = (await res.json()) as { data: FleetOverview };
  return body.data;
}

export interface WalletChallenge {
  account: string;
  nonce: string;
  message: string;
  issued_at: number;
  expires_at: number;
}

export interface WalletSession {
  account: string;
  token: string;
  issued_at: number;
  expires_at: number;
}

export async function walletChallenge(account: string): Promise<WalletChallenge | { error: string }> {
  const res = await fetch("/v1/auth/wallet/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account }),
  });
  const body = (await res.json()) as { data: WalletChallenge | { error: string } };
  return body.data;
}

export async function walletVerify(nonce: string, signature: string): Promise<WalletSession | { error: string }> {
  const res = await fetch("/v1/auth/wallet/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, signature }),
  });
  const body = (await res.json()) as { data: WalletSession | { error: string } };
  return body.data;
}

export interface ComparedMetric {
  metric: string;
  a: number;
  b: number;
  winner: "a" | "b" | "tie";
  higher_is_better: boolean;
}

export interface AgentComparison {
  a: string;
  b: string;
  metrics: ComparedMetric[];
  overall_winner: "a" | "b" | "tie";
  summary: string;
}

export async function compareAgents(a: string, b: string): Promise<AgentComparison | { error: string }> {
  const res = await fetch(`/v1/agents/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return { error: body.error?.message ?? `compare failed: ${res.status}` };
  }
  const body = (await res.json()) as { data: AgentComparison | { error: string } };
  return body.data;
}

export interface CategoryStats {
  category: string;
  agent_count: number;
  avg_reputation: number;
  avg_credit_score: number;
  total_revenue_motes: string;
  total_receipts: number;
  top_agent: string | null;
}

export async function getCategoryAnalytics(): Promise<{ categories: CategoryStats[] }> {
  const res = await fetch("/v1/analytics/categories");
  if (!res.ok) throw new Error(`categories failed: ${res.status}`);
  return ((await res.json()) as { data: { categories: CategoryStats[] } }).data;
}

export interface Mover {
  agent_id: string;
  change: number;
  current: number;
  events: number;
}

export async function getReputationMovers(limit = 5): Promise<{ gainers: Mover[]; losers: Mover[] }> {
  const res = await fetch(`/v1/analytics/reputation-movers?limit=${limit}`);
  if (!res.ok) throw new Error(`movers failed: ${res.status}`);
  return ((await res.json()) as { data: { gainers: Mover[]; losers: Mover[] } }).data;
}

export interface HealthFactor {
  label: string;
  status: "green" | "amber" | "red";
  detail: string;
}

export interface AgentHealthBadge {
  agent_id: string;
  status: "green" | "amber" | "red";
  score: number;
  factors: HealthFactor[];
}

export async function getAgentHealth(agentId: string): Promise<AgentHealthBadge | { error: string }> {
  const res = await fetch(`/v1/agents/${encodeURIComponent(agentId)}/health`);
  if (!res.ok) throw new Error(`health failed: ${res.status}`);
  const body = (await res.json()) as { data: AgentHealthBadge | { error: string } };
  return body.data;
}

export interface DisputeStats {
  total: number;
  open: number;
  resolved: number;
  by_verdict: Record<string, number>;
  by_type: Record<string, number>;
  total_slashed_motes: string;
  resolution_rate: number;
  agent_loss_rate: number;
  most_disputed_agent: { agent_id: string; disputes: number } | null;
}

export async function getDisputeStats(): Promise<DisputeStats> {
  const res = await fetch("/v1/analytics/disputes");
  if (!res.ok) throw new Error(`dispute stats failed: ${res.status}`);
  return ((await res.json()) as { data: DisputeStats }).data;
}

const MOTES = 1_000_000_000;
export function fmtCspr(motes: string | number, decimals = 3): string {
  const n = Number(motes) / MOTES;
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

export function shortHash(h: string, n = 10): string {
  if (!h) return "—";
  return h.length > n + 4 ? `${h.slice(0, n)}…${h.slice(-4)}` : h;
}

export function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString();
}

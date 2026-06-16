# Cred402 Risk Engine

Advisory **risk + fraud** microservice for the Cred402 protocol
(see `PRODUCTION.md` — Risk Engine + Fraud Service).

It computes **advisory** risk scores that the protocol's on-chain
`RiskPolicyManager` (§6.8) can consume. Nothing here moves money — per the spec,
*"deterministic scoring first, ML second. The LLM explains, but does not
directly control money."*

- **Zero dependencies.** Pure Python standard library
  (`http.server`, `json`, `urllib.request`, `math`, `dataclasses`, `statistics`).
  Runs with `python3`, no `pip install`.
- **Library + service.** Importable package *and* an HTTP JSON API *and* a CLI.
- **Python 3.10+.**

It reads live agent/receipt data from the Cred402 API
(`GET /api/agents`, `GET /api/receipts`, default `http://localhost:4021`).

---

## Quick start

```bash
# 1. Start the Cred402 API and seed demo data (from repo root)
npm start &                              # serves http://localhost:4021
curl -s -XPOST http://localhost:4021/api/demo/run >/dev/null

# 2. Use the CLI (no install needed)
python3 services/risk-engine/cli.py portfolio
python3 services/risk-engine/cli.py score EvidenceSellerAgent
python3 services/risk-engine/cli.py fraud EvidenceSellerAgent

# 3. Or run the HTTP service
python3 services/risk-engine/cred402_risk/server.py   # binds :8088
curl -s http://localhost:8088/health
curl -s http://localhost:8088/risk/portfolio
curl -s http://localhost:8088/risk/score/EvidenceSellerAgent
curl -s http://localhost:8088/risk/fraud/EvidenceSellerAgent
```

### Configuration

| Env var             | Default                  | Meaning                          |
| ------------------- | ------------------------ | -------------------------------- |
| `CRED402_API`       | `http://localhost:4021`  | Upstream Cred402 API base URL    |
| `CRED402_RISK_PORT` | `8088`                   | Port the risk service binds to   |

---

## HTTP API

| Method & path                  | Returns                                                            |
| ------------------------------ | ----------------------------------------------------------------- |
| `GET /health`                  | service health + upstream reachability                            |
| `GET /risk/score/<agent_id>`   | `{pd, credit_score, interest_rate_bps, risk_bucket, reason_contributions, ...}` |
| `GET /risk/fraud/<agent_id>`   | `{fraud_score, flags, in_ring, ring_members, revenue_concentration}` |
| `GET /risk/portfolio`          | leaderboard: credit + fraud for every agent                       |

Live data is fetched from the Cred402 API on every request.

---

## Library usage

```python
import sys; sys.path.insert(0, "services/risk-engine")
from cred402_risk.client import Cred402Client
from cred402_risk.features import build_all_features
from cred402_risk import credit_score, fraud_graph

agents, receipts = Cred402Client().fetch_all()
feats = build_all_features(agents, receipts)

assessment = credit_score.assess(feats["EvidenceSellerAgent"])
print(assessment.pd, assessment.credit_score, assessment.interest_rate_bps)

fraud = fraud_graph.assess_fraud(agents, receipts)
print(fraud["EvidenceSellerAgent"].fraud_score, fraud["EvidenceSellerAgent"].flags)
```

---

## Model specification

### 1. Features (`cred402_risk/features.py`)

Pure functions over agent + receipt dicts. Money fields are *motes*
(1 CSPR = 1e9 motes); time is Unix epoch seconds. Time-relative features use a
**data-derived `now`** (the latest timestamp in the dataset) so 30-day windows
stay meaningful even when demo data is future-dated.

| Feature | Definition |
| --- | --- |
| `revenue_velocity_30d_cspr` | Σ revenue (CSPR) in the trailing 30 days |
| `revenue_total_cspr` | lifetime revenue (CSPR) |
| `revenue_trend_slope` | OLS slope of per-event revenue vs. time (CSPR/day) |
| `counterparty_concentration_hhi` | Herfindahl index over payers, weighted by amount (0..1) |
| `cadence_mean_interarrival_days` | mean gap between receipts (days) |
| `cadence_cv` | coefficient of variation of inter-arrivals (regularity signal) |
| `dispute_adjusted_accuracy` | `accuracy_score × (1 − dispute_rate)` (0..100) |
| `stake_coverage_ratio` | `stake_cspr / revenue_velocity_30d`, capped at 50 |
| `account_age_days` | days since registration / earliest revenue |
| `reputation_score` | passthrough (0..100) |

**Herfindahl index:** `HHI = Σ (wᵢ / Σw)²`. Ranges ~`1/n` (diversified) to `1.0`
(single counterparty).

### 2. Credit model (`cred402_risk/credit_score.py`)

Hand-tuned **logistic regression** over standardized features:

```
z   = INTERCEPT + Σ  COEFᵢ · standardize(xᵢ)        # standardize clipped to ±4σ
pd  = sigmoid(z)                                     # probability of default 0..1
credit_score      = round(100 · (1 − pd))           # 0..100, higher is safer
interest_rate_bps = 300 + (3500 − 300)·(100 − score)/100   # 3%..35% APR ramp
```

`INTERCEPT = -1.20`. Coefficients are **log-odds of default per +1σ**
(positive ⇒ raises default risk):

| Feature | Coef | Rationale |
| --- | --- | --- |
| `revenue_velocity_30d_cspr` | −0.85 | proven recent cash flow lowers risk |
| `revenue_trend_slope` | −0.40 | growing revenue lowers risk |
| `counterparty_concentration_hhi` | +0.70 | concentration is fragile / wash-prone |
| `cadence_cv` | −0.25 | organic bursty traffic is healthier than metronomic |
| `dispute_adjusted_accuracy` | −0.95 | reliable delivery lowers risk |
| `dispute_rate` | +0.90 | contested work raises risk |
| `stake_coverage_ratio` | −0.60 | skin in the game lowers risk |
| `account_age_days` | −0.45 | track record lowers risk |
| `reputation_score` | −0.70 | reputation lowers risk |

Standardization uses fixed `(mean, std)` reference stats (`FEATURE_STATS`) so a
single agent can be scored in isolation.

**Risk buckets:** PRIME ≥80, NEAR_PRIME ≥65, SUBPRIME ≥45, else HIGH_RISK.

**`reason_contributions`** — real linear (SHAP-for-linear) attribution:
`contributionᵢ = COEFᵢ · standardize(xᵢ)`. These sum exactly to `z − INTERCEPT`,
so the ranking is a faithful decomposition. Each is tagged with a reason code
(`STRONG_RECENT_REVENUE`, `HIGH_SERVICE_CONCENTRATION`, `WEAK_STAKE_COVERAGE`,
`YOUNG_AGENT`, …) matching the Risk Engine reason codes in `PRODUCTION.md`.

### 3. Fraud graph (`cred402_risk/fraud_graph.py`)

Builds a directed weighted `payer → seller` graph from receipts and detects:

- **(a) Reciprocal 2-cycles** (A→B and B→A) — *wash trading*. Reported weight is
  the minimum (genuinely circulating) volume.
- **(b) Strongly connected components of size ≥ 2** — *collusion rings* — via a
  real **iterative Tarjan's SCC algorithm** (explicit stack, index/lowlink,
  on-stack set).
- **(c) Revenue concentration** — Herfindahl of inbound revenue across payers.
- **(d) Self-dealing via shared operator key** — siblings sharing
  `owner_public_key` that transact with each other; plus direct self-loops.

**Fraud score** (0..100, capped) sums activated component weights: wash-trade 45,
ring 35, concentration up to 25 (scaled from HHI 0.5→1.0), self-loop 30,
shared-operator 20.

---

## Layout

```
services/risk-engine/
├── pyproject.toml
├── README.md
├── cli.py                       # score / fraud / portfolio
└── cred402_risk/
    ├── __init__.py
    ├── features.py              # feature engineering (pure functions)
    ├── credit_score.py          # logistic PD model + reason contributions
    ├── fraud_graph.py           # Tarjan SCC + wash-trade detection
    ├── client.py                # stdlib HTTP client for the Cred402 API
    └── server.py                # http.server JSON API + engine orchestration
```

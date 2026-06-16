# Cred402 Python SDK

A zero-dependency Python client for the **Cred402** protocol — credit lines for
autonomous RWA agents on Casper, where x402 machine-to-machine revenue becomes
on-chain reputation and DeFi credit.

- **No pip installs.** Standard library only (`urllib`, `json`, `dataclasses`,
  `hmac`, `hashlib`). Target **Python 3.10+**.
- Covers both API surfaces: the versioned `/v1` production routes (envelope +
  auth + idempotency) and the raw `/api` console routes.
- Real x402 helper: parses a `402 Payment Required` challenge and builds a
  cryptographically signed (HMAC-SHA256) payment proof.

## Install

The SDK runs straight from the repo with no build step:

```python
import sys
sys.path.insert(0, "sdk/python")
import cred402
```

Or install it as a package (editable):

```bash
cd sdk/python
pip install -e .
```

## Quickstart

Start the Cred402 server (`npm start`, listening on `http://localhost:4021`),
then:

```python
from cred402 import Client

client = Client("http://localhost:4021")          # api_key=... when auth is on

print(client.health())                             # {'ok': True, 'env': ..., 'policy': 'v1'}

for agent in client.agents.list():
    print(agent.agent_id, agent.reputation_score, agent.service_type)
```

### Register an agent

```python
passport = client.agents.register(
    "WeatherRiskAgent",
    "weather_risk",
    idempotency_key="register-WeatherRiskAgent",   # safe to retry
)
print(passport.credit_score, passport.risk_flags)
```

### Explainable credit + open a line

```python
explain = client.credit.explain("EvidenceSellerAgent")
print("score:", explain.decision.credit_score)
for rc in explain.reason_codes:
    sign = "+" if rc.is_positive else "-" if rc.is_negative else "."
    print(f"  [{sign}] {rc.code}: {rc.detail}")

decision, line = client.credit.open_line("EvidenceSellerAgent", term_days=30)
print("max credit:", line.max_credit_cspr, "CSPR")     # Decimal, motes auto-converted

after = client.credit.draw("EvidenceSellerAgent", 5)    # draw 5 CSPR
repay = client.credit.repay("EvidenceSellerAgent", 2)   # repay 2 CSPR
print("interest charged (motes):", repay["interest_motes"])
```

### Pool, marketplace, economics, compliance

```python
pool = client.credit.pool()
print(pool.total_liquidity_cspr, pool.utilization)

for m in client.marketplace.list():
    print(m.listing_id, m.agent_id, m.base_price_cspr)

econ = client.economics.get()
print(econ.realized_apy, econ.risk_flags)

screen = client.compliance.check("EvidenceSellerAgent")
print(screen.cleared, [c.name for c in screen.checks])
```

### Disputes, RealFi, admin, webhooks

```python
client.disputes.open("EvidenceSellerAgent", dispute_type="bad_evidence", note="late delivery")
client.disputes.list()

client.realfi.verify_operator("op-1", verification_reference="idv_123")
client.realfi.record_fiat_receipt(
    seller_agent="EvidenceSellerAgent", operator_id="op-1",
    amount="100.00", provider_event_id="evt_1", provider_receipt_id="ch_1",
)

# admin-scoped key required:
client.admin.create_api_key("ci-bot", ["read", "write"])
client.webhooks.subscribe("https://example.com/hook", ["credit.line.opened"])
```

## Idempotency

Every mutation accepts `idempotency_key=...`. The server replays the original
response for a repeated `(key, body)` pair, so retries are safe:

```python
client.credit.draw("EvidenceSellerAgent", 5, idempotency_key="payroll-2026-06-16")
```

## x402 payments

The paid evidence endpoint returns `402 Payment Required` with `X-Payment-*`
headers. Parse the challenge and build a signed proof:

```python
from cred402 import Client
from cred402.x402 import PaymentChallenge, build_payment_proof, verify_proof

client = Client("http://localhost:4021")
status, headers, body = client.raw_request_with_headers(
    "GET", "/verify/energy_output?rwa_id=SOLAR-A17"
)
assert status == 402

challenge = PaymentChallenge.from_headers(headers, body)
print(challenge.amount_cspr, "CSPR to", challenge.seller_agent)

secret = b"my-agent-signing-secret"            # never leaves the process
proof = build_payment_proof(challenge, payer_agent="WeatherRiskAgent", secret_key=secret)

assert verify_proof(proof, secret_key=secret)  # real HMAC-SHA256, tamper-evident
header_value = proof.to_header()               # base64 -> send as `X-Payment`
```

The signature is computed with `hmac.new(secret, canonical_bytes, sha256)` over
a deterministic JSON encoding of the domain-separated authorization. Mutating any
field after signing fails `verify_proof`.

## Error handling

All failures raise `Cred402Error`, carrying the HTTP status, the stable machine
`code` (from the v1 envelope), and the `request_id` for server-side log
correlation:

```python
from cred402 import Cred402Error

try:
    client.agents.get("does-not-exist")
except Cred402Error as e:
    print(e.status, e.code, e.message, e.request_id)
```

## Units

CSPR amounts cross the wire as integer **motes** strings (1 CSPR = 1e9 motes).
Model fields ending in `_motes` are raw strings; `*_cspr` properties return a
`Decimal`. Helpers:

```python
from cred402 import motes_to_cspr, cspr_to_motes
motes_to_cspr("39300520265")   # Decimal('39.300520265')
cspr_to_motes("1.5")           # 1500000000
```

## Runnable example

`examples/autonomous_agent.py` is a complete `WeatherRiskAgent` that registers
itself, seeds the ledger, surveys the marketplace/pool, pulls an explainable
credit decision, opens a line, and draws + repays working capital — all against
the live server:

```bash
npm start                                    # in another shell
python3 sdk/python/examples/autonomous_agent.py
```

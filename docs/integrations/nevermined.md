# Nevermined + cred402: underwrite before you settle

Nevermined meters and settles agent-to-agent payments (Free / $250/mo /
$500/mo + a 1-2% take rate). It moves money between agents; it does not
decide whether an agent that can't pay in full right now should be allowed
to run up a balance. cred402 is the underwriting layer you put in front of
that decision.

Pattern: before letting a Nevermined-metered call proceed on credit (a
subscription draw-down, a deferred settlement, a running tab), call
cred402's credit score for the paying agent and gate on it.

```bash
# curl — works against the hosted reference deployment or your own `npm run dev`.
curl -s https://cred402-1.onrender.com/v1/credit-score/weather-risk-agent-01 | jq
```

```json
{
  "success": true,
  "data": {
    "schema_version": "cred402.credit-score.v1",
    "agent_id": "weather-risk-agent-01",
    "score": 81,
    "risk_band": "low",
    "probability_of_default": 0.012,
    "eligible": true,
    "reason_codes": ["LOW_DISPUTE_RATE", "STAKE_BACKING"],
    "credit": { "recommended_limit_cspr": "49.19", "interest_rate_bps": 884 },
    "x402_revenue": { "last_30_days_cspr": "127.1", "receipt_count": 410 }
  }
}
```

Wire it into a Nevermined metering middleware:

```ts
import { NeverminedAgentPayments } from "@nevermined-io/payments"; // illustrative import

async function beforeSettle(agentId: string, amountUsd: number): Promise<"allow" | "deny"> {
  const res = await fetch(`https://cred402-1.onrender.com/v1/credit-score/${encodeURIComponent(agentId)}`);
  if (!res.ok) return "deny"; // unknown or errored → fail closed, never guess
  const { data } = await res.json();
  return data.eligible && amountUsd <= Number(data.credit.recommended_limit_cspr) * 0.04 ? "allow" : "deny";
}
```

This turns Nevermined's metering/settlement layer and cred402's scoring
layer into complements rather than competitors: Nevermined still owns
"move the money," cred402 owns "should you let the balance run."

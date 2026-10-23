# Skyfire + cred402: underwrite a KYA-authenticated agent call

Skyfire gives an agent an identity (KYA) and an agentic wallet so it can pay
you. It has no concept of "should I extend this agent a credit line" — that
is what cred402 adds on top.

The pattern: when a Skyfire-authenticated agent calls your service asking to
be fronted a cost (buy now, settle later; a revolving balance; a deferred
invoice), check its cred402 score before you agree, the same way you'd check
a FICO score before extending consumer credit.

```ts
// Node/TS — no cred402 SDK required, this is one fetch.
interface SkyfireCall {
  // Skyfire's KYA token already proves WHO this is; agentId is how you
  // recognize the same identity in cred402 (use the Skyfire agent id, or
  // whatever stable identifier you registered it under via POST /v1/agents).
  agentId: string;
  requestedAdvanceUsd: number;
}

async function shouldFrontTheCost(call: SkyfireCall): Promise<boolean> {
  const res = await fetch(`https://cred402-1.onrender.com/v1/credit-score/${encodeURIComponent(call.agentId)}`);
  if (res.status === 404) {
    // cred402 has never seen this agent — no track record, no credit. Fail closed.
    return false;
  }
  const { data } = (await res.json()) as {
    data: {
      eligible: boolean;
      risk_band: "low" | "medium" | "high" | "very_high";
      probability_of_default: number;
      credit: { recommended_limit_cspr: string };
      reason_codes: string[];
    };
  };
  // Your own policy on top of cred402's score — e.g. only front amounts
  // comfortably inside the recommended limit, on a low/medium risk band.
  const withinLimit = call.requestedAdvanceUsd <= Number(data.credit.recommended_limit_cspr) * 0.04; // ~$0.04/CSPR, illustrative
  return data.eligible && (data.risk_band === "low" || data.risk_band === "medium") && withinLimit;
}
```

What you get that Skyfire's identity/payment layer does not provide on its
own: a real, auditable reason ("why did we front this agent $40 and not
$4,000") — every field above traces back to `RiskPolicyManager`'s open-source
formula (`lib/services`), not a black box.

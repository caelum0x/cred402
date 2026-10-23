# Coinbase x402 (the open standard) + cred402

cred402 is itself built on the x402 protocol (the Linux-Foundation-governed
open standard Coinbase, AWS, Google, Stripe, Visa, Mastercard and Amex back)
— it is not a competitor to x402, it is the credit layer that the base
standard has no opinion about. If your agent already speaks x402 directly
(Coinbase's reference facilitator, or any other), you do not need a new SDK
to use cred402 — just one more call before you let an x402-authenticated
agent run a balance instead of paying up front.

```ts
// Any agent/service that already handles the standard x402 402-challenge
// flow can drop this in right before it would otherwise require full
// up-front payment, to decide whether to offer "pay later" instead.
import { createHeaders } from "x402/client"; // illustrative — your existing x402 client

async function offerCreditInsteadOfUpfrontPayment(agentId: string, priceUsd: number): Promise<boolean> {
  const res = await fetch(`https://cred402-1.onrender.com/v1/credit-score/${encodeURIComponent(agentId)}`);
  if (res.status === 404) return false; // no cred402 history yet → require the normal x402 payment
  const { data } = await res.json();
  return data.eligible && priceUsd <= Number(data.credit.recommended_limit_cspr) * 0.04;
}
```

Two directions this composes in practice:

1. **x402 receipts → cred402 score.** Every x402 payment an agent settles
   (on cred402 or anywhere using the same `X-Payment` header scheme) can feed
   its revenue history — see `lib/x402` and `agents/evidence_seller_agent.ts`
   for the reference receipt shape. The more x402 volume an agent has,
   across however many rails, the better the score it can present anywhere.
2. **cred402 score → an x402 credit decision.** A seller who'd otherwise
   demand payment before delivering can instead check the buyer's cred402
   score and extend a short deferred-settlement window — turning a hard
   "pay or no service" 402 into a soft "we trust you for this one, settle
   within N days" based on real, auditable history instead of a guess.

The full working example (score → draw → repay, called live) is the "90-
second proof" on the cred402 homepage (`frontend/src/components/LiveProof.tsx`)
— the exact flow a lending agent built on raw x402 would compose.

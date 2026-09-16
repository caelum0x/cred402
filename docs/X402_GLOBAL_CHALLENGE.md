# Global x402 Challenge — submission packet

What Cred402 sells into the challenge is one resource:

```
GET /v1/x402/credit-score/:agentId   →   0.01 USDC over x402 on Algorand
```

An autonomous agent pays per call for a credit decision on another agent: policy score,
probability of default, risk band, eligibility, reason codes, verified x402 revenue, and
the model/policy provenance behind the decision. The buyer is a machine deciding whether
to extend credit or capital to a counterparty it cannot otherwise underwrite.

| | |
|---|---|
| **Paid endpoint** | `https://cred402-1.onrender.com/v1/x402/credit-score/:agentId` |
| **Free status probe** | `https://cred402-1.onrender.com/v1/x402/algorand/status` |
| **Free usage projection** | `https://cred402-1.onrender.com/v1/x402/algorand/usage` |
| **Console** | https://cred402.vercel.app (Algorand x402 tab) |
| **Repository (public)** | https://github.com/caelum0x/cred402 |
| **Facilitator** | `https://facilitator.goplausible.xyz` |
| **Attribution tag** | `x402-global-challenge` in `accepts[].extra.tag` |
| **Submission deadline** | September 30 · live measurement runs through October |

Run the gate at any time — it is read-only and signs nothing:

```bash
npm run x402:algorand:challenge-check
```

It checks the five requirements from the submission email against live public data: the
deployment's own status probe, the GoPlausible Bazaar catalogue, and the challenge
leaderboard.

---

## Requirement status

| Requirement | State | Where it is satisfied |
|---|---|---|
| Live on Algorand MainNet at a public HTTPS endpoint | **owner action** | Code path is complete and fail-closed. The deployment currently answers `configured: false` because `CRED402_ALGORAND_PAY_TO` is unset. See [activation](#activation-owner-gated). |
| Uses the GoPlausible facilitator with Bazaar discovery enabled | **done** | `lib/x402/algorand_gateway.ts` — `withBazaar(new HTTPFacilitatorClient(...))`, `bazaarResourceServerExtension`, `declareDiscoveryExtension(...)`, plus the `x402-merchant` identity extension. Default facilitator is GoPlausible. |
| Includes the `x402-global-challenge` tag | **done** | `accepts[].extra.tag`, from `lib/x402/challenge_tag.ts`. Verified by `inspectAlgorandChallenge` and the release gate. |
| Has completed at least one real MainNet payment | **owner action** | Blocked on activation plus a funded external payer. Tooling: `npm run x402:algorand:pay -- --pay --mainnet`. |
| Appears in the Bazaar and on the competition leaderboard | **follows automatically** | The facilitator catalogues the resource on first settlement; `challenge-check` confirms both the catalogue entry and the leaderboard row. |

## Attribution: the tag has to be in `extra`

The facilitator writes challenge attribution **at settlement time**, from the accepted
payment option's `extra.tag`. It does not persist the x402 `resource.tags` array into its
Bazaar record, and it **never reclassifies payments that settled before the tag was
present**.

The practical consequence: a resource with the tag only in `resource.tags` still settles
and still appears in the Bazaar, but its volume is filed under `direct`/`dev` and never
reaches the challenge leaderboard. Cred402 advertised the tag that way until this round.

```ts
// lib/x402/algorand_gateway.ts
price: {
  asset: config.usdcAsset,
  amount: config.priceMicroUsdc,
  // `tag` is the attribution channel the facilitator reads at settlement.
  extra: { name: "USDC", decimals: 6, tag: X402_CHALLENGE_TAG },
},
```

Because attribution is not backfilled, **the tag must be deployed before the first real
payment** — not added afterwards. It is now enforced in three places, so a regression
cannot ship quietly:

- `inspectAlgorandChallenge` (`lib/x402/algorand_client.ts`) rejects a challenge whose
  accepted option lacks `extra.tag`, which fails both the preflight and the release gate;
- `test/algorand_x402.test.ts` asserts the decoded `PAYMENT-REQUIRED` header carries it;
- the standalone TypeScript and Python buyer examples check it before approving a payment.

## Merchant identity

The `x402-merchant` extension controls how the resource is labelled in the Bazaar and on
the leaderboard (name, website, logo, categories). Without it the leaderboard row falls
back to the bare hostname.

```ts
// lib/x402/algorand_gateway.ts
export const CRED402_MERCHANT_IDENTITY = {
  name: "Cred402 Agent Credit Score",
  website: "https://cred402.vercel.app",
  logo: "https://cred402.vercel.app/cred402-logo.png",
  categories: ["credit-scoring", "agentic-finance", "underwriting", "algorand"],
};
```

## Activation (owner-gated)

Nothing here deploys on its own. Set these on the Render service, then redeploy. Full
variable reference and the fail-closed rules: [`ACTIVATION_CHECKLIST.md`](./ACTIVATION_CHECKLIST.md).

```bash
CRED402_ALGORAND_PAY_TO=<58-char Mainnet address, opted into USDC ASA 31566704>
CRED402_ALGORAND_NETWORK=mainnet
CRED402_ENV=mainnet
CRED402_ALGORAND_MAINNET_RELEASE_ACK=I_ACKNOWLEDGE_REAL_USDC_MAINNET_PAYMENTS
CRED402_PUBLIC_URL=https://cred402-1.onrender.com
CRED402_ALGORAND_INDEXER_URL=https://mainnet-idx.algonode.cloud
CRED402_DATA_DIR=/var/data            # must be a mounted persistent disk
```

`CRED402_ALGORAND_PAY_TO` is the only variable with no default, and its absence is the
current 503. Mainnet additionally refuses to enable without the matching `CRED402_ENV`,
the release acknowledgement, an HTTPS public origin, HTTPS facilitator and indexer, and a
durable `CRED402_DATA_DIR` — the last one because the payment-replay barrier and the
receipt projection must survive a restart.

Keep the receiver address stable. Discovery, dashboards, receipts, and rankings all key on
it, so rotating it fragments the history that the challenge measures.

### Then, in order

```bash
# 1. confirm the endpoint is live, on Mainnet, and correctly tagged
npm run x402:algorand:release-check -- \
  "https://cred402-1.onrender.com/v1/x402/credit-score/$CRED402_AGENT_ID"

# 2. one real external Mainnet payment (funded payer, interactive approval required)
npm run x402:algorand:pay -- --pay --mainnet \
  "https://cred402-1.onrender.com/v1/x402/credit-score/$CRED402_AGENT_ID"

# 3. confirm catalogue + attribution + leaderboard row
npm run x402:algorand:challenge-check
```

Step 2 requires a payer that is **not** the receiver; Mainnet readiness rejects
self-payment. Do not manufacture synthetic volume — one genuine end-to-end payment proves
settlement, and bot-shaped retry loops get filed under `dev`.

## Remaining owner actions

1. Set the environment variables above on Render and mount a persistent disk at
   `CRED402_DATA_DIR`. **This is the single blocker for every other item.**
2. Opt the receiving account into Mainnet USDC ASA `31566704` and fund it for minimum
   balance.
3. Fund an external payer account with Mainnet ALGO + USDC and run the one real payment.
4. Submit the entry form on the challenge page (deadline September 30).
5. Submit `https://github.com/caelum0x/cred402` to Electric Capital. The repository is
   already public and contains the Algorand code under `lib/x402/`, `api/`, `scripts/`,
   and `examples/algorand-paid-score/`.
6. Merge the working branch to `main` so the public default branch shows the tagged
   implementation.

## Landscape at time of writing

Measured from the live facilitator on 2026-09-16, Mainnet, 24-hour window:

- 2,024 resources in the Bazaar catalogue, 145 merchants;
- 23 merchants and 77 resources attributed to `x402-global-challenge`;
- outside the top few, attributed volume is small — ranked merchants with single-digit
  settlement counts and low-double-digit dollar volume.

The top 50 leaderboard slots are the pool from which 10 finalists are drawn, so
attributed presence matters more than raw volume at this stage — which is exactly why the
`extra.tag` fix and shipping before the October measurement window are the priority.

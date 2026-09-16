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

[`render.yaml`](../render.yaml) now carries the full Mainnet configuration: the
`mainnet` network/env pair, the Mainnet indexer, the pinned HTTPS public origin, and
`CRED402_DATA_DIR`.

It stays on the **free plan**, deliberately. Mainnet only requires `CRED402_DATA_DIR` to
be set, not to be a mounted disk, and the facilitator — not this service — is the system
of record for settlements, so Bazaar listing, settle counts and leaderboard standing
survive a restart. The accepted costs are that the replay barrier lives on the ephemeral
filesystem (a restart lets one spent proof replay once more, worth 0.01 USDC), that the
local usage projection resets on restart, and that cold starts can be slow enough to time
out a buyer's paid request — which costs volume, not eligibility. Attaching a disk at
`/var/data` on a paid plan fixes all three.

**Receiver address** (generated 2026-09-16, unfunded until activated):

```
M2MIOWWWAS2VKUNGOETPMBSCVLBRDRZ3NPGH3IB3U5BECX6YWPGGPQIUGY
```

Fund with ~0.3 ALGO and opt into USDC ASA `31566704` before setting it.

Two values are deliberately `sync: false` and must be typed into the Render dashboard:

```bash
CRED402_ALGORAND_PAY_TO=<58-char Mainnet address, opted into USDC ASA 31566704>
CRED402_ALGORAND_MAINNET_RELEASE_ACK=I_ACKNOWLEDGE_REAL_USDC_MAINNET_PAYMENTS
```

`CRED402_ALGORAND_PAY_TO` has no default, and its absence is the current 503. The
acknowledgement is a deliberate human gate on real-money mode, so its value is kept out
of source. Mainnet also refuses to enable without the matching `CRED402_ENV`, an HTTPS
public origin, HTTPS facilitator and indexer, and a durable `CRED402_DATA_DIR` — the last
because the payment-replay barrier and the receipt projection must survive a restart.
Full variable reference: [`ACTIVATION_CHECKLIST.md`](./ACTIVATION_CHECKLIST.md).

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

## Done

- Challenge tag moved to the attribution channel the facilitator actually reads, with
  the `x402-merchant` identity extension and enforcement in the client, the release gate,
  the tests, and both buyer examples.
- `render.yaml` made Mainnet-capable (disk, network/env pair, indexer, paid plan).
- Merged to `main` and pushed, so the public default branch shows the tagged
  implementation.
- Electric Capital taxonomy submission:
  [electric-capital/open-dev-data#2988](https://github.com/electric-capital/open-dev-data/pull/2988),
  validated against their parser before opening.

## Remaining owner actions

These need credentials, funds, or an identity that only the owner holds.

1. **Create or choose the Mainnet receiving account**, opt it into USDC ASA `31566704`,
   and fund it for minimum balance. Nothing else can proceed without this address.
2. **Apply the blueprint and set the two dashboard values** (`CRED402_ALGORAND_PAY_TO`,
   `CRED402_ALGORAND_MAINNET_RELEASE_ACK`). The Render CLI token on the build machine is
   expired — `render login` is an interactive browser flow.
3. **Fund an external payer** with Mainnet ALGO + USDC and run the one real payment.
   Payer must not be the receiver; Mainnet readiness rejects self-payment.
4. **Submit the entry form** on the challenge page — deadline September 30.

## Landscape at time of writing

Measured from the live facilitator on 2026-09-16, Mainnet, 24-hour window:

- 2,024 resources in the Bazaar catalogue, 145 merchants;
- 23 merchants and 77 resources attributed to `x402-global-challenge`;
- outside the top few, attributed volume is small — ranked merchants with single-digit
  settlement counts and low-double-digit dollar volume.

The top 50 leaderboard slots are the pool from which 10 finalists are drawn, so
attributed presence matters more than raw volume at this stage — which is exactly why the
`extra.tag` fix and shipping before the October measurement window are the priority.

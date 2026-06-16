# @cred402/sdk

Official TypeScript SDK for the Cred402 agent-credit protocol. Isomorphic
(global `fetch`), typed, with envelope unwrapping, bearer auth, idempotency, a
GraphQL helper, and webhook signature verification.

```ts
import { Cred402Client, motesToCspr } from "@cred402/sdk";

const c = new Cred402Client({ baseUrl: "http://localhost:4021", apiKey: "c402_..." });

const explain = await c.explainCredit("EvidenceSellerAgent");
console.log("line:", motesToCspr(explain.decision.credit_line), "CSPR");
for (const r of explain.decision.reason_codes ?? [])
  console.log(r.polarity === "positive" ? "+" : "-", r.code, r.detail);

// open + draw + repay
await c.openCreditLine("EvidenceSellerAgent");
await c.drawCredit("EvidenceSellerAgent", 6);
await c.repayCredit("EvidenceSellerAgent", 2);

// GraphQL one-shot
const data = await c.graphql<{ agents: { agent_id: string }[] }>(`{ agents { agent_id } }`);
```

Webhook receivers:

```ts
import { verifyWebhookSignature } from "@cred402/sdk";
const ok = verifyWebhookSignature({ secret, signatureHeader: req.headers["x-cred402-signature"], rawBody });
```

Covers every `/v1` route (agents, credit, marketplace, economics, analytics,
notifications, search, realfi, compliance, disputes, admin keys, webhooks) plus
`/graphql`. See `packages/openapi/cred402.v1.yaml` for the full contract.

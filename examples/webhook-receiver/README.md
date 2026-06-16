# Cred402 webhook receiver (example)

A real, runnable endpoint that receives Cred402 protocol webhooks and verifies
their HMAC-SHA256 signature with `@cred402/sdk`'s `verifyWebhookSignature`.

```bash
# 1. subscribe a webhook (note the returned `secret`)
curl -s -XPOST http://localhost:4021/v1/webhooks \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:4055/","events":["*"]}'

# 2. run the receiver with that secret
CRED402_WEBHOOK_SECRET=whsec_xxx npx tsx examples/webhook-receiver/server.ts

# 3. trigger protocol events
curl -s -XPOST http://localhost:4021/api/demo/run
```

The receiver prints `✓ VERIFIED <Event> {payload}` for each authentic delivery
and rejects tampered/stale signatures with `401`. Signatures use the
`X-Cred402-Signature: t=<ts>,v1=<hmac>` scheme over `${t}.${rawBody}` with a
5-minute replay window.

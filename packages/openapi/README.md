# @cred402/openapi

The OpenAPI 3.1 specification for the **Cred402 public REST API (`/v1`)**.

`cred402.v1.yaml` is the **contract** for the externally-versioned `/v1` API. It
is generated to match the real route definitions in `api/v1/router.ts`, the
gateway envelope in `lib/gateway/errors.ts`, the auth model in
`lib/gateway/index.ts`, and the response shapes in `lib/services/*`. Treat it as
the source of truth for clients and integrators.

## What it covers

Every `/v1` route the gateway serves:

- **System** — `GET /v1/health`
- **Agents** — `GET /v1/agents`, `POST /v1/agents`, `GET /v1/agents/{id}`,
  `GET /v1/agents/{id}/passport`, `GET /v1/agents/{id}/credit-line`,
  `GET /v1/agents/{id}/credit-explain`, `GET /v1/receipts`,
  `GET /v1/x402/receipts/{id}`
- **Compliance** — `GET /v1/compliance/agents/{id}`
- **Credit** — `GET /v1/credit/pool`, `POST /v1/credit/lines`,
  `POST /v1/credit/lines/{id}/draw`, `POST /v1/credit/lines/{id}/repay`
- **Analytics** — `GET /v1/economics`, `GET /v1/analytics`,
  `GET /v1/notifications`, `GET /v1/search`
- **Marketplace** — `GET /v1/marketplace`
- **Disputes** — `POST /v1/disputes`
- **RealFi** — `GET /v1/realfi`, `POST /v1/realfi/operators`,
  `POST /v1/realfi/fiat-receipts`
- **Admin** — `GET`/`POST /v1/admin/api-keys`, `GET`/`POST /v1/webhooks`

## Authentication

Provide a scoped API key either as a Bearer token
(`Authorization: Bearer <key>`) or via the `X-Api-Key` header. Scopes are
`read`, `write`, and `admin` (an `admin` key implicitly satisfies `read` and
`write`). Each operation's description documents the scope it requires.

## Response envelope

- Success: `{ "success": true, "data": <payload>, "request_id": "req_..." }`
- Failure: `{ "success": false, "error": { "code": "...", "message": "..." }, "request_id": "req_..." }`

Mutations (POSTs) accept an optional `Idempotency-Key` header for safe retries.

## Viewing the spec

Preview with Redoc:

```bash
npx @redocly/cli preview-docs packages/openapi/cred402.v1.yaml
```

Or render with Swagger UI:

```bash
npx swagger-ui-watcher packages/openapi/cred402.v1.yaml
```

## Linting / validating

```bash
npx @redocly/cli lint packages/openapi/cred402.v1.yaml
```

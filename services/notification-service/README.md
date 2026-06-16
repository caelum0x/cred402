# Cred402 Notification Service

A real, multi-channel notification delivery service for the Cred402 protocol
(see `PRODUCTION.md`). It consumes the protocol's notification feed and delivers
events to external channels — Slack, Discord, generic HMAC-signed webhooks, and
a built-in console — with per-event templates, severity/event-type routing
rules, dedupe, and per-channel retry with backoff.

Zero new dependencies: Node 20 built-ins only (`fetch`, `node:crypto`,
`node:http` via the platform) and `tsx` (already in the repo) to run.

## Architecture

```
GET /api/notifications ──► NotificationPoller ──► NotificationRouter ──► Channels
   (Cred402 API, :4021)      (tracks last seq)      (templates, routing,    ├─ console  (always on)
                                                     dedupe, retry)         ├─ slack
                                                                            ├─ discord
                                                                            └─ webhook (HMAC)
```

- **`src/types.ts`** — `Severity`, `Notification`, `RenderedMessage`,
  `Subscription`, `RoutingRule`, `RetryPolicy`.
- **`src/channels/channel.ts`** — the `Channel` interface
  (`name`, `send(msg): Promise<{ ok; detail? }>`).
- **`src/channels/webhook.ts`** — generic webhook; POSTs a JSON envelope signed
  with HMAC-SHA256 over `${timestamp}.${body}` (`x-cred402-signature` header).
  Exposes `sign` / `verifySignature` so receivers can reuse the exact scheme.
- **`src/channels/slack.ts`** — Slack incoming webhook; real Block Kit message
  (`text` + `blocks`) with a severity-colored attachment stripe.
- **`src/channels/discord.ts`** — Discord webhook; real `content` + rich `embed`
  with severity color and structured fields.
- **`src/channels/console.ts`** — always-available pretty colored output (TTY /
  `NO_COLOR` aware), so the service runs with no external config.
- **`src/templates.ts`** — per-event/severity templates producing a
  channel-agnostic `RenderedMessage` (title/body/color/emoji/fields). Covers
  credit approved/drawn/repaid/frozen/defaulted, dispute opened/verdict, stake
  slashed, protocol paused, operator verified, fiat receipt, and more; unknown
  events degrade gracefully. Also classifies events for routing filters.
- **`src/router.ts`** — `NotificationRouter`: registers channels, holds
  subscriptions (channel + min-severity + optional event-class filter), renders
  once, fans out to matching channels, dedupes by notification id, and retries
  per channel with exponential backoff + full jitter.
- **`src/poller.ts`** — `NotificationPoller`: polls `GET /api/notifications`,
  validates each record at the boundary, tracks the highest processed `seq`, and
  feeds new notifications (ascending seq) into the router.
- **`src/main.ts`** — entrypoint and wiring.

## Running

```bash
# From the repo root, with the Cred402 API running on :4021

# Deliver live (console + any configured external channels)
npx tsx services/notification-service/src/main.ts

# Poll once, deliver, exit (verification)
npx tsx services/notification-service/src/main.ts --once
```

### Environment

| Variable                 | Default                  | Purpose                                   |
| ------------------------ | ------------------------ | ----------------------------------------- |
| `CRED402_API`            | `http://localhost:4021`  | Base URL of the Cred402 API               |
| `SLACK_WEBHOOK_URL`      | _(unset)_                | Enable Slack delivery                     |
| `DISCORD_WEBHOOK_URL`    | _(unset)_                | Enable Discord delivery                   |
| `CRED402_WEBHOOK_URL`    | _(unset)_                | Enable generic HMAC webhook delivery      |
| `CRED402_WEBHOOK_SECRET` | _(unset)_                | HMAC secret for the generic webhook       |
| `NOTIFY_INTERVAL_MS`     | `2000`                   | Poll interval in ms                       |
| `NOTIFY_MIN_SEVERITY`    | `warning`                | Min severity for the external channels    |
| `NO_COLOR`               | _(unset)_                | Disable console ANSI color when set       |

The console channel always subscribes at `info` so every notification is
visible locally; external channels default to `warning` and above.

## Delivery semantics

- **Dedupe**: a notification id is delivered at most once (bounded
  insertion-ordered set); the poller's `seq` cursor is the first line of
  defense, the router's id set the second.
- **Retry**: each channel send is retried up to `maxAttempts` (default 3) with
  exponential backoff (`base * 2^n`, capped) and full jitter. Channels signal
  recoverable failures by resolving `{ ok: false, detail }` rather than throwing.
- **Routing**: a notification reaches a channel only if its severity ≥ the
  subscription threshold and (when set) its event class is in the allow-list.

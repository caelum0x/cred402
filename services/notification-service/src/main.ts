import { NotificationRouter, type DeliveryOutcome } from "./router.js";
import { NotificationPoller } from "./poller.js";
import { ConsoleChannel } from "./channels/console.js";
import { SlackChannel } from "./channels/slack.js";
import { DiscordChannel } from "./channels/discord.js";
import { WebhookChannel } from "./channels/webhook.js";
import type { Severity, Subscription } from "./types.js";

/**
 * Entrypoint for the Cred402 notification-service.
 *
 * Builds a router with the always-on console channel plus any configured
 * external channels (Slack/Discord/generic webhook), wires default
 * subscriptions, and polls the Cred402 API for new notifications, delivering
 * them live. `--once` polls a single time and exits — useful for verification.
 *
 * Environment:
 *   CRED402_API           Base API URL (default http://localhost:4021)
 *   SLACK_WEBHOOK_URL     Enable Slack delivery
 *   DISCORD_WEBHOOK_URL   Enable Discord delivery
 *   CRED402_WEBHOOK_URL   Enable generic HMAC webhook delivery
 *   CRED402_WEBHOOK_SECRET HMAC secret for the generic webhook (optional)
 *   NOTIFY_INTERVAL_MS    Poll interval in ms (default 2000)
 *   NOTIFY_MIN_SEVERITY   Min severity for external channels (default warning)
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const once = args.has("--once");

  const apiBaseUrl = process.env.CRED402_API ?? "http://localhost:4021";
  const intervalMs = parsePositiveInt(process.env.NOTIFY_INTERVAL_MS, 2000);
  const externalMinSeverity = parseSeverity(process.env.NOTIFY_MIN_SEVERITY, "warning");

  const router = new NotificationRouter();

  // Console is always available so the service is useful with zero config.
  router.registerChannel(new ConsoleChannel());
  const subscriptions: Subscription[] = [{ channel: "console", minSeverity: "info" }];

  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  if (slackUrl) {
    router.registerChannel(new SlackChannel({ webhookUrl: slackUrl, username: "Cred402" }));
    subscriptions.push({ channel: "slack", minSeverity: externalMinSeverity });
  }

  const discordUrl = process.env.DISCORD_WEBHOOK_URL;
  if (discordUrl) {
    router.registerChannel(new DiscordChannel({ webhookUrl: discordUrl, username: "Cred402" }));
    subscriptions.push({ channel: "discord", minSeverity: externalMinSeverity });
  }

  const webhookUrl = process.env.CRED402_WEBHOOK_URL;
  if (webhookUrl) {
    const secret = process.env.CRED402_WEBHOOK_SECRET;
    router.registerChannel(
      new WebhookChannel({
        url: webhookUrl,
        ...(secret !== undefined ? { secret } : {}),
      }),
    );
    subscriptions.push({ channel: "webhook", minSeverity: externalMinSeverity });
  }

  for (const sub of subscriptions) {
    router.subscribe(sub);
  }

  log(`notification-service starting`);
  log(`  api       ${apiBaseUrl}`);
  log(`  channels  ${router.channelNames().join(", ")}`);
  log(`  mode      ${once ? "once" : `poll every ${intervalMs}ms`}`);

  const poller = new NotificationPoller(router, {
    apiBaseUrl,
    intervalMs,
    onDelivered: reportDeliveries,
    onError: (error) => log(`poll error: ${error.message}`),
  });

  if (once) {
    const outcomes = await poller.pollOnce();
    if (outcomes.length === 0) {
      log("no new notifications to deliver");
    }
    log(`done (cursor seq=${poller.cursor})`);
    return;
  }

  poller.start();
  log("polling for live notifications — press Ctrl+C to exit");

  const shutdown = (): void => {
    log("shutting down");
    poller.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the event loop alive indefinitely while polling.
  await new Promise<void>(() => {});
}

function reportDeliveries(outcomes: ReadonlyArray<DeliveryOutcome>): void {
  const byChannel = new Map<string, { ok: number; failed: number }>();
  for (const o of outcomes) {
    const entry = byChannel.get(o.channel) ?? { ok: 0, failed: 0 };
    const next = o.ok ? { ok: entry.ok + 1, failed: entry.failed } : { ok: entry.ok, failed: entry.failed + 1 };
    byChannel.set(o.channel, next);
    if (!o.ok) {
      log(`delivery FAILED channel=${o.channel} id=${o.notificationId} attempts=${o.attempts} detail=${o.detail ?? ""}`);
    }
  }
  const summary = [...byChannel.entries()].map(([c, s]) => `${c}: ${s.ok} ok${s.failed ? `, ${s.failed} failed` : ""}`);
  if (summary.length > 0) {
    log(`delivered — ${summary.join(" · ")}`);
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseSeverity(value: string | undefined, fallback: Severity): Severity {
  const valid: ReadonlyArray<Severity> = ["info", "success", "warning", "critical"];
  return value !== undefined && (valid as ReadonlyArray<string>).includes(value) ? (value as Severity) : fallback;
}

function log(message: string): void {
  process.stderr.write(`[notify] ${message}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "fatal error";
  process.stderr.write(`[notify] fatal: ${message}\n`);
  process.exitCode = 1;
});

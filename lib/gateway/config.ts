/**
 * Production configuration (p2 §7.1).
 *
 * Loads and validates all runtime configuration from the environment ONCE at
 * startup and fails fast if a required value is missing or malformed. No config
 * is read ad-hoc elsewhere — everything flows from this typed object so behavior
 * is reproducible across dev / testnet / mainnet.
 */

export type Environment = "development" | "testnet" | "mainnet";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface GatewayConfig {
  env: Environment;
  port: number;
  logLevel: LogLevel;
  /** Persist ledger state + event log to this directory (empty = in-memory only). */
  dataDir: string;
  /** When true, mutating API routes require a valid API key. */
  authRequired: boolean;
  /** Master admin key used to mint scoped API keys (required when authRequired). */
  adminApiKey?: string;
  /** Per-key request budget per window. */
  rateLimit: { windowMs: number; maxRequests: number };
  /** Casper network the (future) casper-js-sdk transport targets. */
  casper: { nodeAddress: string; chainName: string };
  /** Webhook delivery signing secret + retry policy. */
  webhooks: { signingSecret?: string; maxRetries: number };
}

export class ConfigError extends Error {}

function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = process.env[key];
  if (v === undefined) return fallback;
  if (!allowed.includes(v as T)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(", ")} (got "${v}")`);
  }
  return v as T;
}

function readInt(key: string, fallback: number, min = 0): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${key} must be an integer >= ${min} (got "${v}")`);
  return n;
}

function readBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new ConfigError(`${key} must be a boolean (got "${v}")`);
}

let cached: GatewayConfig | null = null;

/** Load (and memoize) the validated gateway configuration. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  if (cached) return cached;
  const environment = readEnum("CRED402_ENV", ["development", "testnet", "mainnet"] as const, "development");
  const authRequired = readBool("CRED402_AUTH_REQUIRED", environment !== "development");
  const adminApiKey = env.CRED402_ADMIN_API_KEY;

  if (authRequired && !adminApiKey) {
    throw new ConfigError("CRED402_ADMIN_API_KEY is required when auth is enabled (CRED402_AUTH_REQUIRED=true)");
  }
  if (environment === "mainnet" && !env.CRED402_WEBHOOK_SECRET) {
    throw new ConfigError("CRED402_WEBHOOK_SECRET is required on mainnet");
  }

  cached = {
    env: environment,
    port: readInt("CRED402_PORT", 4021, 1),
    logLevel: readEnum("CRED402_LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
    dataDir: env.CRED402_DATA_DIR ?? "",
    authRequired,
    adminApiKey,
    rateLimit: {
      windowMs: readInt("CRED402_RATE_WINDOW_MS", 60_000, 1),
      maxRequests: readInt("CRED402_RATE_MAX", 120, 1),
    },
    casper: {
      nodeAddress: env.CRED402_CASPER_NODE ?? "https://node.testnet.casper.network",
      chainName: env.CRED402_CASPER_CHAIN ?? "casper-test",
    },
    webhooks: {
      signingSecret: env.CRED402_WEBHOOK_SECRET,
      maxRetries: readInt("CRED402_WEBHOOK_RETRIES", 5, 0),
    },
  };
  return cached;
}

/** Reset memoized config (tests / hot-reload). */
export function resetConfig(): void {
  cached = null;
}

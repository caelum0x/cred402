import type { LogLevel } from "./config.js";

/**
 * Structured JSON logger (p2 §7.1).
 *
 * Emits one JSON object per line (the format every log aggregator ingests), with
 * a level gate and bindable context (request id, route, api key id). Replaces
 * scattered `console.log` debugging with auditable, queryable server logs.
 */

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

class JsonLogger implements Logger {
  constructor(
    private readonly minLevel: LogLevel,
    private readonly context: Record<string, unknown> = {},
    private readonly sink: (line: string) => void = (l) => process.stdout.write(l + "\n"),
    private readonly now: () => number = () => Date.now(),
  ) {}

  private log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const record = {
      ts: new Date(this.now()).toISOString(),
      level,
      msg,
      ...this.context,
      ...redact(fields ?? {}),
    };
    this.sink(JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log("error", msg, fields);
  }
  child(context: Record<string, unknown>): Logger {
    return new JsonLogger(this.minLevel, { ...this.context, ...context }, this.sink, this.now);
  }
}

/** Field names whose values are redacted before logging (never log secrets). */
const SENSITIVE = /(secret|api[_-]?key|authorization|password|private|token)/i;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SENSITIVE.test(k) ? "[redacted]" : v;
  }
  return out;
}

export function createLogger(minLevel: LogLevel, context: Record<string, unknown> = {}): Logger {
  return new JsonLogger(minLevel, context);
}

import type { Channel } from "./channel.js";
import type { RenderedMessage, SendResult, Severity } from "../types.js";

/** Configuration for the console channel. */
export interface ConsoleConfig {
  /** Channel name; defaults to "console". */
  readonly name?: string;
  /**
   * Force-enable or force-disable ANSI color. When omitted, color is enabled
   * only when stdout is a TTY and NO_COLOR is not set.
   */
  readonly color?: boolean;
  /** Sink for output; defaults to process.stdout.write. Injectable for tests. */
  readonly write?: (line: string) => void;
}

const ANSI = {
  reset: "[0m",
  bold: "[1m",
  dim: "[2m",
} as const;

const SEVERITY_ANSI: Readonly<Record<Severity, string>> = {
  info: "[36m", // cyan
  success: "[32m", // green
  warning: "[33m", // yellow
  critical: "[31m", // red
};

/**
 * Console channel — always available, requires zero external configuration.
 *
 * Pretty colored single-block output so the service is useful out of the box
 * and verifiable with `--once`. Never fails: writing to a local stream does not
 * produce recoverable network errors, but any throw is still captured.
 */
export class ConsoleChannel implements Channel {
  public readonly name: string;
  private readonly useColor: boolean;
  private readonly write: (line: string) => void;

  constructor(config: ConsoleConfig = {}) {
    this.name = config.name ?? "console";
    this.write = config.write ?? ((line) => process.stdout.write(line));
    this.useColor = config.color ?? defaultColorEnabled();
  }

  async send(message: RenderedMessage): Promise<SendResult> {
    try {
      this.write(this.format(message) + "\n");
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, detail: error instanceof Error ? error.message : "console write failed" };
    }
  }

  private format(message: RenderedMessage): string {
    const color = this.useColor ? SEVERITY_ANSI[message.severity] : "";
    const reset = this.useColor ? ANSI.reset : "";
    const bold = this.useColor ? ANSI.bold : "";
    const dim = this.useColor ? ANSI.dim : "";

    const time = new Date(message.timestamp).toISOString();
    const tag = `[${message.severity.toUpperCase()}]`.padEnd(10);
    const header = `${color}${bold}${message.emoji} ${tag}${message.title}${reset}`;
    const meta = `${dim}seq ${message.seq} · ${time}${message.agentId ? ` · ${message.agentId}` : ""}${reset}`;

    const lines = [header, `  ${message.body}`, `  ${meta}`];
    for (const f of message.fields) {
      lines.push(`  ${dim}${f.label}:${reset} ${f.value}`);
    }
    return lines.join("\n");
  }
}

function defaultColorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  return process.stdout.isTTY === true;
}

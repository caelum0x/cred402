/**
 * KeeperHubClient — a thin client for KeeperHub's Streamable-HTTP MCP server. The
 * REAL path (active when `KEEPERHUB_API_KEY` is set) speaks MCP over HTTP to
 * `https://app.keeperhub.com/mcp` with `Authorization: Bearer kh_<key>` and invokes
 * KeeperHub's direct-execution tools:
 *
 *   • `execute_contract_call`      — state-changing call, with `simulate: true` preflight
 *   • `execute_transfer`           — native / ERC-20 transfer
 *   • `get_direct_execution_status`— poll an execution id to a tx hash + status
 *
 * The MCP SDK is imported dynamically so the sim path (no key) needs neither the
 * transport nor the network. Docs: https://docs.keeperhub.com/ai-tools/mcp-server
 */

const DEFAULT_MCP_URL = "https://app.keeperhub.com/mcp";

export interface KeeperHubToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export class KeeperHubClient {
  private readonly url: string;
  private readonly apiKey?: string;
  private client?: unknown; // lazily-connected MCP Client
  private connecting?: Promise<unknown>;

  constructor(opts: { url?: string; apiKey?: string } = {}) {
    this.url = opts.url ?? process.env.KEEPERHUB_API_URL ?? DEFAULT_MCP_URL;
    this.apiKey = opts.apiKey ?? process.env.KEEPERHUB_API_KEY;
  }

  /** True when a real KeeperHub credential is configured. */
  isLive(): boolean {
    return Boolean(this.apiKey);
  }

  private async connect(): Promise<unknown> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const transport = new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: {
          headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        },
      });
      const client = new Client({ name: "cred402", version: "0.1.0" }, { capabilities: {} });
      await client.connect(transport);
      this.client = client;
      return client;
    })().catch((err) => {
      // Never cache a rejected connect — a transient failure must not poison every
      // future call. Clear the memo so the next callTool retries the connection.
      this.connecting = undefined;
      throw err;
    });
    return this.connecting;
  }

  /** Invoke a KeeperHub MCP tool and return its parsed JSON payload. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.isLive()) throw new Error("keeperhub: no KEEPERHUB_API_KEY configured");
    const client = (await this.connect()) as {
      callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<KeeperHubToolResult>;
    };
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`keeperhub: tool ${name} returned an error`);
    if (res.structuredContent !== undefined) return res.structuredContent;
    const text = res.content?.find((c) => c.type === "text")?.text;
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  async close(): Promise<void> {
    const c = this.client as { close?: () => Promise<void> } | undefined;
    if (c?.close) await c.close();
    this.client = undefined;
    this.connecting = undefined;
  }
}

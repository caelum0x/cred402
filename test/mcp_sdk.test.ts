import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * p9 — the official MCP SDK server, exercised end to end by the official MCP
 * SDK client over a real stdio transport. This is a genuine MCP handshake
 * (initialize → capability negotiation → tools/list → tools/call), not a stub:
 * a subprocess server, real JSON-RPC framing, real protocol semantics.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function withClient(fn: (c: Client) => Promise<void>): Promise<void> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "mcp/server_sdk.ts"],
    cwd: root,
  });
  const client = new Client({ name: "cred402-test-client", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

test("p9 MCP SDK: real handshake lists the full tool registry", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 28, `expected the full registry, got ${tools.length}`);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("cred402.register_agent"), "cred402.register_agent must be exposed");
    // Every tool ships a JSON Schema for its inputs.
    for (const t of tools) assert.equal((t.inputSchema as { type?: string }).type, "object");
  });
});

test("p9 MCP SDK: tools/call dispatches to the real protocol via the SDK", async () => {
  await withClient(async (client) => {
    const res = (await client.callTool({ name: "cred402.get_risk_policy", arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    assert.ok(!res.isError, "cred402.get_risk_policy should not error");
    assert.equal(res.content[0]?.type, "text");
    const parsed = JSON.parse(res.content[0]!.text);
    assert.ok(Array.isArray(parsed) || typeof parsed === "object", "returns real protocol data");
  });
});

test("p9 MCP SDK: unknown tool returns a structured tool error", async () => {
  await withClient(async (client) => {
    const res = (await client.callTool({ name: "does_not_exist", arguments: {} })) as { isError?: boolean };
    assert.equal(res.isError, true);
  });
});

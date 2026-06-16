/**
 * Cred402 MCP server — official SDK transport (p9).
 *
 * The same tool + resource registry as the zero-dep `mcp/server.ts`, but served
 * through the official `@modelcontextprotocol/sdk` low-level `Server` over stdio.
 * This is the standards-compliant entry point real MCP clients (Claude Desktop,
 * MCP Inspector) connect to — same tools, real SDK framing, capability
 * negotiation, and error semantics handled by the SDK.
 *
 *   npx tsx mcp/server_sdk.ts
 *
 * Claude Desktop config:
 *   { "command": "npx", "args": ["tsx", "mcp/server_sdk.ts"], "cwd": "/path/to/cred402" }
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Cred402Economy } from "../agents/index.js";
import { TOOLS, TOOL_INDEX } from "./tools.js";
import { listResources, readResource } from "./resources.js";

const econ = new Cred402Economy();
econ.bootstrap();
econ.createJob();

const server = new Server(
  { name: "cred402-mcp", version: "0.1.0" },
  {
    capabilities: { tools: {}, resources: {} },
    instructions:
      "Cred402 is a credit, reputation and x402-receipt protocol for autonomous RWA agents on Casper. " +
      "Use the cred402.* tools to register agents, buy/sell evidence over x402, underwrite credit, draw/repay, and open disputes.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOL_INDEX.get(req.params.name);
  if (!tool) {
    return { isError: true, content: [{ type: "text" as const, text: `unknown tool: ${req.params.name}` }] };
  }
  try {
    const out = await tool.handler((req.params.arguments as Record<string, unknown>) ?? {}, econ);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text" as const, text: `error: ${(err as Error).message}` }] };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: listResources(econ) }));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const res = readResource(req.params.uri, econ);
  if (!res) throw new Error(`unknown resource: ${req.params.uri}`);
  return { contents: [{ uri: req.params.uri, mimeType: "application/json", text: res.text }] };
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  process.stderr.write(`cred402-mcp (official SDK) ready — ${TOOLS.length} tools\n`);
}

main().catch((err) => {
  process.stderr.write(`cred402-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});

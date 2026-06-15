/**
 * Cred402 MCP server (p2 §12).
 *
 * A Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0) that
 * lets any AI agent operate the Cred402 protocol: register, earn via x402, build
 * reputation, borrow, and dispute. Zero external dependencies — implements the MCP
 * wire protocol directly.
 *
 *   node --import tsx mcp/server.ts        # or: npx tsx mcp/server.ts
 *
 * Connect from an MCP client (e.g. Claude Desktop) with:
 *   { "command": "npx", "args": ["tsx", "mcp/server.ts"], "cwd": "/path/to/cred402" }
 */
import { createInterface } from "node:readline";
import { Cred402Economy } from "../agents/index.js";
import { TOOLS, TOOL_INDEX } from "./tools.js";
import { RESOURCE_TEMPLATES, readResource, listResources } from "./resources.js";

const SERVER_INFO = { name: "cred402-mcp", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

// One economy seeded so tools return meaningful data immediately.
const econ = new Cred402Economy();
econ.bootstrap();
econ.createJob();

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function result(id: RpcRequest["id"], res: unknown): void {
  send({ jsonrpc: "2.0", id, result: res });
}

function error(id: RpcRequest["id"], code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(req: RpcRequest): Promise<void> {
  const { id, method, params = {} } = req;
  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "Cred402 is a credit, reputation and x402-receipt protocol for autonomous RWA agents on Casper. Use the cred402.* tools to register agents, buy/sell evidence over x402, underwrite credit, draw/repay, and open disputes.",
      });

    case "notifications/initialized":
      return; // no response to notifications

    case "ping":
      return result(id, {});

    case "tools/list":
      return result(
        id,
        { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
      );

    case "tools/call": {
      const name = String(params.name);
      const tool = TOOL_INDEX.get(name);
      if (!tool) return error(id, -32602, `unknown tool: ${name}`);
      try {
        const out = await tool.handler((params.arguments as Record<string, unknown>) ?? {}, econ);
        return result(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (err) {
        return result(id, { isError: true, content: [{ type: "text", text: `error: ${(err as Error).message}` }] });
      }
    }

    case "resources/templates/list":
      return result(id, { resourceTemplates: RESOURCE_TEMPLATES });

    case "resources/list":
      return result(id, { resources: listResources(econ) });

    case "resources/read": {
      const uri = String(params.uri);
      const res = readResource(uri, econ);
      if (!res) return error(id, -32602, `unknown resource: ${uri}`);
      return result(id, { contents: [{ uri, mimeType: "application/json", text: res.text }] });
    }

    default:
      return error(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: RpcRequest;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return error(null, -32700, "parse error");
  }
  handle(req).catch((err) => error(req.id ?? null, -32603, (err as Error).message));
});

process.stderr.write(`cred402-mcp ready — ${TOOLS.length} tools, ${RESOURCE_TEMPLATES.length} resource templates\n`);

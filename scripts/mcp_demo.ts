/**
 * mcp_demo.ts — drives the Cred402 MCP server over stdio like a real MCP client,
 * showing an AI agent operating the protocol entirely through MCP tools.
 *
 *   pnpm mcp:demo
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("npx", ["tsx", "mcp/server.ts"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: child.stdout });

let id = 0;
const pending = new Map<number, (v: any) => void>();
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const res = pending.get(msg.id);
  if (res) {
    pending.delete(msg.id);
    res(msg);
  }
});

function call(method: string, params?: unknown): Promise<any> {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
}

function tool(name: string, args: Record<string, unknown> = {}) {
  return call("tools/call", { name, arguments: args }).then((r) => JSON.parse(r.result.content[0].text));
}

async function main(): Promise<void> {
  const init = await call("initialize", {});
  console.log(`▸ connected to ${init.result.serverInfo.name} (MCP ${init.result.protocolVersion})\n`);

  const tools = await call("tools/list");
  console.log(`▸ ${tools.result.tools.length} tools available\n`);

  console.log("▸ agent registers an evidence job and buys evidence over x402…");
  await tool("cred402.request_rwa_evidence", { requested_loan_cspr: 5000 });
  for (const t of ["energy_output", "weather_risk", "receivable_quality"]) {
    const r = await tool("cred402.submit_rwa_evidence", { evidence_type: t });
    console.log(`   ${t}: receipt ${r.receipt_id}`);
  }

  console.log("\n▸ explain the agent's credit score:");
  const score = await tool("cred402.explain_credit_score", { agent_id: "EvidenceSellerAgent" });
  console.log(`   credit_score ${score.credit_score}/100, line ${(Number(score.credit_line) / 1e9).toFixed(2)} CSPR, APR ${(score.interest_rate_bps / 100).toFixed(1)}%`);

  console.log("\n▸ passport via MCP resource:");
  const passport = await tool("cred402.get_agent_passport", { agent_id: "EvidenceSellerAgent" });
  console.log(`   ${passport.agent_id}: rep ${passport.reputation_score}, capabilities ${passport.capabilities.join(", ")}`);

  child.kill();
}

main().catch((e) => {
  console.error(e);
  child.kill();
  process.exit(1);
});

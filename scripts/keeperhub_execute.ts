/**
 * keeperhub_execute.ts — Cred402 × KeeperHub "The Last Mile".
 *
 * Push a decided on-chain action through KeeperHub's execution & reliability layer:
 * preflight simulation → smart gas with exponential backoff → MEV-protected private
 * routing → poll to a tx hash → audit trail, paid per-execution over x402/MPP.
 *
 * With KEEPERHUB_API_KEY set it drives the real KeeperHub MCP server
 * (https://app.keeperhub.com/mcp) and returns a real transaction; with no key it
 * runs the deterministic sim so the flow is always demonstrable.
 *
 *   npm run keeperhub:execute -- \
 *     --chain 114 --to 0xYourVault --fn "executeDraw(bytes32,address,uint256)"
 *
 * Env: KEEPERHUB_API_KEY, KEEPERHUB_API_URL, KEEPERHUB_GAS_SPONSORSHIP,
 *      KEEPERHUB_MPP_ONLY, KEEPERHUB_PRIVATE_ROUTING.
 */
import { KeeperHubExecutor } from "../lib/keeperhub/index.js";
import type { ExecutionIntent } from "../lib/keeperhub/index.js";
import { banner, scene } from "./render.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
  const intent: ExecutionIntent = {
    kind: "contract_call",
    chain_id: arg("chain", "114"), // Coston2
    to: arg("to", "0xf1a5e0" + "0".repeat(34)),
    function: arg("fn", "executeDraw(bytes32,address,uint256)"),
    args: [],
    label: arg("label", "cred402 keeperhub execution"),
    agent_id: arg("agent", "seller-agent"),
    metadata: { source: "keeperhub_execute.ts", trigger: "manual" },
  };

  const executor = new KeeperHubExecutor();
  banner("Cred402 × KeeperHub — the last mile");
  scene({
    scene: "Intent",
    lines: [
      `${intent.kind} on chain ${intent.chain_id} → ${intent.to}`,
      `fn ${intent.function}`,
      `KeeperHub live: ${executor.isLive()} (set KEEPERHUB_API_KEY for real execution)`,
    ],
  });

  const res = await executor.execute(intent);
  scene({
    scene: res.ok ? "Executed" : "Execution failed",
    lines: [
      `ok=${res.ok} source=${res.source}`,
      `tx ${res.tx_hash || "(none)"}`,
      `simulation ${res.simulation.ok ? "passed" : "failed"} gas-est ${res.simulation.gas_estimate ?? "n/a"}`,
      `gas ${res.gas.strategy} · backoff ${res.gas.attempts} · maxFee ${res.gas.max_fee_per_gas} wei · gas used ${res.gas_used ?? "n/a"}`,
      `payment ${res.payment.protocol} ${Number(res.payment.amount) / 1e6} ${res.payment.asset} on ${res.payment.network}`,
      `private routing ${res.private_routed} · sponsored ${res.sponsored}`,
      res.detail ? `detail: ${res.detail}` : "",
    ].filter(Boolean),
  });

  scene({ scene: "Reliability", lines: [JSON.stringify(executor.reliability())] });
  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * casper_health.ts — probe a live Casper node over JSON-RPC and render a real
 * contract-call deploy command. Demonstrates the production transport seam
 * (lib/casper): reads work with no SDK; writes need only an injected signer.
 *
 *   npm run casper:health
 *   CRED402_CASPER_NODE=https://rpc.testnet.casperlabs.io/rpc npm run casper:health
 */
import { CasperRpcClient, buildContractCall, toCasperClientCommand, arg } from "../lib/casper/index.js";
import { loadConfig } from "../lib/gateway/index.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const nodeAddress = process.env.CRED402_CASPER_NODE ?? cfg.casper.nodeAddress.replace(/\/?$/, "/rpc");
  console.log(`Probing Casper node: ${nodeAddress}`);

  const rpc = new CasperRpcClient({ nodeAddress, timeoutMs: 8000 });
  try {
    const status = await rpc.getNodeStatus();
    const root = await rpc.getStateRootHash();
    console.log(`  ✓ reachable — chain "${status.chainspec_name}", build ${status.build_version}`);
    console.log(`  ✓ state root hash: ${root.slice(0, 24)}…`);
  } catch (err) {
    console.log(`  ✗ node unreachable (${(err as Error).message}) — offline/throttled is expected in CI`);
  }

  // Build a real deploy spec for an AgentRegistry.register_agent call.
  const spec = buildContractCall({
    contractHash: "hash-1fa3bb653dab6d7b926c8a3501cd7c4ce4a1d5fc",
    entryPoint: "register_agent",
    args: [
      arg.string("agent_id", "weather-risk-agent-01"),
      arg.string("service_type", "rwa.weather_risk"),
      arg.string("agent_public_key", "0118e2…"),
    ],
    paymentMotes: 3_000_000_000n,
    chainName: cfg.casper.chainName,
    sender: "0118e2ad623bc974d0…",
  });
  console.log(`\nDeploy spec (${spec.entryPoint}, payment ${Number(spec.paymentMotes) / 1e9} CSPR):`);
  console.log(toCasperClientCommand(spec, { nodeAddress, secretKeyPath: "$CRED402_SECRET_KEY" }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

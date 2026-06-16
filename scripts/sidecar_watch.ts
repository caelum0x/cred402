/**
 * sidecar_watch.ts — stream live events from a Casper Sidecar (`/events` SSE).
 *
 * Wires `casper-network/casper-sidecar`: connect to a real Sidecar and print
 * decoded events + any contract-emitted messages (the production source for the
 * WatchdogAgent / indexer). Set CRED402_SIDECAR_URL, then:
 *
 *   CRED402_SIDECAR_URL=http://127.0.0.1:19999 npm run casper:sidecar
 *
 * Run a Sidecar against Testnet per casper-network/casper-sidecar USAGE.md.
 */
import { sidecarFromEnv, extractContractMessages } from "../lib/casper/sidecar.js";

async function main(): Promise<void> {
  const client = sidecarFromEnv();
  if (!client) {
    console.log("Sidecar not configured. Set CRED402_SIDECAR_URL (e.g. http://127.0.0.1:19999).");
    console.log("In-process EventBus remains the default event source.");
    return;
  }
  console.log(`Streaming Casper Sidecar events from ${process.env.CRED402_SIDECAR_URL}/events …\n`);
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  let count = 0;
  for await (const e of client.streamEvents(controller.signal)) {
    count++;
    const tag = e.id ? `#${e.id}` : `#${count}`;
    console.log(`${tag} ${e.kind}`);
    for (const m of extractContractMessages(e)) {
      console.log(`    contract ${m.entity_addr.slice(0, 24)}… topic=${m.topic_name} payload=${JSON.stringify(m.payload)}`);
    }
    if (e.kind === "Shutdown") console.log("    (node shutdown — Sidecar will attempt to reconnect)");
  }
}

main().catch((err) => {
  console.error("sidecar watch failed:", (err as Error).message);
  process.exit(1);
});

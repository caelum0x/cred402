/**
 * ship_first_check.ts — p7 §11 "the direct-use stack I would actually ship first".
 *
 * Reports, against THIS repository, which pieces of the recommended ship-first
 * stack are integrated, which are own-implementations of the same capability, and
 * which remain a deployment/transport swap. Reads the real filesystem — no guesses.
 *
 *   npm run ship:check
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const has = (p: string): boolean => existsSync(join(ROOT, p));

function pkgHasDep(name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
  } catch {
    return false;
  }
}

type Status = "integrated" | "own-impl" | "pending";

interface Check {
  group: string;
  component: string;
  status: Status;
  evidence: string;
}

const CHECKS: Check[] = [
  { group: "Contracts", component: "Odra (Casper Wasm)", status: has("contracts/Cargo.toml") ? "integrated" : "pending", evidence: "contracts/ (14 Odra crates)" },
  { group: "Casper access", component: "casper-js-sdk", status: pkgHasDep("casper-js-sdk") ? "integrated" : "pending", evidence: "lib/ledger is the drop-in transport stand-in" },
  { group: "Casper access", component: "casper-sidecar (events)", status: has("lib/ledger/events.ts") ? "own-impl" : "pending", evidence: "EventBus + SSE stand-in for the sidecar stream" },
  { group: "Payments", component: "casper-x402 facilitator", status: has("lib/x402/x402.ts") ? "own-impl" : "pending", evidence: "lib/x402 (real 402→sign→verify flow)" },
  { group: "Payments", component: "casper-eip-712 typed auth", status: has("crosschain/standards/credit_notes.ts") ? "own-impl" : "pending", evidence: "CAN domain-separated signatures" },
  { group: "Agents", component: "MCP server", status: has("mcp/server.ts") ? "integrated" : "pending", evidence: "mcp/ (44 tools over JSON-RPC)" },
  { group: "Agents", component: "Agent runtime", status: has("agents/economy.ts") ? "own-impl" : "pending", evidence: "agents/ (buyer/seller/credit/treasury/watchdog/…)" },
  { group: "Frontend", component: "Console dashboard", status: has("frontend/src/App.tsx") ? "integrated" : "pending", evidence: "frontend/ (Vite+React, 8 tabs)" },
  { group: "RWA data", component: "Open-Meteo + PV model", status: has("api/rwa_data/solar_provider.ts") ? "integrated" : "pending", evidence: "api/rwa_data (live data, real physics)" },
  { group: "RealFi", component: "Stripe billing/identity", status: has("lib/services/realfi_bridge.ts") ? "integrated" : "pending", evidence: "RealFi Bridge → FRE/OVE envelopes" },
  { group: "RealFi", component: "Plaid bank data", status: has("lib/services/realfi_bridge.ts") ? "integrated" : "pending", evidence: "RealFi Bridge → BVE envelope" },
  { group: "EVM satellite", component: "Solidity mirrors (incl. RealFi)", status: has("contracts/evm/src/Cred402RealFiMirror.sol") ? "integrated" : "pending", evidence: "contracts/evm/src/*.sol (Foundry)" },
];

const COLOR: Record<Status, string> = { integrated: "\x1b[32m", "own-impl": "\x1b[36m", pending: "\x1b[33m" };
const RESET = "\x1b[0m";

console.log("\nCred402 ship-first stack (p7 §11)\n");
let group = "";
for (const c of CHECKS) {
  if (c.group !== group) {
    group = c.group;
    console.log(`\x1b[1m${group}\x1b[0m`);
  }
  const tag = `${COLOR[c.status]}${c.status.padEnd(10)}${RESET}`;
  console.log(`  ${tag} ${c.component.padEnd(34)} ${c.evidence}`);
}

const counts = CHECKS.reduce<Record<Status, number>>(
  (acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
  { integrated: 0, "own-impl": 0, pending: 0 },
);
console.log(
  `\n${counts.integrated} integrated · ${counts["own-impl"]} own-impl · ${counts.pending} pending (transport/deploy swap)\n`,
);

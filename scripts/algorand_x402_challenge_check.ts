/**
 * Read-only Global x402 Challenge submission gate.
 *
 * Checks the five things the Algorand Foundation asks a submission to prove, against
 * live public data only: the deployment's own status probe, the GoPlausible Bazaar
 * catalogue, and the challenge leaderboard. It never signs, pays, or reads a key.
 *
 *   npm run x402:algorand:challenge-check
 *   npm run x402:algorand:challenge-check -- --api=https://api.example.com
 */
import { DEFAULT_ALGORAND_FACILITATOR, X402_CHALLENGE_TAG } from "../lib/x402/algorand_gateway.js";

const DEFAULT_API = "https://cred402-1.onrender.com";
const BAZAAR_PAGE_SIZE = 200;
const BAZAAR_MAX_PAGES = 25;
const LEADERBOARD_LIMIT = 100;

type CheckState = "pass" | "fail" | "blocked";

interface Check {
  readonly id: string;
  readonly requirement: string;
  readonly state: CheckState;
  readonly detail: string;
}

interface BazaarAccept {
  readonly network?: string;
  readonly asset?: string;
  readonly amount?: string;
  readonly payTo?: string;
  readonly extra?: Record<string, unknown> | null;
}

interface BazaarItem {
  readonly resourceUrl?: string;
  readonly method?: string;
  readonly description?: string;
  readonly accepts?: readonly BazaarAccept[];
  readonly settleCount?: number;
  readonly firstSeen?: string;
  readonly lastSeen?: string;
}

interface LeaderboardRow {
  readonly rank?: number;
  readonly sub?: string;
  readonly label?: string;
  readonly address?: string;
  readonly bazaar?: boolean;
  readonly challenge?: boolean;
  readonly volume?: number;
  readonly settles?: number;
}

interface DeploymentStatus {
  readonly configured?: boolean;
  readonly reason?: string;
  readonly network_name?: string;
  readonly network?: string;
  readonly usdc_asset?: string;
  readonly price_micro_usdc?: string;
  readonly pay_to?: string;
  readonly facilitator_url?: string;
  readonly public_origin?: string;
  readonly release_tier?: string;
  readonly paid_route?: string;
}

function readFlag(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return (match ? match.slice(prefix.length) : fallback).replace(/\/+$/, "");
}

async function getJson<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return (await response.json()) as T;
}

/** Walk the Bazaar catalogue and keep only the resources this deployment owns. */
async function findOwnBazaarResources(
  facilitatorUrl: string,
  payTo: string,
): Promise<{ readonly items: readonly BazaarItem[]; readonly catalogueSize: number }> {
  const owned: BazaarItem[] = [];
  let catalogueSize = 0;

  for (let page = 0; page < BAZAAR_MAX_PAGES; page += 1) {
    const offset = page * BAZAAR_PAGE_SIZE;
    const payload = await getJson<{
      items?: readonly BazaarItem[];
      pagination?: { total?: number };
    }>(`${facilitatorUrl}/discovery/resources?limit=${BAZAAR_PAGE_SIZE}&offset=${offset}`);

    const items = payload.items ?? [];
    catalogueSize = payload.pagination?.total ?? catalogueSize;
    owned.push(...items.filter((item) => (item.accepts ?? []).some((a) => a.payTo === payTo)));
    if (items.length < BAZAAR_PAGE_SIZE) break;
  }

  return { items: owned, catalogueSize };
}

async function findLeaderboardRow(
  facilitatorUrl: string,
  payTo: string,
  env: string,
): Promise<{ readonly row?: LeaderboardRow; readonly total: number }> {
  const payload = await getJson<{ items?: readonly LeaderboardRow[]; total?: number }>(
    `${facilitatorUrl}/data/leaderboards?cat=merchants&src=${X402_CHALLENGE_TAG}&env=${env}&limit=${LEADERBOARD_LIMIT}`,
  );
  const items = payload.items ?? [];
  return { row: items.find((item) => item.address === payTo), total: payload.total ?? items.length };
}

function render(checks: readonly Check[]): void {
  const symbol: Record<CheckState, string> = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED" };
  for (const check of checks) {
    console.log(`[${symbol[check.state].padEnd(7)}] ${check.requirement}`);
    console.log(`            ${check.detail}`);
  }
}

async function main(): Promise<void> {
  const api = readFlag("api", process.env.CRED402_PUBLIC_URL?.trim() || DEFAULT_API);
  const checks: Check[] = [];

  console.log(`Global x402 Challenge submission gate`);
  console.log(`Deployment: ${api}`);

  const status = await getJson<DeploymentStatus>(`${api}/v1/x402/algorand/status`).catch(
    (error: unknown) => {
      throw new Error(
        `Could not read ${api}/v1/x402/algorand/status: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );

  const facilitatorUrl = (status.facilitator_url ?? DEFAULT_ALGORAND_FACILITATOR).replace(/\/+$/, "");
  const isMainnet = status.network_name === "mainnet";
  // `--pay-to=` inspects catalogue/attribution for a receiver the deployment has not
  // published yet (or while the API host is asleep). Read-only either way.
  const payTo = readFlag("pay-to", status.pay_to ?? "") || undefined;

  // 1. Live on Algorand MainNet at a public HTTPS endpoint.
  if (!status.configured) {
    checks.push({
      id: "mainnet-live",
      requirement: "Live on Algorand MainNet at a public HTTPS endpoint",
      state: "fail",
      detail: `Paid endpoint is OFF: ${status.reason ?? "not configured"}. See docs/ACTIVATION_CHECKLIST.md.`,
    });
  } else {
    checks.push({
      id: "mainnet-live",
      requirement: "Live on Algorand MainNet at a public HTTPS endpoint",
      state: isMainnet && api.startsWith("https://") ? "pass" : "fail",
      detail: `network=${status.network_name} tier=${status.release_tier} route=${api}${status.paid_route} price=${status.price_micro_usdc} micro-USDC asset=${status.usdc_asset}`,
    });
  }

  // 2. GoPlausible facilitator with Bazaar discovery enabled.
  const usesGoPlausible = facilitatorUrl === DEFAULT_ALGORAND_FACILITATOR;
  checks.push({
    id: "facilitator",
    requirement: "Uses the GoPlausible facilitator with Bazaar discovery enabled",
    state: usesGoPlausible ? "pass" : "fail",
    detail: usesGoPlausible
      ? `${facilitatorUrl} (bazaar + x402-merchant extensions declared on the paid route)`
      : `Configured facilitator is ${facilitatorUrl}; the challenge requires ${DEFAULT_ALGORAND_FACILITATOR}`,
  });

  if (!payTo) {
    checks.push({
      id: "tag",
      requirement: `Includes the ${X402_CHALLENGE_TAG} tag`,
      state: "blocked",
      detail: "No receiver address published yet — activate the endpoint first.",
    });
    checks.push({
      id: "payment",
      requirement: "Has completed at least one real MainNet payment",
      state: "blocked",
      detail: "Blocked on activation.",
    });
    checks.push({
      id: "bazaar",
      requirement: "Appears in the Bazaar and on the competition leaderboard",
      state: "blocked",
      detail: "Blocked on activation.",
    });
    render(checks);
    process.exitCode = 1;
    return;
  }

  const { items: owned, catalogueSize } = await findOwnBazaarResources(facilitatorUrl, payTo);
  const tagged = owned.filter((item) =>
    (item.accepts ?? []).some((accept) => accept.extra?.tag === X402_CHALLENGE_TAG),
  );
  const settled = owned.reduce((sum, item) => sum + (item.settleCount ?? 0), 0);

  // 3. Challenge tag present on the catalogued resource.
  checks.push({
    id: "tag",
    requirement: `Includes the ${X402_CHALLENGE_TAG} tag`,
    state: owned.length > 0 && tagged.length === owned.length ? "pass" : owned.length === 0 ? "blocked" : "fail",
    detail:
      owned.length === 0
        ? `Not catalogued yet (Bazaar holds ${catalogueSize} resources); the tag is verified once the first payment settles.`
        : `${tagged.length}/${owned.length} catalogued resource(s) carry extra.tag=${X402_CHALLENGE_TAG}.`,
  });

  // 4. At least one real MainNet payment.
  checks.push({
    id: "payment",
    requirement: "Has completed at least one real MainNet payment",
    state: settled > 0 ? "pass" : "fail",
    detail:
      settled > 0
        ? `${settled} settlement(s) recorded by the facilitator; first seen ${owned[0]?.firstSeen ?? "unknown"}.`
        : "Facilitator has recorded no settlement for this receiver. Attribution is written at settlement time, so the tag must already be live before the first payment.",
  });

  // 5. Visible in the Bazaar and on the challenge leaderboard.
  // The challenge only ranks Mainnet. Fall back to it unless the deployment is
  // explicitly on Testnet, so an unconfigured probe still reports the real ranking.
  const env = status.network_name === "testnet" ? "testnet" : "mainnet";
  const { row, total } = await findLeaderboardRow(facilitatorUrl, payTo, env).catch(() => ({
    row: undefined,
    total: 0,
  }));
  checks.push({
    id: "bazaar",
    requirement: "Appears in the Bazaar and on the competition leaderboard",
    state: owned.length > 0 && row ? "pass" : "fail",
    detail: row
      ? `Bazaar: ${owned.length} resource(s). Leaderboard rank ${row.rank}/${total} (${row.settles} settles, $${row.volume}), challenge=${row.challenge}.`
      : `Bazaar: ${owned.length} resource(s). Not on the ${env} challenge merchant leaderboard (${total} ranked). Volume may be attributed to src=direct instead.`,
  });

  render(checks);
  console.log(`\nLeaderboard: ${facilitatorUrl}/dashboard/leaderboards`);
  if (checks.some((check) => check.state !== "pass")) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Challenge check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

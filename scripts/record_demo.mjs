/**
 * record_demo.mjs — record a real screencast of the LIVE Cred402 console
 * (https://cred402.vercel.app) driving the full protocol loop, then mux to MP4.
 *
 *   node scripts/record_demo.mjs
 *
 * Produces media/cred402-demo.webm (Playwright) → media/cred402-demo.mp4 (ffmpeg).
 */
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.CRED402_CONSOLE_URL ?? "https://cred402.vercel.app";
const OUT = "media";
const SIZE = { width: 1366, height: 768 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickTab(page, name, hold = 2600) {
  try {
    await page.getByRole("button", { name, exact: true }).first().click({ timeout: 5000 });
    await sleep(hold);
  } catch {
    console.log(`  (tab "${name}" not clickable, skipping)`);
  }
}

async function clickControl(page, name, hold = 3500) {
  try {
    await page.getByRole("button", { name }).first().click({ timeout: 5000 });
    await sleep(hold);
  } catch {
    console.log(`  (control "${name}" not clickable, skipping)`);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`Recording ${URL} …`);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: OUT, size: SIZE },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Note: the console holds an open SSE stream, so "networkidle" never fires.
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("load").catch(() => {});
  // Wait for live data to populate (Render may cold-start).
  try {
    await page.getByText("Loading on-chain state…").waitFor({ state: "detached", timeout: 75_000 });
  } catch {
    console.log("  (data still loading — recording anyway)");
  }
  await sleep(3500); // hold on the branded Analytics landing

  // Generate live activity — this streams events into the sidebar over SSE.
  await clickControl(page, /Run full loop/i, 5000);

  // Walk the protocol surfaces.
  for (const tab of ["Agents", "RWA Jobs", "Receipts", "Credit Pool", "x402", "Marketplace", "RealFi", "Multichain", "Trust", "Governance"]) {
    console.log(`  → ${tab}`);
    await clickTab(page, tab);
  }

  // Upgradable policy + accountability.
  await clickControl(page, /Upgrade policy/i, 3000);
  await clickControl(page, /Dispute & slash/i, 5000);

  // Land back on the analytics overview.
  await clickTab(page, "Analytics", 4000);

  await context.close(); // flushes the video
  await browser.close();

  // Rename the auto-named webm to a stable path.
  const webm = readdirSync(OUT).filter((f) => f.endsWith(".webm")).map((f) => join(OUT, f));
  const target = join(OUT, "cred402-demo.webm");
  if (webm.length) {
    const latest = webm.sort().pop();
    if (latest !== target) {
      if (existsSync(target)) {
        // keep only the newest
      }
      renameSync(latest, target);
    }
    console.log(`\nSaved ${target}`);
  } else {
    console.log("\n⚠ no video produced");
  }
}

main().catch((e) => {
  console.error("recording failed:", e.message);
  process.exit(1);
});

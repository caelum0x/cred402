/**
 * record_hackathon_demo.mjs — screen-record the LIVE Cred402 console driving the
 * KeeperHub + Flare hackathon features, then mux to MP4.
 *
 * Drives the Flare tab (KeeperHub-executed FXRP credit, keeper auto-deleverage, credit
 * automations, FTSO collateral, FAssets mint, autonomous scheduler) and the x402 tab
 * (pay-per-call credit-service marketplace), recording the whole run.
 *
 * Prereqs: a running console. For the NEW features record a LOCAL build:
 *   cd frontend && npm install && npm run build && cd ..
 *   npm run start                      # serves the built console on :4021
 *   CRED402_CONSOLE_URL=http://localhost:4021 npm run record:hackathon
 *
 * Produces media/cred402-hackathon-demo.webm (Playwright) → .mp4 (ffmpeg, if present).
 */
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const URL = process.env.CRED402_CONSOLE_URL ?? "http://localhost:4021";
const OUT = "media";
const SIZE = { width: 1440, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function click(page, name, hold = 3200) {
  try {
    await page.getByRole("button", { name }).first().click({ timeout: 6000 });
    await sleep(hold);
    return true;
  } catch {
    console.log(`  (button ${name} not found — skipping)`);
    return false;
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`Recording ${URL} …`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: OUT, size: SIZE }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("load").catch(() => {});
  await page.getByText("Loading on-chain state…").waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  await sleep(3000);

  // ── Flare tab: the KeeperHub × Flare stack ────────────────────────────────
  await click(page, /^Flare$/, 2500);
  console.log("  → Flare: KeeperHub-executed FXRP credit + keeper + automations + collateral + FAssets + scheduler");
  await click(page, /Run FXRP credit loop/i, 3500);
  await click(page, /Simulate margin call/i, 4000); // keeper auto-deleverage
  await click(page, /Set up sample automations/i, 4000); // automations fire
  await click(page, /Post collateral/i, 3800); // FTSO collateral expands borrowing power
  await click(page, /Mint .* XRP/i, 3800); // FAssets mint → collateralize
  await click(page, /run one tick/i, 3500); // autonomous scheduler tick
  await sleep(2500);

  // ── x402 tab: the pay-per-call credit-service marketplace ─────────────────
  await click(page, /^x402$/, 2500);
  console.log("  → x402: credit-service marketplace (402 → pay → 200)");
  await click(page, /buy \(402/i, 4000);
  await sleep(2500);

  // ── On-Chain tab: observability ───────────────────────────────────────────
  await click(page, /^On-Chain$/, 4000);
  await sleep(1500);

  await context.close(); // flush the video
  await browser.close();

  const webms = readdirSync(OUT).filter((f) => f.endsWith(".webm")).map((f) => join(OUT, f)).sort();
  const webm = webms.pop();
  if (!webm) {
    console.log("⚠ no video produced");
    return;
  }
  const target = join(OUT, "cred402-hackathon-demo.webm");
  if (webm !== target) renameSync(webm, target);
  console.log(`\nSaved ${target}`);

  // Mux to MP4 if ffmpeg is available.
  const mp4 = join(OUT, "cred402-hackathon-demo.mp4");
  const ff = spawnSync("ffmpeg", ["-y", "-i", target, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], { stdio: "ignore" });
  if (ff.status === 0 && existsSync(mp4)) console.log(`Muxed ${mp4}`);
  else console.log("(ffmpeg not available or failed — keep the .webm)");
}

main().catch((e) => {
  console.error("recording failed:", e.message);
  process.exit(1);
});

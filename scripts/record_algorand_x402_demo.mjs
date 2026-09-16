/**
 * record_algorand_x402_demo.mjs — screen-record the Algorand x402 paid-endpoint flow
 * for the Global x402 Challenge submission video.
 *
 * Records the console's Algorand x402 tab driving a REAL resource server: live
 * deployment metadata, a real unpaid 402 with its decoded PAYMENT-REQUIRED header,
 * every validation row, and finalized usage.
 *
 * Point it at a server that is actually configured, or the tab will (correctly)
 * render its not-configured state:
 *
 *   cd frontend && npm install && npm run build && cd ..
 *   CRED402_ALGORAND_PAY_TO=... CRED402_ALGORAND_NETWORK=mainnet CRED402_ENV=mainnet \
 *   CRED402_ALGORAND_MAINNET_RELEASE_ACK=I_ACKNOWLEDGE_REAL_USDC_MAINNET_PAYMENTS \
 *   CRED402_PUBLIC_URL=https://cred402-1.onrender.com \
 *   CRED402_ADMIN_API_KEY=... CRED402_WEBHOOK_SECRET=... npm start
 *
 *   CRED402_CONSOLE_URL=http://localhost:4021 npm run record:algorand
 *
 * Produces media/cred402-algorand-x402.webm → .mp4 (ffmpeg, if present).
 *
 * The browser never reads a key, signs, or pays — it only requests and validates
 * public metadata. Re-record after the first real Mainnet settlement so the usage
 * panel shows a finalized receipt instead of a measured zero.
 */
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const URL = process.env.CRED402_CONSOLE_URL ?? "http://localhost:4021";
const OUT = "media";
const BASE = "cred402-algorand-x402";
const SIZE = { width: 1920, height: 1080 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The 25-tab bar overflows 1920px, so clicking a right-hand tab scrolls the page
 * sideways and pushes content out of frame. Pin the horizontal offset back to 0. */
async function pinLeft(page) {
  await page.evaluate(() => {
    window.scrollTo({ left: 0, top: window.scrollY, behavior: "instant" });
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollLeft) el.scrollLeft = 0;
    }
  }).catch(() => {});
}

async function tab(page, name, hold = 2500) {
  try {
    await page.getByRole("button", { name, exact: false }).first().click({ timeout: 8000 });
    await pinLeft(page);
    await sleep(hold);
    return true;
  } catch {
    console.log(`  (tab "${name}" not found — skipping)`);
    return false;
  }
}

/** Slow, readable scroll so the recording does not jump. */
async function creep(page, total = 900, step = 110, pause = 420) {
  for (let y = 0; y < total; y += step) {
    await page.evaluate((d) => window.scrollBy({ top: d, left: 0, behavior: "instant" }), step);
    await pinLeft(page);
    await sleep(pause);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`Recording ${URL} …`);

  // Record into a dedicated directory. media/ already holds other .webm files, and
  // picking "some .webm in media/" would rename whichever one readdir happened to
  // return first -- which is exactly the bug this avoids.
  const rawDir = join(OUT, ".raw-algorand");
  rmSync(rawDir, { recursive: true, force: true });
  mkdirSync(rawDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: rawDir, size: SIZE },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(6000); // let the live event stream and first snapshot settle

  // 1. What is being underwritten: the agents, and the x402 receipts they earned.
  await tab(page, "Analytics", 9000);
  await creep(page, 900);
  await tab(page, "Agents", 9000);
  await creep(page, 800);
  await tab(page, "Receipts", 9000);
  await creep(page, 800);

  // 2. The decision those receipts produce, and the policy behind it.
  await tab(page, "Risk", 8000);
  await creep(page, 700);
  await tab(page, "Bureau", 8000);
  await creep(page, 700);

  // 3. x402 as a revenue source across chains, then Algorand specifically.
  await tab(page, "x402", 8000);
  await creep(page, 700);
  await tab(page, "Multichain", 7000);
  await creep(page, 600);

  // 4. The paid Algorand resource itself: network, asset, receiver, facilitator, tag.
  await tab(page, "Algorand x402", 9000);
  await creep(page, 500);
  await sleep(11000);

  // 5. A real unpaid request. Display-only: no key, no signature, no payment.
  const requested = await tab(page, "Request PAYMENT-REQUIRED", 11000);
  if (!requested) console.log("  (could not trigger the unpaid request)");
  await sleep(12000); // hold on the decoded challenge
  await creep(page, 1300, 110, 600); // walk the validation rows
  await sleep(10000);
  await creep(page, 700, 110, 560); // the raw 402 body and PAYMENT-REQUIRED decode
  await sleep(10000);

  // 6. Finalized usage, read from the usage API rather than asserted.
  await tab(page, "Refresh finalized receipts", 9000);
  await creep(page, 600);
  await sleep(9000);

  // 7. Close on the discovery surface other agents find this resource through.
  await tab(page, "Discovery", 8000);
  await creep(page, 700);
  await sleep(6000);

  await context.close();
  await browser.close();

  const webm = readdirSync(rawDir).filter((f) => f.endsWith(".webm"));
  if (!webm.length) {
    console.error("No video produced.");
    process.exitCode = 1;
    return;
  }
  const target = join(OUT, `${BASE}.webm`);
  if (existsSync(target)) rmSync(target);
  renameSync(join(rawDir, webm[0]), target);
  rmSync(rawDir, { recursive: true, force: true });
  console.log(`Wrote ${target}`);

  const mp4 = join(OUT, `${BASE}.mp4`);
  const ff = spawnSync(
    "ffmpeg",
    ["-y", "-i", target, "-c:v", "libx264", "-preset", "slow", "-crf", "20",
     "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4],
    { stdio: "ignore" },
  );
  console.log(ff.status === 0 ? `Wrote ${mp4}` : "ffmpeg unavailable — keeping .webm only");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

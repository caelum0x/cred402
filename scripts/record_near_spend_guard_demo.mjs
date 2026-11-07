/**
 * record_near_spend_guard_demo.mjs — screen-record the REAL terminal session
 * produced by `npm run demo:near-spend-guard` (builds the SpendGuard contract,
 * runs its 18 unit tests + the near-workspaces sandbox integration test, then
 * runs the live bonus loop against the real deployed public NEAR Testnet
 * contract `spendguard-024e8dd6f7.testnet`: authorize -> draw (25 real
 * `spend_to_seller` calls) -> repay -> top-up -> draw again on the SAME key
 * -> dispute spike -> freeze -> rejected post-freeze call), then renders it
 * into a real GIF and MP4.
 *
 * Uses asciinema (terminal recorder) + agg (asciicast -> GIF), the same
 * record-the-real-thing technique already used for Lander's trailer capture
 * (real captured output, no staged/fake terminal text).
 *
 *   npm run record:near-spend-guard
 *
 * Produces:
 *   media/cred402-near-spend-guard-demo.cast  (raw asciicast, source of truth)
 *   media/cred402-near-spend-guard-demo.gif   (agg, if installed)
 *   media/cred402-near-spend-guard-demo.mp4   (ffmpeg, if installed)
 *
 * Requires: `.secrets/near_spend_guard_credentials.json` (from a prior
 * `npm run near:spend-guard:deploy`), `asciinema` on PATH, optionally `agg`
 * and `ffmpeg` for the rendered GIF/MP4 (the .cast is kept either way — it is
 * real recorded terminal output and can always be rendered later).
 */
import { mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const OUT = "media";
const BASENAME = "cred402-near-spend-guard-demo";
const CAST = join(OUT, `${BASENAME}.cast`);
const GIF = join(OUT, `${BASENAME}.gif`);
const MP4 = join(OUT, `${BASENAME}.mp4`);

function run(label, command, args, opts = {}) {
  console.log(`\n=== ${label} (${command} ${args.join(" ")}) ===`);
  const result = spawnSync(command, args, { stdio: "inherit", ...opts });
  return result.status === 0;
}

function which(bin) {
  return spawnSync("which", [bin]).status === 0;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  if (!which("asciinema")) {
    console.error("asciinema not found on PATH — install it (brew install asciinema) and re-run.");
    process.exit(1);
  }

  const credentialsPath = ".secrets/near_spend_guard_credentials.json";
  if (!existsSync(credentialsPath)) {
    console.error(
      `${credentialsPath} missing — run \`npm run near:spend-guard:deploy\` first so the live-Testnet ` +
        "bonus loop (the part worth recording) actually runs.",
    );
    process.exit(1);
  }

  console.log(`Recording the REAL \`npm run demo:near-spend-guard\` run to ${CAST} ...`);
  const recorded = run("asciinema rec", "asciinema", [
    "rec",
    "--overwrite",
    "--command",
    "npm run demo:near-spend-guard",
    "--title",
    "Cred402 SpendGuard — live NEAR Testnet revolving-credit loop",
    CAST,
  ]);
  if (!recorded || !existsSync(CAST)) {
    console.error("asciinema recording failed or produced no .cast file — stopping (no fake footage).");
    process.exit(1);
  }
  console.log(`Wrote real asciicast: ${CAST}`);

  if (which("agg")) {
    const rendered = run("agg (asciicast -> GIF)", "agg", [
      CAST,
      GIF,
      "--speed",
      "1.6",
      "--idle-time-limit",
      "2",
      "--font-size",
      "16",
      "--cols",
      "120",
    ]);
    if (rendered && existsSync(GIF)) {
      console.log(`Wrote ${GIF}`);
      if (which("ffmpeg")) {
        const muxed = run("ffmpeg (GIF -> MP4)", "ffmpeg", [
          "-y",
          "-i",
          GIF,
          "-movflags",
          "+faststart",
          "-pix_fmt",
          "yuv420p",
          "-vf",
          "scale=trunc(iw/2)*2:trunc(ih/2)*2",
          MP4,
        ]);
        console.log(muxed && existsSync(MP4) ? `Wrote ${MP4}` : "ffmpeg mux failed — keeping the .gif only");
      } else {
        console.log("ffmpeg not available — keeping the .gif only");
      }
    } else {
      console.log("agg render failed — keeping the raw .cast only (play it with `asciinema play`)");
    }
  } else {
    console.log("agg not installed — keeping the raw .cast only (play it with `asciinema play`)");
  }

  console.log("\nrecord:near-spend-guard complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

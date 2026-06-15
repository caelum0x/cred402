/**
 * seed_demo_agents.ts — drive the running API server through the full loop so the
 * dashboard populates. Start the server first (`pnpm start`), then run this.
 *
 *   pnpm start          # terminal 1
 *   pnpm seed           # terminal 2
 */
const PORT = process.env.CRED402_PORT ?? "4021";
const BASE = `http://localhost:${PORT}`;

async function main(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/demo/run`, { method: "POST" });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const body = (await res.json()) as { scenes: { scene: string; lines: string[] }[] };
    console.log(`Seeded demo on ${BASE}\n`);
    for (const s of body.scenes) {
      console.log(`● ${s.scene}`);
      for (const l of s.lines) console.log(`   ${l}`);
    }
    console.log(`\nOpen the dashboard to explore the seeded state.`);
  } catch (err) {
    console.error(`Could not reach the API server at ${BASE}.`);
    console.error(`Start it with \`pnpm start\` (or \`npm start\`) first, then re-run \`pnpm seed\`.`);
    console.error(`Underlying error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();

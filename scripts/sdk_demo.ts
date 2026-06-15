/**
 * sdk_demo.ts — exercises @cred402/sdk against a running server.
 *   pnpm start            # terminal 1
 *   tsx scripts/sdk_demo.ts
 */
import { Cred402Client } from "../sdk/index.js";

async function main(): Promise<void> {
  const c = new Cred402Client({ baseUrl: process.env.CRED402_API ?? "http://localhost:4021", agentId: "sdk.buyer" });
  console.log(`SDK agent identity: ${c.keypair.publicKeyHex.slice(0, 18)}…`);

  const report = (await c.buyEvidence("energy_output")) as { report: { evidence_type: string; confidence: number; evidence_hash: string } };
  console.log(`buyEvidence -> ${report.report.evidence_type} (confidence ${report.report.confidence}) ${report.report.evidence_hash.slice(0, 16)}…`);

  const passport = await c.getPassport("EvidenceSellerAgent");
  console.log(`passport -> ${passport.agent_id} rep ${passport.reputation_score} caps [${passport.capabilities.join(", ")}]`);

  const gov = await c.getGovernance();
  console.log(`governance -> origination ${gov.params.origination_fee_bps}bps, min_rep ${gov.params.min_reputation_to_draw}`);

  const disputes = await c.getDisputes();
  console.log(`disputes on file: ${disputes.length}`);
}

main().catch((e) => {
  console.error(`SDK demo failed (is the server running?): ${e.message}`);
  process.exit(1);
});

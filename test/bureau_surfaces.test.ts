import { test } from "node:test";
import assert from "node:assert/strict";
import { ServerState } from "../api/state.js";
import { executeGraphQL } from "../lib/graphql/index.js";

/**
 * Cross-surface parity for the p3/p5/p6/p7/p10 services: the GraphQL resolvers and
 * the REST-router-backing ServerState methods must return the same service output.
 * ServerState is the canonical GraphQLDataSource, so this locks REST + GraphQL to
 * one implementation.
 */

function firstAgentId(s: ServerState): string {
  const a = s.ledger.agents.list()[0];
  assert.ok(a, "demo economy should seed at least one agent");
  return a.agent_id;
}

test("parity: ServerState exposes every new service method (REST router backing)", () => {
  const s = new ServerState();
  const id = firstAgentId(s);

  const check = s.creditCheck(id) as { exists: boolean; policy_version: string };
  assert.equal(check.exists, true);
  assert.ok(check.policy_version.length > 0);

  const batch = s.creditChecks([id, "ghost"]) as Array<{ exists: boolean }>;
  assert.equal(batch.length, 2);
  assert.equal(batch[1]!.exists, false);

  const risk = s.riskScoreV2(id) as { pd: number; blended_score: number };
  assert.ok(risk.pd >= 0 && risk.pd <= 1);
  assert.ok(risk.blended_score >= 0 && risk.blended_score <= 100);

  const commons = s.dataCommons() as { agents: { total: number }; by_category: unknown[] };
  assert.ok(commons.agents.total >= 1);
  assert.ok(Array.isArray(commons.by_category));

  assert.ok(Array.isArray(s.exposureReconciliation()));

  const exposure = s.agentExposure(id) as { global_headroom_motes: string };
  assert.equal(typeof exposure.global_headroom_motes, "string");

  const verticals = s.verticalProfiles() as Array<{ vertical: string }>;
  assert.ok(verticals.length >= 9);
  assert.equal((s.verticalProfile("compute") as { vertical: string }).vertical, "compute");
  assert.ok("error" in (s.verticalProfile("nope") as object));
});

test("parity: GraphQL resolves the new fields with the same answers as REST", async () => {
  const s = new ServerState();
  const id = firstAgentId(s);

  const res = await executeGraphQL(s, {
    query: `
      query($id: ID!) {
        creditCheck(agentId: $id)
        riskScore(agentId: $id)
        dataCommons
        exposure
        agentExposure(agentId: $id)
        verticals
        vertical(name: "inference")
      }
    `,
    variables: { id },
  });

  assert.equal(res.errors, undefined, JSON.stringify(res.errors));
  const data = res.data as Record<string, any>;

  // GraphQL answer matches the REST-backing method answer (one implementation).
  assert.equal(data.creditCheck.exists, (s.creditCheck(id) as { exists: boolean }).exists);
  assert.equal(data.riskScore.blended_score, (s.riskScoreV2(id) as { blended_score: number }).blended_score);
  assert.equal(data.dataCommons.agents.total, (s.dataCommons() as { agents: { total: number } }).agents.total);
  assert.ok(Array.isArray(data.exposure));
  assert.equal(typeof data.agentExposure.global_headroom_motes, "string");
  assert.ok(Array.isArray(data.verticals) && data.verticals.length >= 9);
  assert.equal(data.vertical.vertical, "inference");
});

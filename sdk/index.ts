/**
 * @cred402/sdk — a thin TypeScript client for the Cred402 protocol.
 *
 * Wraps the REST API, the x402 paid-evidence flow, and the SSE event stream so an
 * external agent (TS/Node) can integrate in a few lines:
 *
 *   const c = new Cred402Client("http://localhost:4021");
 *   const passport = await c.getPassport("EvidenceSellerAgent");
 *   const report = await c.buyEvidence("energy_output");   // full x402 dance
 */
import { generateAgentKeypair, signPayment, type AgentKeypair, type PaymentChallenge } from "../lib/x402/index.js";

export interface Cred402ClientOptions {
  baseUrl?: string;
  /** Identity used to sign x402 payment authorizations. A fresh one is generated if omitted. */
  keypair?: AgentKeypair;
  agentId?: string;
}

export class Cred402Client {
  readonly baseUrl: string;
  readonly keypair: AgentKeypair;
  readonly agentId: string;

  constructor(opts: Cred402ClientOptions | string = {}) {
    const o = typeof opts === "string" ? { baseUrl: opts } : opts;
    this.baseUrl = (o.baseUrl ?? "http://localhost:4021").replace(/\/$/, "");
    this.keypair = o.keypair ?? generateAgentKeypair();
    this.agentId = o.agentId ?? "sdk.agent";
  }

  // ---- reads ----
  getState() { return this.get("/api/state"); }
  getAgents() { return this.get("/api/agents"); }
  getPassports() { return this.get("/api/passports"); }
  getPassport(agentId: string) { return this.get(`/api/passport/${encodeURIComponent(agentId)}`); }
  getReceipts() { return this.get("/api/receipts"); }
  getCreditLine(agentId: string) { return this.get("/api/pool").then((p: any) => p.creditLines.find((l: any) => l.agent_id === agentId)); }
  getDisputes() { return this.get("/api/disputes"); }
  getGovernance() { return this.get("/api/governance"); }
  getAssets() { return this.get("/api/assets"); }
  getRiskPolicy() { return this.get("/api/health"); }

  // ---- actions ----
  runDemo(dispute = false) { return this.post(dispute ? "/api/demo/dispute" : "/api/demo/run"); }
  openDispute(body: { dispute_type: string; respondent_agent: string; note?: string; receipt_id?: string }) {
    return this.post("/api/disputes/open", body);
  }
  setGovernanceParam(key: string, value: unknown) { return this.post("/api/governance/param", { key, value }); }
  upgradePolicy(version: string) { return this.post("/api/policy/upgrade", { version }); }

  /**
   * The full x402 flow: GET the paid endpoint, sign the challenge, retry, return
   * the signed report. Mirrors `scripts/x402_client.ts` as a reusable method.
   */
  async buyEvidence(evidenceType: string, rwaId = "SOLAR-A17"): Promise<unknown> {
    const url = `${this.baseUrl}/verify/${evidenceType}?rwa_id=${rwaId}&buyer=${encodeURIComponent(this.agentId)}`;
    const challengeRes = await fetch(url);
    if (challengeRes.status !== 402) throw new Error(`expected 402, got ${challengeRes.status}`);
    const { challenge } = (await challengeRes.json()) as { challenge: PaymentChallenge };
    const { header } = signPayment({
      challenge,
      payer_agent: this.agentId,
      payer_public_key: this.keypair.publicKeyHex,
      payer_private_pem: this.keypair.privatePem,
    });
    const paid = await fetch(url, { headers: { "X-Payment": header } });
    if (!paid.ok) throw new Error(`payment failed: ${paid.status}`);
    return paid.json();
  }

  /** Subscribe to the SSE event stream (browser or Node 18+ with EventSource). */
  watchEvents(onEvent: (e: unknown) => void): () => void {
    const ES = (globalThis as { EventSource?: typeof EventSource }).EventSource;
    if (!ES) throw new Error("EventSource not available in this runtime");
    const es = new ES(`${this.baseUrl}/api/events/stream`);
    es.addEventListener("chain", (ev) => onEvent(JSON.parse((ev as MessageEvent).data)));
    return () => es.close();
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
  }
  private async post(path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
  }
}

export { generateAgentKeypair } from "../lib/x402/index.js";

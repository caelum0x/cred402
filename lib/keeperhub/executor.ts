import { keccak256 } from "../x402/evm.js";
import { KeeperHubClient } from "./client.js";
import { SmartGasEstimator } from "./gas.js";
import { PaymentRouter } from "./payments.js";
import { AuditTrail } from "./audit.js";
import type {
  AuditRecord,
  ExecutionIntent,
  ExecutionResult,
  GasEstimate,
  OnchainExecutor,
  SimulationResult,
} from "./types.js";

/**
 * KeeperHubExecutor — the last mile. An agent decides; this pushes the decided
 * transaction on-chain through KeeperHub with the full reliability envelope:
 *
 *   pay-per-execution (x402 / MPP)  →  simulate (preflight)  →  smart gas w/ backoff
 *   →  private / MEV-protected submit  →  poll to a tx hash  →  audit trail
 *
 * Live path (KEEPERHUB_API_KEY set): drives KeeperHub's `execute_contract_call`
 * (`simulate:true` then broadcast) and `get_direct_execution_status`, honoring the
 * `upstream_cold_start` retry hint with a reused idempotency key. Sim path:
 * deterministic, so the loop runs with no key and no chain — same ExecutionResult
 * shape either way.
 */
export interface KeeperHubExecutorOptions {
  client?: KeeperHubClient;
  gas?: SmartGasEstimator;
  payments?: PaymentRouter;
  audit?: AuditTrail;
  /** MEV-protected private submission. Default true (KEEPERHUB_PRIVATE_ROUTING=0 disables). */
  privateRouting?: boolean;
  /** Base fee (wei) seed for the sim/record gas math. Default 1 gwei. */
  baseFeeWei?: bigint;
  priorityFeeWei?: bigint;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_GAS_LIMIT = 120_000;

export class KeeperHubExecutor implements OnchainExecutor {
  private readonly client: KeeperHubClient;
  private readonly gas: SmartGasEstimator;
  private readonly payments: PaymentRouter;
  private readonly audit: AuditTrail;
  private readonly privateRouting: boolean;
  private readonly baseFeeWei: bigint;
  private readonly priorityFeeWei: bigint;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private seq = 0;

  constructor(opts: KeeperHubExecutorOptions = {}) {
    this.client = opts.client ?? new KeeperHubClient();
    this.gas = opts.gas ?? new SmartGasEstimator();
    this.payments = opts.payments ?? new PaymentRouter();
    this.audit = opts.audit ?? new AuditTrail();
    this.privateRouting = opts.privateRouting ?? (process.env.KEEPERHUB_PRIVATE_ROUTING !== "0");
    this.baseFeeWei = opts.baseFeeWei ?? 1_000_000_000n;
    this.priorityFeeWei = opts.priorityFeeWei ?? 1_000_000n;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  isLive(): boolean {
    return this.client.isLive();
  }

  auditTrail(): AuditRecord[] {
    return this.audit.list();
  }

  auditFor(agentId: string): AuditRecord[] {
    return this.audit.list(agentId);
  }

  reliability() {
    return this.audit.summary();
  }

  async execute(intent: ExecutionIntent): Promise<ExecutionResult> {
    this.seq += 1;
    const idempotencyKey = keccak256(`kh:${intent.label}:${intent.chain_id}:${this.seq}:${this.now()}`);
    const execution_id = idempotencyKey.slice(0, 34);
    const payment = this.payments.settle(intent);

    // 1) Preflight simulation.
    const simulation = await this.simulate(intent);
    const gas = this.gas.estimate(
      { base_fee_wei: this.baseFeeWei, priority_fee_wei: this.priorityFeeWei, gas_limit: simulation.gas_estimate ?? DEFAULT_GAS_LIMIT },
      0,
    );

    const baseRecord: AuditRecord = {
      audit_id: keccak256(`audit:${execution_id}`).slice(0, 34),
      execution_id,
      agent_id: intent.agent_id,
      chain_id: intent.chain_id,
      intent_kind: intent.kind,
      label: intent.label,
      trigger: { kind: intent.kind, to: intent.to, function: intent.function, ...intent.metadata },
      simulation,
      gas,
      payment,
      private_routed: this.privateRouting,
      sponsored: payment.protocol === "sponsored",
      tx_hash: "",
      status: "simulated",
      submitted_at: this.now(),
    };

    if (!simulation.ok) {
      const rec = this.audit.append({ ...baseRecord, status: "failed", detail: simulation.revert_reason });
      return this.toResult(rec, false, simulation.source, simulation.revert_reason);
    }

    // 2) Submit (private routing) — live via KeeperHub, else deterministic sim.
    if (this.isLive()) {
      return this.submitLive(intent, baseRecord, idempotencyKey);
    }
    const tx_hash = keccak256(`khtx:${execution_id}:${intent.to}`);
    const rec = this.audit.append({
      ...baseRecord,
      tx_hash,
      status: "confirmed",
      gas_used: Math.round((gas.gas_limit * 82) / 100),
      confirmed_at: this.now(),
    });
    return this.toResult(rec, true, "sim");
  }

  // -- internals -----------------------------------------------------------

  private async simulate(intent: ExecutionIntent): Promise<SimulationResult> {
    if (!this.isLive()) {
      return { ok: true, gas_estimate: DEFAULT_GAS_LIMIT, source: "sim" };
    }
    try {
      const out = (await this.client.callTool("execute_contract_call", {
        chain_id: intent.chain_id,
        contract_address: intent.to,
        function: intent.function,
        args: intent.args ?? [],
        simulate: true,
      })) as { gas_estimate?: number; gasEstimate?: number; revert_reason?: string; error?: string };
      const gas_estimate = out.gas_estimate ?? out.gasEstimate;
      const revert = out.revert_reason ?? out.error;
      return { ok: !revert, gas_estimate, revert_reason: revert, source: "keeperhub" };
    } catch (err) {
      return { ok: false, revert_reason: (err as Error).message, source: "keeperhub" };
    }
  }

  /** Broadcast + poll to a tx hash, honoring KeeperHub's cold-start retry hint. */
  private async submitLive(intent: ExecutionIntent, base: AuditRecord, idempotencyKey: string): Promise<ExecutionResult> {
    try {
      const submit = (await this.client.callTool("execute_contract_call", {
        chain_id: intent.chain_id,
        contract_address: intent.to,
        function: intent.function,
        args: intent.args ?? [],
        private: this.privateRouting,
        idempotency_key: idempotencyKey,
      })) as { execution_id?: string; executionId?: string };
      const executionId = submit.execution_id ?? submit.executionId ?? base.execution_id;
      const rec = this.audit.append({ ...base, execution_id: executionId, status: "submitted" });

      for (let attempt = 0; attempt < this.gas.maxAttempts; attempt++) {
        const status = (await this.client.callTool("get_direct_execution_status", {
          execution_id: executionId,
        })) as { status?: string; tx_hash?: string; txHash?: string; gas_used?: number; error_code?: string; retryAfterSeconds?: number };

        if (status.error_code === "upstream_cold_start") {
          await this.sleep((status.retryAfterSeconds ?? 2) * 1000);
          continue;
        }
        const txHash = status.tx_hash ?? status.txHash;
        if ((status.status === "confirmed" || status.status === "success") && txHash) {
          const confirmed = this.audit.confirm(rec.audit_id, {
            gas_used: status.gas_used,
            confirmed_at: this.now(),
            tx_hash: txHash,
          })!;
          return this.toResult(confirmed, true, "keeperhub");
        }
        if (status.status === "failed" || status.status === "reverted") {
          const failed = this.audit.fail(rec.audit_id, { confirmed_at: this.now(), detail: "execution reverted" })!;
          return this.toResult(failed, false, "keeperhub", "execution reverted");
        }
        await this.sleep(this.gas.retryDelayMs(attempt));
      }
      const timedOut = this.audit.fail(rec.audit_id, { confirmed_at: this.now(), detail: "timed out polling execution status" })!;
      return this.toResult(timedOut, false, "keeperhub", "timed out polling execution status");
    } catch (err) {
      const failed = this.audit.append({ ...base, status: "failed", detail: (err as Error).message });
      return this.toResult(failed, false, "keeperhub", (err as Error).message);
    }
  }

  private toResult(rec: AuditRecord, ok: boolean, source: "keeperhub" | "sim", detail?: string): ExecutionResult {
    return {
      ok,
      execution_id: rec.execution_id,
      tx_hash: rec.tx_hash,
      audit_id: rec.audit_id,
      simulation: rec.simulation,
      gas: rec.gas,
      payment: rec.payment,
      private_routed: rec.private_routed,
      sponsored: rec.sponsored,
      gas_used: rec.gas_used,
      source,
      detail: detail ?? rec.detail,
    };
  }
}

export type { GasEstimate };

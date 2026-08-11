import { keccak256 } from "../x402/evm.js";
import type { ExecutionIntent, PaymentProtocol, PaymentReceipt } from "./types.js";

/**
 * PaymentRouter — pay-per-execution over KeeperHub's two rails, indexed on
 * x402scan.com when settled on Base:
 *
 *   • x402  — Base USDC, EIP-3009 `TransferWithAuthorization` (the default rail)
 *   • MPP   — Tempo USDC.e, an authorization the MPP facilitator settles
 *
 * KeeperHub's agentic wallet pays via x402 by default and uses MPP when a workflow
 * is MPP-only; a paid `call_workflow` returns an HTTP 402 challenge the wallet
 * settles server-side, then the call retries transparently. On mainnet Ethereum
 * KeeperHub can sponsor gas, so an execution can settle at zero cost to the agent.
 *
 * This models that selection deterministically (real settlement stays server-side
 * inside KeeperHub's wallet). Docs: https://docs.keeperhub.com/ai-tools/agentic-wallet
 */

/** An HTTP 402 pay-per-execution challenge as returned by a paid workflow call. */
export interface PaymentChallenge {
  /** Protocols the workflow will accept, in server preference order. */
  accepts: PaymentProtocol[];
  /** Price in the asset's smallest unit (USDC/USDC.e are 6 dp). */
  amount: string;
  asset: string;
  network: string;
  pay_to?: string;
}

export interface PaymentRouterOptions {
  /** Per-execution price in USDC/USDC.e smallest units (6 dp). Default 10000 = $0.01. */
  pricePerExecution?: string;
  /** Force MPP (workflow is MPP-only). Default false → x402 preferred. */
  mppOnly?: boolean;
  /** KeeperHub gas sponsorship (mainnet Ethereum). Default false. */
  sponsorship?: boolean;
}

const ETHEREUM_MAINNET = "1";

export class PaymentRouter {
  private readonly price: string;
  private readonly mppOnly: boolean;
  private readonly sponsorship: boolean;

  constructor(opts: PaymentRouterOptions = {}) {
    this.price = opts.pricePerExecution ?? "10000"; // $0.01 USDC
    this.mppOnly = opts.mppOnly ?? (process.env.KEEPERHUB_MPP_ONLY === "1");
    this.sponsorship = opts.sponsorship ?? (process.env.KEEPERHUB_GAS_SPONSORSHIP === "1");
  }

  /** Decide which rail settles this execution and produce its receipt. */
  settle(intent: ExecutionIntent): PaymentReceipt {
    // Gas sponsorship (mainnet Ethereum) → the agent pays nothing.
    if (this.sponsorship && intent.chain_id === ETHEREUM_MAINNET) {
      return {
        protocol: "sponsored",
        amount: "0",
        asset: "ETH",
        network: "ethereum",
        payment_proof: keccak256(`kh-sponsor:${intent.label}:${intent.chain_id}`),
        detail: "gas sponsored by KeeperHub on mainnet Ethereum",
      };
    }
    const protocol: PaymentProtocol = this.mppOnly ? "mpp" : "x402";
    if (protocol === "mpp") {
      return {
        protocol: "mpp",
        amount: this.price,
        asset: "USDC.e",
        network: "tempo",
        payment_proof: keccak256(`mpp:${intent.label}:${intent.chain_id}:${this.price}`),
        detail: "settled via MPP facilitator on Tempo",
      };
    }
    return {
      protocol: "x402",
      amount: this.price,
      asset: "USDC",
      network: "base",
      payment_proof: keccak256(`x402:${intent.label}:${intent.chain_id}:${this.price}`),
      detail: "settled via x402 (EIP-3009 TransferWithAuthorization) on Base; indexed on x402scan.com",
    };
  }
}

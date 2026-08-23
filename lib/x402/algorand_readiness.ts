import type { AccountInformation } from "@algorandfoundation/algokit-utils";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { isValidAlgorandAddress } from "@x402/avm";
import type { AlgorandClientNetwork } from "./algorand_client.js";
import { formatMicroUsdc } from "./algorand_client.js";

export type AlgorandAccountRole = "payer" | "receiver";

export interface AlgorandAccountSnapshot {
  address: string;
  balanceMicroAlgo: bigint;
  minimumBalanceMicroAlgo: bigint;
  validAsOfRound: bigint;
  usdcOptedIn: boolean;
  usdcFrozen: boolean;
  usdcBalanceMicro: bigint;
}

export interface AlgorandReadinessCheck {
  id: "minimum_balance" | "fee_buffer" | "usdc_opt_in" | "usdc_not_frozen" | "usdc_balance";
  ok: boolean;
  required: boolean;
  message: string;
}

export interface AlgorandAccountReadiness {
  role: AlgorandAccountRole;
  ready: boolean;
  snapshot: AlgorandAccountSnapshot;
  checks: AlgorandReadinessCheck[];
}

export const RECOMMENDED_FEE_BUFFER_MICRO_ALGO = 1_000n;

export function assertExternalMainnetPayer(
  networkName: AlgorandClientNetwork,
  payer: string,
  receiver: string,
): void {
  if (networkName === "mainnet" && payer === receiver) {
    throw new Error(
      "Mainnet payer and receiver must be different addresses; self-payment is not a valid activation test",
    );
  }
}

export function formatMicroAlgo(amount: bigint): string {
  if (amount < 0n) return `-${formatMicroUsdc((-amount).toString())}`;
  return formatMicroUsdc(amount.toString());
}

export function accountSnapshot(
  info: AccountInformation,
  usdcAssetId: string,
): AlgorandAccountSnapshot {
  const assetId = BigInt(usdcAssetId);
  const holding = info.assets?.find((asset) => asset.assetId === assetId);
  return {
    address: info.address.toString(),
    balanceMicroAlgo: info.balance.microAlgos,
    minimumBalanceMicroAlgo: info.minBalance.microAlgos,
    validAsOfRound: info.validAsOfRound,
    usdcOptedIn: holding !== undefined,
    usdcFrozen: holding?.isFrozen ?? false,
    usdcBalanceMicro: holding?.amount ?? 0n,
  };
}

export function assessAlgorandAccountReadiness(
  snapshot: AlgorandAccountSnapshot,
  role: AlgorandAccountRole,
  requiredPaymentMicroUsdc: bigint,
): AlgorandAccountReadiness {
  if (requiredPaymentMicroUsdc <= 0n) throw new Error("Required payment must be positive");
  const spendableMicroAlgo = snapshot.balanceMicroAlgo - snapshot.minimumBalanceMicroAlgo;
  const checks: AlgorandReadinessCheck[] = [
    {
      id: "minimum_balance",
      ok: snapshot.balanceMicroAlgo >= snapshot.minimumBalanceMicroAlgo,
      required: true,
      message: `${formatMicroAlgo(snapshot.balanceMicroAlgo)} ALGO balance; ${formatMicroAlgo(snapshot.minimumBalanceMicroAlgo)} ALGO minimum`,
    },
    {
      id: "usdc_opt_in",
      ok: snapshot.usdcOptedIn,
      required: true,
      message: snapshot.usdcOptedIn ? "USDC ASA opted in" : "USDC ASA opt-in missing",
    },
    {
      id: "usdc_not_frozen",
      ok: snapshot.usdcOptedIn && !snapshot.usdcFrozen,
      required: true,
      message: snapshot.usdcFrozen ? "USDC holding is frozen" : "USDC holding is not frozen",
    },
  ];

  if (role === "payer") {
    checks.push(
      {
        id: "usdc_balance",
        ok: snapshot.usdcBalanceMicro >= requiredPaymentMicroUsdc,
        required: true,
        message: `${formatMicroUsdc(snapshot.usdcBalanceMicro.toString())} USDC available; ${formatMicroUsdc(requiredPaymentMicroUsdc.toString())} USDC required`,
      },
      {
        id: "fee_buffer",
        ok: spendableMicroAlgo >= RECOMMENDED_FEE_BUFFER_MICRO_ALGO,
        required: false,
        message: `${formatMicroAlgo(spendableMicroAlgo)} ALGO above minimum; 0.001 ALGO safety buffer recommended`,
      },
    );
  }

  return {
    role,
    ready: checks.every((check) => !check.required || check.ok),
    snapshot,
    checks,
  };
}

export async function fetchAlgorandAccountSnapshot(
  address: string,
  networkName: AlgorandClientNetwork,
  usdcAssetId: string,
): Promise<AlgorandAccountSnapshot> {
  if (!isValidAlgorandAddress(address)) throw new Error(`Invalid Algorand address: ${address}`);
  const client = networkName === "mainnet" ? AlgorandClient.mainNet() : AlgorandClient.testNet();
  const info = await client.account.getInformation(address);
  return accountSnapshot(info, usdcAssetId);
}

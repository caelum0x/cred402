import { qieHexChainIdFor, type QieNetworkName } from "./qie_networks.js";
import { QieRpcClient } from "./qie_rpc.js";

/**
 * Live payer/receiver readiness for QIE x402 payments — the same role
 * `algorand_readiness.ts` plays for Algorand, reused by
 * `scripts/qie_x402_ready.ts` and `scripts/qie_x402_release_check.ts`.
 *
 * QIE's EVM "exact" scheme has no account-level equivalent to Algorand's
 * minimum-balance reserve or explicit ASA opt-in: any address can hold an
 * ERC-20 balance, and (per the x402 "exact" EVM scheme) the facilitator —
 * not the payer — submits the settlement transaction and pays its gas. So
 * unlike Algorand there is no confirmed need for the payer to hold a native
 * QIE gas balance just to pay; this module does not invent that check.
 * What is confirmed and checked instead: the configured RPC actually serves
 * the expected QIE network (`eth_chainId`), and the payer holds enough of
 * the configured ERC-20 asset to cover the payment.
 */

export type QieAccountRole = "payer" | "receiver";

export interface QieAccountSnapshot {
  address: string;
  networkName: QieNetworkName;
  /** `0x`-prefixed hex chain id, as returned by `eth_chainId`. */
  chainId: string;
  blockNumber: bigint;
  tokenBalanceBaseUnits: bigint;
}

export interface QieReadinessCheck {
  id: "network_match" | "token_balance";
  ok: boolean;
  required: boolean;
  message: string;
}

export interface QieAccountReadiness {
  role: QieAccountRole;
  ready: boolean;
  snapshot: QieAccountSnapshot;
  checks: QieReadinessCheck[];
}

function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function assertExternalMainnetPayer(
  networkName: QieNetworkName,
  payer: string,
  receiver: string,
): void {
  if (networkName === "mainnet" && payer.toLowerCase() === receiver.toLowerCase()) {
    throw new Error(
      "Mainnet payer and receiver must be different addresses; self-payment is not a valid activation test",
    );
  }
}

/** Format a base-unit (atomic) ERC-20 amount at the given decimals, e.g. `10000` at 6 decimals -> `"0.01"`. */
export function formatBaseUnits(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error("decimals must be a non-negative integer");
  if (amount < 0n) return `-${formatBaseUnits(-amount, decimals)}`;
  if (decimals === 0) return amount.toString();
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function assessQieAccountReadiness(
  snapshot: QieAccountSnapshot,
  role: QieAccountRole,
  requiredPaymentBaseUnits: bigint,
): QieAccountReadiness {
  if (requiredPaymentBaseUnits <= 0n) throw new Error("Required payment must be positive");
  const expectedChainId = qieHexChainIdFor(snapshot.networkName);
  const networkMatch = snapshot.chainId.toLowerCase() === expectedChainId.toLowerCase();
  const checks: QieReadinessCheck[] = [
    {
      id: "network_match",
      ok: networkMatch,
      required: true,
      message: networkMatch
        ? `RPC reports chain id ${snapshot.chainId} (QIE ${snapshot.networkName})`
        : `RPC reports chain id ${snapshot.chainId}, expected ${expectedChainId} for QIE ${snapshot.networkName}`,
    },
  ];

  if (role === "payer") {
    checks.push({
      id: "token_balance",
      ok: snapshot.tokenBalanceBaseUnits >= requiredPaymentBaseUnits,
      required: true,
      message: `${snapshot.tokenBalanceBaseUnits} base units available; ${requiredPaymentBaseUnits} base units required`,
    });
  }

  return {
    role,
    ready: checks.every((check) => !check.required || check.ok),
    snapshot,
    checks,
  };
}

export async function fetchQieAccountSnapshot(
  address: string,
  networkName: QieNetworkName,
  assetAddress: string,
  rpc: { rpcUrl: string; timeoutMs?: number; fetchFn?: typeof fetch },
): Promise<QieAccountSnapshot> {
  if (!isEvmAddress(address)) throw new Error(`Invalid QIE (EVM) address: ${address}`);
  if (!isEvmAddress(assetAddress)) throw new Error(`Invalid QIE asset contract address: ${assetAddress}`);
  const client = new QieRpcClient({ rpcUrl: rpc.rpcUrl, timeoutMs: rpc.timeoutMs, fetchFn: rpc.fetchFn });
  const [chainId, blockNumber, tokenBalanceBaseUnits] = await Promise.all([
    client.chainId(),
    client.blockNumber(),
    client.erc20BalanceOf(assetAddress, address),
  ]);
  return { address, networkName, chainId, blockNumber, tokenBalanceBaseUnits };
}

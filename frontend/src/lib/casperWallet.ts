/**
 * Casper Wallet integration (wires the real Casper Wallet browser extension).
 *
 * The extension injects `window.CasperWalletProvider` + `window.CasperWalletEventTypes`
 * (this is the canonical integration surface documented by Casper — the npm
 * "SDK" is just typings over this global). This module is a typed, framework-free
 * wrapper around that real provider: connect, active key, sign message, sign
 * deploy, and the wallet event stream.
 *
 * Signing pairs with the real deploy construction in `lib/casper` (p8): the
 * console builds a byte-exact deploy, the user signs it here with their own key,
 * and it is submitted — no private key ever touches the app.
 */

export const CASPER_WALLET_EVENTS = {
  Connected: "casper-wallet:connected",
  Disconnected: "casper-wallet:disconnected",
  TabChanged: "casper-wallet:tabChanged",
  ActiveKeyChanged: "casper-wallet:activeKeyChanged",
  Locked: "casper-wallet:locked",
  Unlocked: "casper-wallet:unlocked",
} as const;

export interface CasperWalletState {
  isLocked: boolean;
  isConnected: boolean;
  activeKey: string | null;
}

interface SignResult {
  cancelled: boolean;
  signatureHex?: string;
  signature?: Uint8Array;
}

export interface CasperWalletProvider {
  requestConnection(): Promise<boolean>;
  disconnectFromSite(): Promise<boolean>;
  isConnected(): Promise<boolean>;
  getActivePublicKey(): Promise<string>;
  getVersion(): Promise<string>;
  signMessage(message: string, signingPublicKeyHex: string): Promise<SignResult>;
  sign(deployJson: string, signingPublicKeyHex: string): Promise<SignResult>;
}

declare global {
  interface Window {
    // The extension injects a factory + the event-name constants.
    CasperWalletProvider?: (options?: { timeout?: number }) => CasperWalletProvider;
    CasperWalletEventTypes?: Record<string, string>;
  }
}

/** True when the Casper Wallet extension is present in this browser. */
export function isWalletAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.CasperWalletProvider === "function";
}

/** Get the real provider instance, or null if the extension isn't installed. */
export function getProvider(): CasperWalletProvider | null {
  if (!isWalletAvailable()) return null;
  return window.CasperWalletProvider!({ timeout: 30_000 });
}

/** Parse the active key out of a wallet event's `detail` JSON. */
export function parseEventActiveKey(detail: unknown): string | null {
  try {
    const obj = typeof detail === "string" ? JSON.parse(detail) : detail;
    return (obj as { activeKey?: string }).activeKey ?? null;
  } catch {
    return null;
  }
}

/** The event-type names the extension actually dispatches (falls back to ours). */
export function walletEventNames(): Record<string, string> {
  if (typeof window !== "undefined" && window.CasperWalletEventTypes) return window.CasperWalletEventTypes;
  return CASPER_WALLET_EVENTS;
}

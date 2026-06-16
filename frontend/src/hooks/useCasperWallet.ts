import { useCallback, useEffect, useState } from "react";
import {
  getProvider,
  isWalletAvailable,
  parseEventActiveKey,
  walletEventNames,
} from "../lib/casperWallet";
import { walletChallenge, walletVerify, type WalletSession } from "../api";

export interface UseCasperWallet {
  available: boolean;
  connecting: boolean;
  activeKey: string | null;
  session: WalletSession | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signMessage: (message: string) => Promise<string | null>;
  signIn: () => Promise<WalletSession | null>;
}

/**
 * React hook over the real Casper Wallet extension. Tracks the active key,
 * subscribes to the extension's wallet events, and exposes connect/disconnect/
 * signMessage. No private key ever enters the app — the extension signs.
 */
export function useCasperWallet(): UseCasperWallet {
  const [available] = useState(() => isWalletAvailable());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<WalletSession | null>(null);

  // Subscribe to the extension's real wallet events.
  useEffect(() => {
    if (!available) return;
    const names = walletEventNames();
    const onConnected = (e: Event) => setActiveKey(parseEventActiveKey((e as CustomEvent).detail));
    const onKeyChanged = (e: Event) => setActiveKey(parseEventActiveKey((e as CustomEvent).detail));
    const onDisconnected = () => setActiveKey(null);
    const subs: Array<[string, EventListener]> = [
      [names.Connected ?? "casper-wallet:connected", onConnected],
      [names.ActiveKeyChanged ?? "casper-wallet:activeKeyChanged", onKeyChanged],
      [names.Disconnected ?? "casper-wallet:disconnected", onDisconnected],
      [names.Locked ?? "casper-wallet:locked", onDisconnected],
    ];
    for (const [name, fn] of subs) window.addEventListener(name, fn);
    // Restore an existing connection on mount.
    const provider = getProvider();
    if (provider) {
      void provider
        .isConnected()
        .then((c) => (c ? provider.getActivePublicKey().then(setActiveKey) : null))
        .catch(() => undefined);
    }
    return () => {
      for (const [name, fn] of subs) window.removeEventListener(name, fn);
    };
  }, [available]);

  const connect = useCallback(async () => {
    const provider = getProvider();
    if (!provider) {
      setError("Casper Wallet extension not found");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const ok = await provider.requestConnection();
      if (ok) setActiveKey(await provider.getActivePublicKey());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const provider = getProvider();
    if (!provider) return;
    try {
      await provider.disconnectFromSite();
    } finally {
      setActiveKey(null);
    }
  }, []);

  const signMessage = useCallback(
    async (message: string): Promise<string | null> => {
      const provider = getProvider();
      if (!provider || !activeKey) {
        setError("connect a wallet first");
        return null;
      }
      const res = await provider.signMessage(message, activeKey);
      if (res.cancelled) return null;
      return res.signatureHex ?? null;
    },
    [activeKey],
  );

  // Prove account ownership: fetch a challenge, sign it in the wallet, verify it
  // server-side, and keep the minted session. No private key leaves the extension.
  const signIn = useCallback(async (): Promise<WalletSession | null> => {
    if (!activeKey) {
      setError("connect a wallet first");
      return null;
    }
    setError(null);
    const ch = await walletChallenge(activeKey);
    if ("error" in ch) {
      setError(ch.error);
      return null;
    }
    const signature = await signMessage(ch.message);
    if (!signature) return null; // user cancelled
    const result = await walletVerify(ch.nonce, signature);
    if ("error" in result) {
      setError(result.error);
      return null;
    }
    setSession(result);
    return result;
  }, [activeKey, signMessage]);

  // Drop the session whenever the wallet disconnects or the key changes.
  useEffect(() => {
    if (!activeKey) setSession(null);
    else if (session && session.account !== activeKey) setSession(null);
  }, [activeKey, session]);

  return { available, connecting, activeKey, session, error, connect, disconnect, signMessage, signIn };
}

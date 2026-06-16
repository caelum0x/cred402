import { useCasperWallet } from "../hooks/useCasperWallet";

/**
 * Casper Wallet connect button — real browser-extension integration.
 * Shows the connected account key (truncated), a connect/disconnect action, and a
 * "Sign in" action that proves account ownership against the server (challenge →
 * wallet signature → ed25519 verification → session).
 */
export function WalletButton() {
  const { available, connecting, activeKey, session, error, connect, disconnect, signIn } = useCasperWallet();

  if (!available) {
    return (
      <a
        className="wallet-btn wallet-install"
        href="https://www.casperwallet.io/"
        target="_blank"
        rel="noreferrer"
        title="Install the Casper Wallet browser extension"
      >
        Install Casper Wallet
      </a>
    );
  }

  if (activeKey) {
    const short = `${activeKey.slice(0, 6)}…${activeKey.slice(-4)}`;
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        {!session && (
          <button className="wallet-btn" onClick={() => void signIn()} title={error ?? "Prove account ownership"}>
            Sign in
          </button>
        )}
        <button
          className="wallet-btn wallet-connected"
          onClick={() => void disconnect()}
          title={session ? `Signed in as ${activeKey}` : activeKey}
        >
          <span className="dot" /> {session ? "✓ " : ""}{short}
        </button>
      </span>
    );
  }

  return (
    <button className="wallet-btn" onClick={() => void connect()} disabled={connecting} title={error ?? undefined}>
      {connecting ? "Connecting…" : "Connect Wallet"}
    </button>
  );
}

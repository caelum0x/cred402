import { useMemo, useState } from "react";
import { useLedger } from "./hooks/useLedger";
import { useChainManifest } from "./hooks/useChainManifest";
import { indexContracts } from "./lib/explorer";
import { Agents } from "./components/Agents";
import { Jobs } from "./components/Jobs";
import { Receipts } from "./components/Receipts";
import { CreditPool } from "./components/CreditPool";
import { Disputes } from "./components/Disputes";
import { Governance } from "./components/Governance";
import { Multichain } from "./components/Multichain";
import { RealFi } from "./components/RealFi";
import { Marketplace } from "./components/Marketplace";
import { Analytics } from "./components/Analytics";
import { Explorer } from "./components/Explorer";
import { Developer } from "./components/Developer";
import { Ops } from "./components/Ops";
import { Compliance } from "./components/Compliance";
import { Bureau } from "./components/Bureau";
import { Trust } from "./components/Trust";
import { Discovery } from "./components/Discovery";
import { Network } from "./components/Network";
import { OnChain } from "./components/OnChain";
import { X402Playground } from "./components/X402Playground";
import { Onboard } from "./components/Onboard";
import { Risk } from "./components/Risk";
import { NotificationBell } from "./components/NotificationBell";
import { WalletButton } from "./components/WalletButton";
import { EventFeed } from "./components/EventFeed";
import { Controls } from "./components/Controls";

const TABS = ["Analytics", "On-Chain", "Onboard", "Agents", "RWA Jobs", "Receipts", "Credit Pool", "Marketplace", "Discovery", "x402", "Network", "Risk", "Bureau", "Disputes", "Governance", "Multichain", "RealFi", "Trust", "Compliance", "Explorer", "Developer", "Ops"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const { snapshot, liveEvents, connected, refresh } = useLedger();
  const manifest = useChainManifest();
  const [tab, setTab] = useState<Tab>("Analytics");

  const feedEvents = liveEvents.length ? liveEvents : (snapshot?.events ?? []).slice().reverse();
  const contractIndex = useMemo(() => indexContracts(manifest), [manifest]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="logo-mark" src="/cred402-mark.png" alt="Cred402" width={40} height={40} />
          <div>
            <h1>Cred402</h1>
            <p className="tagline">Credit scores for autonomous RWA agents on Casper</p>
          </div>
        </div>
        <div className={`status ${connected ? "online" : "offline"}`}>
          <span className="dot" /> {connected ? "streaming events" : "reconnecting…"}
          {manifest && (
            <a className="chain-pill" href={manifest.explorer} target="_blank" rel="noreferrer" title={`${manifest.contract_count} contracts live — open cspr.live`}>
              ⛓ {manifest.chain} · {manifest.contract_count} contracts ↗
            </a>
          )}
          {snapshot && <span className="policy">policy {snapshot.policyVersion}</span>}
          <NotificationBell />
          <WalletButton />
        </div>
      </header>

      <Controls snapshot={snapshot} onAction={refresh} />

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? "tab active" : "tab"} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      <main className="layout">
        <section className="content">
          {!snapshot && <div className="empty">Loading on-chain state…</div>}
          {snapshot && tab === "Analytics" && <Analytics />}
          {snapshot && tab === "On-Chain" && <OnChain manifest={manifest} events={feedEvents} connected={connected} />}
          {snapshot && tab === "Explorer" && <Explorer />}
          {snapshot && tab === "Developer" && <Developer />}
          {snapshot && tab === "Ops" && <Ops />}
          {snapshot && tab === "x402" && <X402Playground />}
          {snapshot && tab === "Onboard" && <Onboard />}
          {snapshot && tab === "Risk" && <Risk />}
          {snapshot && tab === "Bureau" && <Bureau />}
          {snapshot && tab === "Agents" && <Agents snapshot={snapshot} />}
          {snapshot && tab === "RWA Jobs" && <Jobs snapshot={snapshot} />}
          {snapshot && tab === "Receipts" && <Receipts snapshot={snapshot} />}
          {snapshot && tab === "Credit Pool" && <CreditPool snapshot={snapshot} />}
          {snapshot && tab === "Marketplace" && <Marketplace />}
          {snapshot && tab === "Disputes" && <Disputes snapshot={snapshot} onChange={refresh} />}
          {snapshot && tab === "Governance" && <Governance snapshot={snapshot} onChange={refresh} />}
          {snapshot && tab === "Multichain" && <Multichain snapshot={snapshot} onChange={refresh} />}
          {snapshot && tab === "RealFi" && <RealFi snapshot={snapshot} onChange={refresh} />}
          {snapshot && tab === "Discovery" && <Discovery />}
          {snapshot && tab === "Network" && <Network />}
          {snapshot && tab === "Trust" && <Trust />}
          {snapshot && tab === "Compliance" && <Compliance />}
        </section>
        <aside className="sidebar">
          <EventFeed events={feedEvents} connected={connected} contractIndex={contractIndex} />
        </aside>
      </main>

      <footer className="footer">
        {manifest ? (
          <>
            <span className="footer-label">{manifest.contract_count} contracts live on {manifest.chain} ↗</span>
            {manifest.contracts.map((c) => (
              <a key={c.contract_hash} className="contract" href={c.explorer_url} target="_blank" rel="noreferrer" title={`${c.name} · ${c.contract_hash}`}>
                {c.name} ↗
              </a>
            ))}
          </>
        ) : (
          snapshot &&
          Object.keys(snapshot.contractHashes).map((name) => (
            <span key={name} className="contract" title={name}>
              {name}
            </span>
          ))
        )}
      </footer>
    </div>
  );
}

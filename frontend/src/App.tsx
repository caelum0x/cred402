import { useState } from "react";
import { useLedger } from "./hooks/useLedger";
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
import { Trust } from "./components/Trust";
import { Discovery } from "./components/Discovery";
import { X402Playground } from "./components/X402Playground";
import { Onboard } from "./components/Onboard";
import { Risk } from "./components/Risk";
import { NotificationBell } from "./components/NotificationBell";
import { WalletButton } from "./components/WalletButton";
import { EventFeed } from "./components/EventFeed";
import { Controls } from "./components/Controls";

const TABS = ["Analytics", "Onboard", "Agents", "RWA Jobs", "Receipts", "Credit Pool", "Marketplace", "Discovery", "x402", "Risk", "Disputes", "Governance", "Multichain", "RealFi", "Trust", "Compliance", "Explorer", "Developer", "Ops"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const { snapshot, liveEvents, connected, refresh } = useLedger();
  const [tab, setTab] = useState<Tab>("Analytics");

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
          {snapshot && tab === "Explorer" && <Explorer />}
          {snapshot && tab === "Developer" && <Developer />}
          {snapshot && tab === "Ops" && <Ops />}
          {snapshot && tab === "x402" && <X402Playground />}
          {snapshot && tab === "Onboard" && <Onboard />}
          {snapshot && tab === "Risk" && <Risk />}
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
          {snapshot && tab === "Trust" && <Trust />}
          {snapshot && tab === "Compliance" && <Compliance />}
        </section>
        <aside className="sidebar">
          <EventFeed events={liveEvents.length ? liveEvents : (snapshot?.events ?? []).slice().reverse()} />
        </aside>
      </main>

      <footer className="footer">
        {snapshot &&
          Object.entries(snapshot.contractHashes).map(([name, hash]) => (
            <span key={name} className="contract" title={hash}>
              {name}
            </span>
          ))}
      </footer>
    </div>
  );
}

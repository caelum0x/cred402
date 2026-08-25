import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getAlgorandX402Status,
  getAlgorandX402Usage,
  probeAlgorandCreditScore,
  type AlgorandChallengeProbe,
  type AlgorandX402Status,
  type AlgorandX402Usage,
} from "../api";

const CONSUMER_DIRECTORY = "https://github.com/caelum0x/cred402/tree/main/examples/algorand-paid-score";
const TYPESCRIPT_SOURCE = "https://github.com/caelum0x/cred402/blob/main/examples/algorand-paid-score/typescript.ts";
const PYTHON_SOURCE = "https://github.com/caelum0x/cred402/blob/main/examples/algorand-paid-score/python.py";

type ResourcePhase = "loading" | "error" | "empty" | "success";

interface DecodedPaymentRequirement {
  scheme?: unknown;
  network?: unknown;
  asset?: unknown;
  amount?: unknown;
  payTo?: unknown;
}

interface DecodedPaymentRequired {
  x402Version?: unknown;
  accepts?: unknown;
  resource?: { url?: unknown; tags?: unknown };
  [key: string]: unknown;
}

interface ChallengeCheck {
  label: string;
  expected: string;
  actual: string;
  passed: boolean;
}

interface ChallengeInspection {
  decoded: DecodedPaymentRequired | null;
  error: string;
  checks: ChallengeCheck[];
  ready: boolean;
}

function formatMicroUsdc(value?: string): string {
  if (!value || !/^\d+$/.test(value)) return "Unavailable";
  const padded = value.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return `${fraction ? `${whole}.${fraction}` : whole} USDC`;
}

function displayValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value === undefined) return "Missing";
  return "Invalid";
}

function decodePaymentRequiredHeader(encoded: string): DecodedPaymentRequired {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const bytes = Uint8Array.from(window.atob(padded), (character) => character.charCodeAt(0));
  const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Decoded PAYMENT-REQUIRED value is not an object.");
  }
  return decoded as DecodedPaymentRequired;
}

function urlsMatch(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expected);
    actualUrl.hash = "";
    expectedUrl.hash = "";
    return actualUrl.href === expectedUrl.href;
  } catch {
    return false;
  }
}

function inspectChallenge(
  probe: AlgorandChallengeProbe | null,
  status: AlgorandX402Status | null,
  expectedResourceUrl: string,
): ChallengeInspection {
  if (!probe) return { decoded: null, error: "", checks: [], ready: false };
  if (probe.status !== 402) {
    return { decoded: null, error: `Expected HTTP 402; received HTTP ${probe.status}.`, checks: [], ready: false };
  }
  if (!probe.payment_required_header) {
    return { decoded: null, error: "HTTP 402 response did not expose PAYMENT-REQUIRED.", checks: [], ready: false };
  }

  let decoded: DecodedPaymentRequired;
  try {
    decoded = decodePaymentRequiredHeader(probe.payment_required_header);
  } catch (reason) {
    return {
      decoded: null,
      error: reason instanceof Error ? reason.message : "Browser could not decode PAYMENT-REQUIRED.",
      checks: [],
      ready: false,
    };
  }

  const accepts = Array.isArray(decoded.accepts) ? decoded.accepts : [];
  const selected = accepts[0] && typeof accepts[0] === "object" && !Array.isArray(accepts[0])
    ? accepts[0] as DecodedPaymentRequirement
    : null;
  const tags = Array.isArray(decoded.resource?.tags) ? decoded.resource.tags : [];
  const expectedTag = status?.discovery.challenge_tag ?? "Status unavailable";
  const checks: ChallengeCheck[] = [
    {
      label: "x402 version",
      expected: status?.protocol === "x402-v2" ? "2" : "Deployment status required",
      actual: displayValue(decoded.x402Version),
      passed: status?.protocol === "x402-v2" && decoded.x402Version === 2,
    },
    {
      label: "Payment option",
      expected: "One exact option",
      actual: `${accepts.length} option${accepts.length === 1 ? "" : "s"}; ${displayValue(selected?.scheme)}`,
      passed: accepts.length === 1 && selected?.scheme === "exact",
    },
    {
      label: "Network",
      expected: status?.network ?? "Deployment status required",
      actual: displayValue(selected?.network),
      passed: Boolean(status?.configured && status.network && selected?.network === status.network),
    },
    {
      label: "USDC ASA",
      expected: status?.usdc_asset?.toString() ?? "Deployment status required",
      actual: displayValue(selected?.asset),
      passed: Boolean(status?.configured && status.usdc_asset !== undefined && String(selected?.asset) === String(status.usdc_asset)),
    },
    {
      label: "Receiver",
      expected: status?.pay_to ?? "Deployment status required",
      actual: displayValue(selected?.payTo),
      passed: Boolean(status?.configured && status.pay_to && selected?.payTo === status.pay_to),
    },
    {
      label: "Amount",
      expected: status?.price_micro_usdc ? `${status.price_micro_usdc} micro-USDC` : "Deployment status required",
      actual: selected?.amount === undefined ? "Missing" : `${displayValue(selected.amount)} micro-USDC`,
      passed: Boolean(
        status?.configured
        && status.price_micro_usdc
        && typeof selected?.amount === "string"
        && /^\d+$/.test(selected.amount)
        && selected.amount === status.price_micro_usdc,
      ),
    },
    {
      label: "Resource URL",
      expected: status?.public_origin ? expectedResourceUrl : "Public origin required from deployment status",
      actual: displayValue(decoded.resource?.url),
      passed: Boolean(
        status?.configured
        && status.public_origin
        && urlsMatch(decoded.resource?.url, expectedResourceUrl),
      ),
    },
    {
      label: "Challenge tag",
      expected: expectedTag,
      actual: tags.length ? tags.map(String).join(", ") : "Missing",
      passed: Boolean(status?.configured && expectedTag !== "Status unavailable" && tags.includes(expectedTag)),
    },
  ];

  return {
    decoded,
    error: "",
    checks,
    ready: status?.configured === true && checks.every((check) => check.passed),
  };
}

function ProbeBody({ value }: { value: unknown }) {
  const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!rendered) return null;
  return <pre className="algo-json">{rendered}</pre>;
}

export function AlgorandX402Console({ agentIds }: { agentIds: readonly string[] }) {
  const uniqueAgentIds = useMemo(
    () => [...new Set(agentIds.map((id) => id.trim()).filter(Boolean))],
    [agentIds],
  );
  const [agentId, setAgentId] = useState(uniqueAgentIds[0] ?? "");
  const [status, setStatus] = useState<AlgorandX402Status | null>(null);
  const [usage, setUsage] = useState<AlgorandX402Usage | null>(null);
  const [probe, setProbe] = useState<AlgorandChallengeProbe | null>(null);
  const [statusError, setStatusError] = useState("");
  const [usageError, setUsageError] = useState("");
  const [probeError, setProbeError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [statusLoading, setStatusLoading] = useState(true);
  const [usageLoading, setUsageLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [usageRefreshedAt, setUsageRefreshedAt] = useState<Date | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError("");
    setStatus(null);
    try {
      setStatus(await getAlgorandX402Status());
    } catch (reason) {
      setStatusError(reason instanceof Error ? reason.message : "Unable to read Algorand x402 status.");
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError("");
    setUsage(null);
    try {
      setUsage(await getAlgorandX402Usage());
      setUsageRefreshedAt(new Date());
    } catch (reason) {
      setUsageError(reason instanceof Error ? reason.message : "Unable to read finalized receipt usage.");
    } finally {
      setUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadUsage();
  }, [loadStatus, loadUsage]);

  useEffect(() => {
    if (!agentId && uniqueAgentIds[0]) setAgentId(uniqueAgentIds[0]);
  }, [agentId, uniqueAgentIds]);

  const cleanAgentId = agentId.trim();
  const paidPath = cleanAgentId
    ? `/v1/x402/credit-score/${encodeURIComponent(cleanAgentId)}`
    : status?.paid_route ?? "/v1/x402/credit-score/:agentId";
  const payerEndpoint = new URL(paidPath, status?.public_origin ?? window.location.origin).href;
  const inspection = useMemo(
    () => inspectChallenge(probe, status, payerEndpoint),
    [payerEndpoint, probe, status],
  );

  const requestChallenge = async () => {
    if (!cleanAgentId) {
      setProbeError("Enter an agent ID before requesting PAYMENT-REQUIRED.");
      return;
    }
    setProbeError("");
    setCopyError("");
    setProbe(null);
    setProbing(true);
    try {
      setProbe(await probeAlgorandCreditScore(cleanAgentId));
    } catch (reason) {
      setProbeError(reason instanceof Error ? reason.message : "Unable to request the payment challenge.");
    } finally {
      setProbing(false);
    }
  };

  const payerEnvironment = inspection.ready && status?.network_name && status.pay_to && status.price_micro_usdc
    ? [
        `CRED402_ALGORAND_CLIENT_URL=${payerEndpoint}`,
        `CRED402_ALGORAND_CLIENT_NETWORK=${status.network_name}`,
        `CRED402_ALGORAND_EXPECTED_PAY_TO=${status.pay_to}`,
        `CRED402_ALGORAND_EXPECTED_PRICE_MICRO_USDC=${status.price_micro_usdc}`,
        `CRED402_ALGORAND_MAX_PRICE_MICRO_USDC=${status.price_micro_usdc}`,
      ].join("\n")
    : "";

  const copyPayerEnvironment = async () => {
    if (!payerEnvironment) return;
    setCopyError("");
    try {
      await navigator.clipboard.writeText(payerEnvironment);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyError("Copy failed. Select the payer configuration and copy it manually.");
    }
  };

  const configured = status?.configured === true;
  const statusPhase: ResourcePhase = statusLoading
    ? "loading"
    : statusError
      ? "error"
      : configured
        ? "success"
        : "empty";
  const usageHasReceipts = Boolean(usage && (usage.paid_requests > 0 || usage.latest_receipts.length > 0));
  const usagePhase: ResourcePhase = usageLoading
    ? "loading"
    : usageError
      ? "error"
      : usageHasReceipts
        ? "success"
        : "empty";
  const receiptState = usageLoading
    ? "Reading usage"
    : usageError
      ? "Usage unavailable"
      : usageHasReceipts
        ? `${usage?.latest_receipts.length ?? 0} finalized indexed`
        : "Measured zero";
  const errorState = probeError || copyError || statusError || usageError;

  return (
    <section className="algo-console" aria-labelledby="algo-console-title">
      <div className="algo-heading">
        <div>
          <p className="algo-label">Algorand x402 operator console</p>
          <h3 id="algo-console-title">Paid agent credit report</h3>
        </div>
        <span className={`algo-state ${statusPhase === "success" ? "is-ready" : statusPhase === "loading" ? "" : "is-blocked"}`}>
          {statusPhase === "loading" ? "Reading status" : statusPhase === "error" ? "Status unavailable" : configured ? "Configured" : "Not configured"}
        </span>
      </div>

      <p className="algo-boundary">
        The browser requests and validates public metadata. It never reads a private key, signs a payload, or sends a payment.
      </p>

      <div className="algo-state-grid" aria-label="Algorand x402 operational states">
        <ConsoleState
          label="Deployment"
          value={statusPhase === "loading" ? "Checking" : statusPhase === "error" ? "Unavailable" : configured ? "Ready" : "Not configured"}
          detail={statusError || status?.reason || payerEndpoint}
          tone={statusPhase === "success" ? "ready" : statusPhase === "loading" ? "idle" : "blocked"}
        />
        <ConsoleState
          label="Network"
          value={status?.network_name ? `Algorand ${status.network_name}` : "Unresolved"}
          detail={status?.network ?? "Deployment metadata has no network"}
          tone={status?.network ? "ready" : statusError ? "blocked" : "idle"}
        />
        <ConsoleState
          label="Receipt finality"
          value={receiptState}
          detail={usage?.latest_payment_at
            ? `Latest ${new Date(usage.latest_payment_at).toLocaleString()}`
            : status?.finality
              ? `Independent Indexer confirmation requires ${status.finality.minimum_rounds} rounds`
              : "Only finalized anchors count"}
          tone={usagePhase === "success" ? "ready" : usagePhase === "error" ? "blocked" : "idle"}
        />
        <ConsoleState
          label="Error channel"
          value={errorState ? "Attention required" : "Clear"}
          detail={errorState || "No deployment, usage, or challenge error"}
          tone={errorState ? "blocked" : "ready"}
        />
      </div>

      <div className="algo-path" aria-label="Algorand x402 production path">
        <PathStep
          index="01"
          label="Resource server"
          value={configured ? `${status?.protocol} on ${status?.network_name}` : status?.reason ?? "Read deployment status"}
          state={configured ? "ready" : statusPhase === "loading" ? "idle" : "blocked"}
        />
        <PathStep
          index="02"
          label="Unpaid challenge"
          value={probe ? `HTTP ${probe.status}; PAYMENT-REQUIRED ${probe.payment_required ? "present" : "missing"}` : "Request the unsigned response"}
          state={probe?.status === 402 && probe.payment_required ? "ready" : probe ? "blocked" : "idle"}
        />
        <PathStep
          index="03"
          label="Payer handoff"
          value={inspection.ready ? "All browser checks passed" : "Requires every validation row to pass"}
          state={inspection.ready ? "ready" : inspection.error || probe ? "blocked" : "idle"}
        />
        <PathStep
          index="04"
          label="Finalized proof"
          value={usagePhase === "success" ? "Usage contains finalized receipt evidence" : "Terminal payer settles and verifies the proof"}
          state={usagePhase === "success" ? "ready" : usagePhase === "error" ? "blocked" : "idle"}
        />
      </div>

      <div className="algo-grid">
        <section className="algo-panel" aria-labelledby="algo-deployment-title" aria-busy={statusLoading}>
          <div className="algo-panel-head">
            <h4 id="algo-deployment-title">Public deployment metadata</h4>
            <button className="algo-retry" type="button" onClick={() => void loadStatus()} disabled={statusLoading}>
              {statusLoading ? "Reading" : "Refresh status"}
            </button>
          </div>
          {statusPhase === "loading" && <p className="algo-resource-state" role="status">Cred402 is reading `/v1/x402/algorand/status`.</p>}
          {statusPhase === "error" && (
            <div className="algo-resource-state is-error" role="alert">
              <p>{statusError}</p>
              <button type="button" onClick={() => void loadStatus()}>Retry deployment status</button>
            </div>
          )}
          {statusPhase === "empty" && (
            <div className="algo-resource-state is-empty">
              <p>The status endpoint responded, but the paid route is not configured.</p>
              <small>{status?.reason ?? "Configure the receiver and Algorand network on the API deployment."}</small>
            </div>
          )}
          {statusPhase === "success" && status && (
            <dl className="algo-metadata">
              <Metadata label="Network" value={status.network_name ?? "Unavailable"} />
              <Metadata label="Price" value={formatMicroUsdc(status.price_micro_usdc)} />
              <Metadata label="USDC asset" value={status.usdc_asset?.toString() ?? "Unavailable"} />
              <Metadata label="Receiver" value={status.pay_to ?? "Unavailable"} mono />
              <Metadata label="Facilitator" value={status.facilitator_url ?? "Unavailable"} mono />
              <Metadata label="Challenge tag" value={status.discovery.challenge_tag} mono />
            </dl>
          )}
        </section>

        <section className="algo-panel" aria-labelledby="algo-challenge-title">
          <div className="algo-panel-head">
            <h4 id="algo-challenge-title">Request the unpaid response</h4>
            <span>Display only</span>
          </div>
          <label className="algo-field">
            <span>Agent ID</span>
            <input
              list="algorand-agent-suggestions"
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setProbe(null);
                setProbeError("");
                setCopyError("");
              }}
              placeholder="Enter an agent ID"
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id="algorand-agent-suggestions">
              {uniqueAgentIds.map((id) => <option key={id} value={id} />)}
            </datalist>
          </label>
          <p className="algo-suggestions">
            {uniqueAgentIds.length
              ? `${uniqueAgentIds.length} API suggestion${uniqueAgentIds.length === 1 ? "" : "s"}; you can enter another ID.`
              : "The state API returned no agent suggestions. Enter the production agent ID directly."}
          </p>
          <code className="algo-endpoint">GET {paidPath}</code>
          <button className="algo-action" type="button" onClick={() => void requestChallenge()} disabled={!cleanAgentId || probing}>
            {probing ? "Requesting" : "Request PAYMENT-REQUIRED"}
          </button>
          {probeError ? <p className="algo-error" role="alert">{probeError}</p> : null}
          <p className="algo-note">Cred402 sends this request without a payment signature. Unknown IDs return their real API error.</p>
          <div className="algo-client-links" aria-label="Terminal payer clients">
            <a href={TYPESCRIPT_SOURCE} target="_blank" rel="noreferrer">TypeScript payer source</a>
            <a href={PYTHON_SOURCE} target="_blank" rel="noreferrer">Python payer source</a>
          </div>
        </section>
      </div>

      <section className="algo-usage" aria-labelledby="algo-usage-title" aria-busy={usageLoading}>
        <div className="algo-response-head">
          <h4 id="algo-usage-title">Finalized endpoint usage</h4>
          <span>{usageRefreshedAt ? `Read ${usageRefreshedAt.toLocaleTimeString()}` : "Not read yet"}</span>
          <button className="algo-retry" type="button" onClick={() => void loadUsage()} disabled={usageLoading}>
            {usageLoading ? "Reading" : "Refresh finalized receipts"}
          </button>
        </div>
        {usagePhase === "loading" && <p className="algo-resource-state" role="status">Cred402 is reading finalized Algorand receipts.</p>}
        {usagePhase === "error" && (
          <div className="algo-resource-state is-error" role="alert">
            <p>{usageError}</p>
            <button type="button" onClick={() => void loadUsage()}>Retry finalized usage</button>
          </div>
        )}
        {(usagePhase === "empty" || usagePhase === "success") && usage && (
          <>
            <div className="algo-usage-metrics">
              <UsageMetric label="Paid requests" value={usage.paid_requests.toString()} />
              <UsageMetric label="Unique payers" value={usage.unique_payers.toString()} />
              <UsageMetric label="Collected" value={formatMicroUsdc(usage.total_micro_usdc)} />
              <UsageMetric label="Latest payment" value={usage.latest_payment_at ? new Date(usage.latest_payment_at).toLocaleString() : "No finalized payment"} />
            </div>
            {usagePhase === "success" ? (
              <div className="algo-receipts">
                {usage.latest_receipts.map((receipt) => (
                  <a key={receipt.receipt_id} href={receipt.proof_url} target="_blank" rel="noreferrer">
                    <span>{receipt.receipt_id.slice(0, 16)}…</span>
                    <span>{formatMicroUsdc(receipt.amount_micro_usdc)}</span>
                    <span className="algo-finalized">Finalized</span>
                    <span>Open proof</span>
                  </a>
                ))}
              </div>
            ) : (
              <p className="algo-resource-state is-empty">The usage API measured zero finalized Algorand receipts.</p>
            )}
          </>
        )}
      </section>

      {probe && (
        <section className="algo-response" aria-labelledby="algo-response-title">
          <div className="algo-response-head">
            <h4 id="algo-response-title">Unpaid endpoint response</h4>
            <span>HTTP {probe.status}</span>
            <span>Request {probe.request_id ?? "not provided"}</span>
          </div>
          <ProbeBody value={probe.body} />
        </section>
      )}

      {probe && (
        <section className="algo-validation" aria-labelledby="algo-validation-title">
          <div className="algo-response-head">
            <h4 id="algo-validation-title">PAYMENT-REQUIRED verification</h4>
            <span>{inspection.ready ? "Payer handoff ready" : "Handoff blocked"}</span>
          </div>
          {inspection.error ? <p className="algo-resource-state is-error" role="alert">{inspection.error}</p> : null}
          {inspection.decoded ? (
            <>
              <div className="algo-checks">
                {inspection.checks.map((check, index) => (
                  <div className={check.passed ? "is-pass" : "is-fail"} key={check.label}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{check.label}</strong>
                    <small>Expected: {check.expected}</small>
                    <small>Header: {check.actual}</small>
                    <b>{check.passed ? "PASS" : "BLOCK"}</b>
                  </div>
                ))}
              </div>
              <details className="algo-decoded">
                <summary>Decoded PAYMENT-REQUIRED header</summary>
                <ProbeBody value={inspection.decoded} />
              </details>
            </>
          ) : null}
        </section>
      )}

      {payerEnvironment && (
        <section className="algo-handoff" aria-labelledby="algo-handoff-title">
          <div className="algo-response-head">
            <h4 id="algo-handoff-title">Validated terminal handoff</h4>
            <span>No private key included</span>
          </div>
          <p className="algo-handoff-copy">
            Copy these public constraints. The TypeScript or Python terminal client repeats validation, asks for explicit approval, then reads the key and performs sign, retry, settlement, proof, and finalized-usage checks.
          </p>
          <pre className="algo-json">{payerEnvironment}</pre>
          <div className="algo-command-row">
            <code>npm run x402:algorand:check</code>
            <code>npm run x402:algorand:pay -- --pay{status?.network_name === "mainnet" ? " --mainnet" : ""}</code>
          </div>
          <div className="algo-handoff-actions">
            <button className="algo-copy" type="button" onClick={() => void copyPayerEnvironment()}>
              {copied ? "Copied" : "Copy payer configuration"}
            </button>
            <a href={CONSUMER_DIRECTORY} target="_blank" rel="noreferrer">Open terminal clients</a>
          </div>
          {copyError ? <p className="algo-error" role="alert">{copyError}</p> : null}
        </section>
      )}
    </section>
  );
}

function ConsoleState({ label, value, detail, tone }: {
  label: string;
  value: string;
  detail: string;
  tone: "ready" | "blocked" | "idle";
}) {
  return (
    <div className={`algo-state-cell is-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function PathStep({ index, label, value, state }: {
  index: string;
  label: string;
  value: string;
  state: "ready" | "blocked" | "idle";
}) {
  return (
    <div className={`algo-step is-${state}`}>
      <span className="algo-step-index">{index}</span>
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function Metadata({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? "algo-break" : undefined}>{value}</dd></div>;
}

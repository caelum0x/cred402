-- Cred402 indexer schema (p2 §10.1)
-- Postgres tables hydrated by the event indexer from Casper streaming events.
-- The off-chain indexer (Go, see ROADMAP.md) writes here; the API reads here in
-- production. The in-memory ledger simulation mirrors this exact shape.

BEGIN;

CREATE TABLE IF NOT EXISTS operators (
  id            BIGSERIAL PRIMARY KEY,
  public_key    TEXT NOT NULL UNIQUE,
  kyb_status    TEXT NOT NULL DEFAULT 'unverified',
  jurisdiction  TEXT,
  risk_flags    JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id            BIGSERIAL PRIMARY KEY,
  agent_id      TEXT NOT NULL UNIQUE,
  public_key    TEXT NOT NULL,
  operator_id   BIGINT REFERENCES operators(id),
  service_type  TEXT NOT NULL,
  metadata_hash TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_passports (
  id               BIGSERIAL PRIMARY KEY,
  agent_id         TEXT NOT NULL UNIQUE REFERENCES agents(agent_id),
  reputation_score INT NOT NULL DEFAULT 0,
  credit_score     INT NOT NULL DEFAULT 0,
  total_revenue    NUMERIC(78,0) NOT NULL DEFAULT 0, -- U512 motes
  total_receipts   BIGINT NOT NULL DEFAULT 0,
  dispute_rate_bps INT NOT NULL DEFAULT 0,
  credit_limit     NUMERIC(78,0) NOT NULL DEFAULT 0,
  outstanding_debt NUMERIC(78,0) NOT NULL DEFAULT 0,
  stake            NUMERIC(78,0) NOT NULL DEFAULT 0,
  last_active_at   TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          BIGSERIAL PRIMARY KEY,
  operator_id BIGINT NOT NULL REFERENCES operators(id),
  key_hash    TEXT NOT NULL UNIQUE,
  scopes      JSONB NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'active',
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rwa_assets (
  id                   BIGSERIAL PRIMARY KEY,
  rwa_id               TEXT NOT NULL UNIQUE,
  asset_type           TEXT NOT NULL,
  issuer               TEXT,
  jurisdiction         TEXT,
  metadata_hash        TEXT,
  document_bundle_hash TEXT,
  status               TEXT NOT NULL DEFAULT 'active',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rwa_evidence (
  id             BIGSERIAL PRIMARY KEY,
  evidence_id    TEXT NOT NULL UNIQUE,
  rwa_id         TEXT NOT NULL REFERENCES rwa_assets(rwa_id),
  agent_id       TEXT NOT NULL REFERENCES agents(agent_id),
  receipt_id     TEXT,
  evidence_type  TEXT NOT NULL,
  evidence_hash  TEXT NOT NULL,
  source_hash    TEXT,
  confidence_bps INT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'submitted',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS x402_receipts (
  id                 BIGSERIAL PRIMARY KEY,
  receipt_id         TEXT NOT NULL UNIQUE,
  payer_agent_id     TEXT NOT NULL,
  seller_agent_id    TEXT NOT NULL REFERENCES agents(agent_id),
  amount             NUMERIC(78,0) NOT NULL,
  asset              TEXT NOT NULL DEFAULT 'CSPR',
  network            TEXT NOT NULL DEFAULT 'casper',
  service_type       TEXT NOT NULL,
  request_hash       TEXT,
  result_hash        TEXT NOT NULL,
  payment_proof_hash TEXT NOT NULL,
  nonce              TEXT NOT NULL,
  expires_at         TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'pending',
  transaction_hash   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at       TIMESTAMPTZ,
  -- Replay protection (p2 §6.3): nonce unique per payer; proof globally unique.
  UNIQUE (payer_agent_id, nonce),
  UNIQUE (payment_proof_hash)
);

CREATE TABLE IF NOT EXISTS credit_lines (
  id                BIGSERIAL PRIMARY KEY,
  agent_id          TEXT NOT NULL UNIQUE REFERENCES agents(agent_id),
  max_credit        NUMERIC(78,0) NOT NULL DEFAULT 0,
  drawn             NUMERIC(78,0) NOT NULL DEFAULT 0,
  interest_rate_bps INT NOT NULL DEFAULT 0,
  origination_fee_bps INT NOT NULL DEFAULT 0,
  health_factor_bps INT NOT NULL DEFAULT 0,
  due_timestamp     TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'active',
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_draws (
  id               BIGSERIAL PRIMARY KEY,
  draw_id          TEXT NOT NULL UNIQUE,
  agent_id         TEXT NOT NULL REFERENCES agents(agent_id),
  amount           NUMERIC(78,0) NOT NULL,
  purpose_hash     TEXT,
  transaction_hash TEXT,
  due_timestamp    TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'open',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repayments (
  id               BIGSERIAL PRIMARY KEY,
  repayment_id     TEXT NOT NULL UNIQUE,
  draw_id          TEXT REFERENCES credit_draws(draw_id),
  agent_id         TEXT NOT NULL REFERENCES agents(agent_id),
  amount           NUMERIC(78,0) NOT NULL,
  interest_amount  NUMERIC(78,0) NOT NULL DEFAULT 0,
  transaction_hash TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pool_positions (
  id            BIGSERIAL PRIMARY KEY,
  account       TEXT NOT NULL,
  shares        NUMERIC(78,0) NOT NULL DEFAULT 0,
  principal     NUMERIC(78,0) NOT NULL DEFAULT 0,
  accrued_yield NUMERIC(78,0) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS disputes (
  id            BIGSERIAL PRIMARY KEY,
  dispute_id    TEXT NOT NULL UNIQUE,
  target_type   TEXT NOT NULL,            -- agent | receipt | evidence
  target_id     TEXT NOT NULL,
  opened_by     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  evidence_hash TEXT,
  status        TEXT NOT NULL DEFAULT 'opened',
  verdict       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_audit_logs (
  id               BIGSERIAL PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents(agent_id),
  workflow_id      TEXT,
  action_type      TEXT NOT NULL,
  input_hash       TEXT,
  output_hash      TEXT,
  tool_name        TEXT,
  transaction_hash TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_scores (
  id            BIGSERIAL PRIMARY KEY,
  subject_type  TEXT NOT NULL,           -- agent | rwa
  subject_id    TEXT NOT NULL,
  score         INT NOT NULL,
  risk_bucket   TEXT NOT NULL,
  model_version TEXT NOT NULL,
  reason_codes  JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS protocol_events (
  id               BIGSERIAL PRIMARY KEY,
  chain            TEXT NOT NULL DEFAULT 'casper-test',
  block_hash       TEXT,
  block_height     BIGINT,
  transaction_hash TEXT,
  contract         TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL,
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_receipts_seller ON x402_receipts (seller_agent_id);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON x402_receipts (status);
CREATE INDEX IF NOT EXISTS idx_evidence_rwa    ON rwa_evidence (rwa_id);
CREATE INDEX IF NOT EXISTS idx_events_type      ON protocol_events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_contract  ON protocol_events (contract);
CREATE INDEX IF NOT EXISTS idx_disputes_target  ON disputes (target_type, target_id);

COMMIT;

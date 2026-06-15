-- Cred402 multichain schema (p3 §10). Casper-rooted, chain-executed: these tables
-- track address bindings, externally-anchored receipts, Casper-issued credit
-- authorization notes, and per-agent GLOBAL exposure across all chains.

BEGIN;

CREATE TABLE IF NOT EXISTS chain_networks (
  id              BIGSERIAL PRIMARY KEY,
  chain_id        TEXT NOT NULL UNIQUE,          -- CAIP-2, e.g. eip155:8453
  chain_family    TEXT NOT NULL,                 -- casper|evm|solana|cosmos|move|bitcoin
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  finality_policy JSONB NOT NULL DEFAULT '{}',
  risk_score      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_address_bindings (
  id                 BIGSERIAL PRIMARY KEY,
  agent_id           TEXT NOT NULL,
  chain_id           TEXT NOT NULL REFERENCES chain_networks(chain_id),
  address            TEXT NOT NULL,
  binding_hash       TEXT NOT NULL,
  casper_signature   TEXT NOT NULL,
  external_signature TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ,
  UNIQUE (chain_id, address)
);

CREATE TABLE IF NOT EXISTS external_receipts (
  id                BIGSERIAL PRIMARY KEY,
  receipt_id        TEXT NOT NULL UNIQUE,        -- blake2b256(canonical URE)
  origin_chain_id   TEXT NOT NULL,
  settlement_tx_hash TEXT,
  payer_agent_id    TEXT NOT NULL,
  seller_agent_id   TEXT NOT NULL,
  amount            NUMERIC(78,0) NOT NULL,
  asset             TEXT NOT NULL,
  service_type      TEXT NOT NULL,
  proof_hash        TEXT NOT NULL,
  casper_anchor_tx  TEXT,
  status            TEXT NOT NULL DEFAULT 'anchored',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (origin_chain_id, payer_agent_id, proof_hash)
);

CREATE TABLE IF NOT EXISTS credit_authorization_notes (
  id                  BIGSERIAL PRIMARY KEY,
  note_id             TEXT NOT NULL UNIQUE,
  agent_id            TEXT NOT NULL,
  target_chain_id     TEXT NOT NULL,
  target_pool         TEXT NOT NULL,
  max_draw            NUMERIC(78,0) NOT NULL,
  asset               TEXT NOT NULL,
  credit_score        INT NOT NULL,
  risk_policy_version INT NOT NULL,
  nonce               TEXT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  casper_signature    TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'issued',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS global_agent_exposure (
  id                   BIGSERIAL PRIMARY KEY,
  agent_id             TEXT NOT NULL UNIQUE,
  total_exposure_usd   NUMERIC(78,0) NOT NULL DEFAULT 0,  -- USD micro-units
  total_exposure_cspr  NUMERIC(78,0) NOT NULL DEFAULT 0,  -- motes
  total_exposure_native NUMERIC(78,0) NOT NULL DEFAULT 0,
  max_allowed_exposure NUMERIC(78,0) NOT NULL DEFAULT 0,
  reserved             NUMERIC(78,0) NOT NULL DEFAULT 0,
  frozen               BOOLEAN NOT NULL DEFAULT false,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chain_agent_exposure (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  chain_id    TEXT NOT NULL,
  asset       TEXT NOT NULL,
  outstanding NUMERIC(78,0) NOT NULL DEFAULT 0,
  reserved    NUMERIC(78,0) NOT NULL DEFAULT 0,
  repaid      NUMERIC(78,0) NOT NULL DEFAULT 0,
  defaulted   NUMERIC(78,0) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, chain_id, asset)
);

CREATE TABLE IF NOT EXISTS crosschain_messages (
  id              BIGSERIAL PRIMARY KEY,
  message_id      TEXT NOT NULL UNIQUE,
  origin_chain_id TEXT NOT NULL,
  target_chain_id TEXT NOT NULL,
  message_type    TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  proof_type      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS chain_finality_checkpoints (
  id           BIGSERIAL PRIMARY KEY,
  chain_id     TEXT NOT NULL,
  block_height BIGINT NOT NULL,
  block_hash   TEXT NOT NULL,
  finalized_at TIMESTAMPTZ,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, block_height)
);

CREATE INDEX IF NOT EXISTS idx_bindings_agent     ON agent_address_bindings (agent_id);
CREATE INDEX IF NOT EXISTS idx_ext_receipts_seller ON external_receipts (seller_agent_id);
CREATE INDEX IF NOT EXISTS idx_can_agent          ON credit_authorization_notes (agent_id);
CREATE INDEX IF NOT EXISTS idx_chain_exposure_agent ON chain_agent_exposure (agent_id);

COMMIT;

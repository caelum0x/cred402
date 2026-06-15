//! Cred402 Receipt Outbox (Solana).
//!
//! Records Universal Receipt Envelope (URE) commitments for high-volume x402
//! agent payments, then emits `ReceiptCreated` events for the
//! `solana-to-casper-relayer` to anchor on Casper.
//!
//! Mirrors `crosschain/standards/receipts.ts`:
//!   - URE type = "Cred402Receipt"
//!   - receipt_id = blake2b256(canonical_json(URE))  (computed off-chain)
//!
//! The canonical `receipt_id` is computed off-chain by the standards library
//! (BLAKE2b over the canonical JSON). On-chain we store the 32-byte commitment
//! plus the structured fields needed for indexing and exposure accounting, and
//! guarantee idempotency: a given `receipt_id` can be recorded exactly once
//! (its PDA is seeded by the receipt id).

use anchor_lang::prelude::*;

declare_id!("Cred402Rcpt111111111111111111111111111111111");

pub const MAX_AGENT_ID_LEN: usize = 96;
pub const MAX_ADDRESS_LEN: usize = 80;
pub const MAX_ASSET_LEN: usize = 16;
pub const MAX_SERVICE_TYPE_LEN: usize = 64;
pub const MAX_CHAIN_ID_LEN: usize = 80;

#[program]
pub mod cred402_receipt_outbox {
    use super::*;

    /// Initialize the outbox config.
    pub fn initialize(ctx: Context<Initialize>, origin_chain: String) -> Result<()> {
        require!(
            origin_chain.as_bytes().len() <= MAX_CHAIN_ID_LEN,
            OutboxError::StringTooLong
        );
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.origin_chain = origin_chain;
        cfg.receipt_count = 0;
        cfg.paused = false;
        cfg.bump = ctx.bumps.config;
        emit!(OutboxInitialized {
            authority: cfg.authority,
            origin_chain: cfg.origin_chain.clone(),
        });
        Ok(())
    }

    /// Record a URE commitment. The PDA is seeded by `receipt_id`, so the same
    /// receipt cannot be recorded twice (Anchor's `init` fails on a live PDA).
    pub fn submit_receipt(ctx: Context<SubmitReceipt>, params: ReceiptParams) -> Result<()> {
        require!(!ctx.accounts.config.paused, OutboxError::Paused);
        require!(
            params.amount > 0,
            OutboxError::ZeroAmount
        );
        require!(
            params.payer_agent_id.as_bytes().len() <= MAX_AGENT_ID_LEN
                && !params.payer_agent_id.is_empty(),
            OutboxError::InvalidField
        );
        require!(
            params.seller_agent_id.as_bytes().len() <= MAX_AGENT_ID_LEN
                && !params.seller_agent_id.is_empty(),
            OutboxError::InvalidField
        );
        require!(
            params.payer_address.as_bytes().len() <= MAX_ADDRESS_LEN
                && params.seller_address.as_bytes().len() <= MAX_ADDRESS_LEN,
            OutboxError::StringTooLong
        );
        require!(
            params.asset.as_bytes().len() <= MAX_ASSET_LEN && !params.asset.is_empty(),
            OutboxError::InvalidField
        );
        require!(
            params.service_type.as_bytes().len() <= MAX_SERVICE_TYPE_LEN
                && !params.service_type.is_empty(),
            OutboxError::InvalidField
        );

        let now = Clock::get()?.unix_timestamp;
        let receipt = &mut ctx.accounts.receipt;
        receipt.receipt_id = params.receipt_id;
        receipt.origin_chain = ctx.accounts.config.origin_chain.clone();
        receipt.settlement_network = params.settlement_network;
        receipt.payer_agent_id = params.payer_agent_id;
        receipt.seller_agent_id = params.seller_agent_id;
        receipt.payer_address = params.payer_address;
        receipt.seller_address = params.seller_address;
        receipt.asset = params.asset;
        receipt.amount = params.amount;
        receipt.service_type = params.service_type;
        receipt.request_hash = params.request_hash;
        receipt.result_hash = params.result_hash;
        receipt.payment_proof_hash = params.payment_proof_hash;
        receipt.settlement_tx_hash = params.settlement_tx_hash;
        receipt.nonce = params.nonce;
        receipt.created_at = params.created_at;
        receipt.recorded_at = now;
        receipt.anchored = false;
        receipt.bump = ctx.bumps.receipt;

        let cfg = &mut ctx.accounts.config;
        cfg.receipt_count = cfg.receipt_count.saturating_add(1);

        emit!(ReceiptCreated {
            receipt_id: receipt.receipt_id,
            payer_agent_id: receipt.payer_agent_id.clone(),
            seller_agent_id: receipt.seller_agent_id.clone(),
            asset: receipt.asset.clone(),
            amount: receipt.amount,
            service_type: receipt.service_type.clone(),
            settlement_network: receipt.settlement_network.clone(),
            payment_proof_hash: receipt.payment_proof_hash,
            created_at: receipt.created_at,
            sequence: cfg.receipt_count,
        });
        Ok(())
    }

    /// Mark a receipt as anchored on Casper. Called by the relayer authority
    /// after the Casper `ExternalReceiptRegistry` confirms the commitment.
    pub fn mark_anchored(ctx: Context<MarkAnchored>, casper_anchor_hash: [u8; 32]) -> Result<()> {
        let receipt = &mut ctx.accounts.receipt;
        require!(!receipt.anchored, OutboxError::AlreadyAnchored);
        receipt.anchored = true;
        emit!(ReceiptAnchored {
            receipt_id: receipt.receipt_id,
            casper_anchor_hash,
        });
        Ok(())
    }

    /// Pause/unpause receipt submission (authority only).
    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PausedSet { paused });
        Ok(())
    }
}

// ------------------------------------------------------------------ accounts

#[account]
pub struct OutboxConfig {
    pub authority: Pubkey,
    pub origin_chain: String,
    pub receipt_count: u64,
    pub paused: bool,
    pub bump: u8,
}

impl OutboxConfig {
    pub const SPACE: usize = 8 + 32 + (4 + MAX_CHAIN_ID_LEN) + 8 + 1 + 1;
}

#[account]
pub struct ReceiptCommitment {
    pub receipt_id: [u8; 32],
    pub origin_chain: String,
    pub settlement_network: String,
    pub payer_agent_id: String,
    pub seller_agent_id: String,
    pub payer_address: String,
    pub seller_address: String,
    pub asset: String,
    /// Smallest-unit integer amount (USDC 6dp / CSPR motes 9dp).
    pub amount: u64,
    pub service_type: String,
    pub request_hash: [u8; 32],
    pub result_hash: [u8; 32],
    pub payment_proof_hash: [u8; 32],
    pub settlement_tx_hash: [u8; 32],
    pub nonce: u64,
    pub created_at: i64,
    pub recorded_at: i64,
    pub anchored: bool,
    pub bump: u8,
}

impl ReceiptCommitment {
    pub const SPACE: usize = 8
        + 32
        + (4 + MAX_CHAIN_ID_LEN)
        + (4 + MAX_CHAIN_ID_LEN)
        + (4 + MAX_AGENT_ID_LEN)
        + (4 + MAX_AGENT_ID_LEN)
        + (4 + MAX_ADDRESS_LEN)
        + (4 + MAX_ADDRESS_LEN)
        + (4 + MAX_ASSET_LEN)
        + 8
        + (4 + MAX_SERVICE_TYPE_LEN)
        + 32
        + 32
        + 32
        + 32
        + 8
        + 8
        + 8
        + 1
        + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ReceiptParams {
    pub receipt_id: [u8; 32],
    pub settlement_network: String,
    pub payer_agent_id: String,
    pub seller_agent_id: String,
    pub payer_address: String,
    pub seller_address: String,
    pub asset: String,
    pub amount: u64,
    pub service_type: String,
    pub request_hash: [u8; 32],
    pub result_hash: [u8; 32],
    pub payment_proof_hash: [u8; 32],
    pub settlement_tx_hash: [u8; 32],
    pub nonce: u64,
    pub created_at: i64,
}

// -------------------------------------------------------------- ix contexts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = OutboxConfig::SPACE,
        seeds = [b"outbox-config"],
        bump
    )]
    pub config: Account<'info, OutboxConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: ReceiptParams)]
pub struct SubmitReceipt<'info> {
    #[account(mut, seeds = [b"outbox-config"], bump = config.bump)]
    pub config: Account<'info, OutboxConfig>,
    #[account(
        init,
        payer = payer,
        space = ReceiptCommitment::SPACE,
        seeds = [b"receipt", params.receipt_id.as_ref()],
        bump
    )]
    pub receipt: Account<'info, ReceiptCommitment>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarkAnchored<'info> {
    #[account(
        seeds = [b"outbox-config"],
        bump = config.bump,
        has_one = authority @ OutboxError::Unauthorized
    )]
    pub config: Account<'info, OutboxConfig>,
    #[account(
        mut,
        seeds = [b"receipt", receipt.receipt_id.as_ref()],
        bump = receipt.bump
    )]
    pub receipt: Account<'info, ReceiptCommitment>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(
        mut,
        seeds = [b"outbox-config"],
        bump = config.bump,
        has_one = authority @ OutboxError::Unauthorized
    )]
    pub config: Account<'info, OutboxConfig>,
    pub authority: Signer<'info>,
}

// --------------------------------------------------------------------- events

#[event]
pub struct OutboxInitialized {
    pub authority: Pubkey,
    pub origin_chain: String,
}

#[event]
pub struct ReceiptCreated {
    pub receipt_id: [u8; 32],
    pub payer_agent_id: String,
    pub seller_agent_id: String,
    pub asset: String,
    pub amount: u64,
    pub service_type: String,
    pub settlement_network: String,
    pub payment_proof_hash: [u8; 32],
    pub created_at: i64,
    pub sequence: u64,
}

#[event]
pub struct ReceiptAnchored {
    pub receipt_id: [u8; 32],
    pub casper_anchor_hash: [u8; 32],
}

#[event]
pub struct PausedSet {
    pub paused: bool,
}

// --------------------------------------------------------------------- errors

#[error_code]
pub enum OutboxError {
    #[msg("outbox is paused")]
    Paused,
    #[msg("amount must be a positive smallest-unit integer")]
    ZeroAmount,
    #[msg("required field is empty or invalid")]
    InvalidField,
    #[msg("string exceeds maximum length")]
    StringTooLong,
    #[msg("receipt already anchored")]
    AlreadyAnchored,
    #[msg("unauthorized signer")]
    Unauthorized,
}

//! Cred402 Evidence Mirror (Solana).
//!
//! Low-latency mirror of Evidence Attestation Envelopes (EAE) for real-time RWA
//! data markets. The canonical evidence graph lives on Casper; this program
//! mirrors agent-signed attestations at SVM speed and emits events for the
//! relayer to anchor.
//!
//! Mirrors `crosschain/standards/evidence.ts`:
//!   - EAE type = "Cred402EvidenceAttestation", signed by the agent's Casper key.
//!   - UAID     = "uaid:<asset_type>:<blake2b256(...)>" (identity.ts).
//!   - confidence_bps in [0, 10000].
//!
//! The EAE signing payload hash (`evidenceSigningPayload` -> blake2b256) and the
//! agent's Casper signature hash are stored so the attestation is auditable on
//! Solana; full ed25519 verification against the agent's Casper key happens off
//! chain / on Casper, where the agent key registry is canonical.

use anchor_lang::prelude::*;

declare_id!("Cred402Evid111111111111111111111111111111111");

pub const MAX_UAID_LEN: usize = 128;
pub const MAX_AGENT_ID_LEN: usize = 96;
pub const MAX_CHAIN_ID_LEN: usize = 80;
pub const MAX_EVIDENCE_TYPE_LEN: usize = 48;
pub const MAX_CONFIDENCE_BPS: u16 = 10_000;

#[program]
pub mod cred402_evidence_mirror {
    use super::*;

    /// Initialize the evidence mirror config.
    pub fn initialize(ctx: Context<Initialize>, origin_chain: String) -> Result<()> {
        require!(
            origin_chain.as_bytes().len() <= MAX_CHAIN_ID_LEN,
            EvidenceError::StringTooLong
        );
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.origin_chain = origin_chain;
        cfg.attestation_count = 0;
        cfg.paused = false;
        cfg.bump = ctx.bumps.config;
        emit!(MirrorInitialized {
            authority: cfg.authority,
            origin_chain: cfg.origin_chain.clone(),
        });
        Ok(())
    }

    /// Mirror an EAE attestation. The PDA is seeded by the evidence hash, so a
    /// given evidence item is mirrored exactly once.
    pub fn submit_evidence(ctx: Context<SubmitEvidence>, params: EvidenceParams) -> Result<()> {
        require!(!ctx.accounts.config.paused, EvidenceError::Paused);
        require!(
            params.confidence_bps <= MAX_CONFIDENCE_BPS,
            EvidenceError::ConfidenceOutOfRange
        );
        require!(
            params.uaid.as_bytes().len() <= MAX_UAID_LEN && params.uaid.starts_with("uaid:"),
            EvidenceError::InvalidUaid
        );
        require!(
            params.agent_id.as_bytes().len() <= MAX_AGENT_ID_LEN && !params.agent_id.is_empty(),
            EvidenceError::InvalidField
        );
        require!(
            params.evidence_type.as_bytes().len() <= MAX_EVIDENCE_TYPE_LEN
                && !params.evidence_type.is_empty(),
            EvidenceError::InvalidField
        );

        let now = Clock::get()?.unix_timestamp;
        let att = &mut ctx.accounts.attestation;
        att.uaid = params.uaid;
        att.agent_id = params.agent_id;
        att.origin_chain = ctx.accounts.config.origin_chain.clone();
        att.evidence_type = params.evidence_type;
        att.evidence_hash = params.evidence_hash;
        att.source_hash = params.source_hash;
        att.linked_receipt_id = params.linked_receipt_id;
        att.signing_payload_hash = params.signing_payload_hash;
        att.casper_signature_hash = params.casper_signature_hash;
        att.confidence_bps = params.confidence_bps;
        att.timestamp = params.timestamp;
        att.mirrored_at = now;
        att.anchored = false;
        att.bump = ctx.bumps.attestation;

        let cfg = &mut ctx.accounts.config;
        cfg.attestation_count = cfg.attestation_count.saturating_add(1);

        emit!(EvidenceMirrored {
            uaid: att.uaid.clone(),
            agent_id: att.agent_id.clone(),
            evidence_type: att.evidence_type.clone(),
            evidence_hash: att.evidence_hash,
            linked_receipt_id: att.linked_receipt_id,
            confidence_bps: att.confidence_bps,
            timestamp: att.timestamp,
            sequence: cfg.attestation_count,
        });
        Ok(())
    }

    /// Mark an attestation as anchored on Casper.
    pub fn mark_anchored(ctx: Context<MarkAnchored>, casper_anchor_hash: [u8; 32]) -> Result<()> {
        let att = &mut ctx.accounts.attestation;
        require!(!att.anchored, EvidenceError::AlreadyAnchored);
        att.anchored = true;
        emit!(EvidenceAnchored {
            evidence_hash: att.evidence_hash,
            casper_anchor_hash,
        });
        Ok(())
    }

    /// Pause/unpause (authority only).
    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PausedSet { paused });
        Ok(())
    }
}

// ------------------------------------------------------------------ accounts

#[account]
pub struct MirrorConfig {
    pub authority: Pubkey,
    pub origin_chain: String,
    pub attestation_count: u64,
    pub paused: bool,
    pub bump: u8,
}

impl MirrorConfig {
    pub const SPACE: usize = 8 + 32 + (4 + MAX_CHAIN_ID_LEN) + 8 + 1 + 1;
}

#[account]
pub struct EvidenceAttestation {
    pub uaid: String,
    pub agent_id: String,
    pub origin_chain: String,
    pub evidence_type: String,
    pub evidence_hash: [u8; 32],
    pub source_hash: [u8; 32],
    pub linked_receipt_id: [u8; 32],
    pub signing_payload_hash: [u8; 32],
    pub casper_signature_hash: [u8; 32],
    pub confidence_bps: u16,
    pub timestamp: i64,
    pub mirrored_at: i64,
    pub anchored: bool,
    pub bump: u8,
}

impl EvidenceAttestation {
    pub const SPACE: usize = 8
        + (4 + MAX_UAID_LEN)
        + (4 + MAX_AGENT_ID_LEN)
        + (4 + MAX_CHAIN_ID_LEN)
        + (4 + MAX_EVIDENCE_TYPE_LEN)
        + 32
        + 32
        + 32
        + 32
        + 32
        + 2
        + 8
        + 8
        + 1
        + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EvidenceParams {
    pub uaid: String,
    pub agent_id: String,
    pub evidence_type: String,
    pub evidence_hash: [u8; 32],
    pub source_hash: [u8; 32],
    pub linked_receipt_id: [u8; 32],
    pub signing_payload_hash: [u8; 32],
    pub casper_signature_hash: [u8; 32],
    pub confidence_bps: u16,
    pub timestamp: i64,
}

// -------------------------------------------------------------- ix contexts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = MirrorConfig::SPACE,
        seeds = [b"mirror-config"],
        bump
    )]
    pub config: Account<'info, MirrorConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: EvidenceParams)]
pub struct SubmitEvidence<'info> {
    #[account(mut, seeds = [b"mirror-config"], bump = config.bump)]
    pub config: Account<'info, MirrorConfig>,
    #[account(
        init,
        payer = payer,
        space = EvidenceAttestation::SPACE,
        seeds = [b"evidence", params.evidence_hash.as_ref()],
        bump
    )]
    pub attestation: Account<'info, EvidenceAttestation>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarkAnchored<'info> {
    #[account(
        seeds = [b"mirror-config"],
        bump = config.bump,
        has_one = authority @ EvidenceError::Unauthorized
    )]
    pub config: Account<'info, MirrorConfig>,
    #[account(
        mut,
        seeds = [b"evidence", attestation.evidence_hash.as_ref()],
        bump = attestation.bump
    )]
    pub attestation: Account<'info, EvidenceAttestation>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(
        mut,
        seeds = [b"mirror-config"],
        bump = config.bump,
        has_one = authority @ EvidenceError::Unauthorized
    )]
    pub config: Account<'info, MirrorConfig>,
    pub authority: Signer<'info>,
}

// --------------------------------------------------------------------- events

#[event]
pub struct MirrorInitialized {
    pub authority: Pubkey,
    pub origin_chain: String,
}

#[event]
pub struct EvidenceMirrored {
    pub uaid: String,
    pub agent_id: String,
    pub evidence_type: String,
    pub evidence_hash: [u8; 32],
    pub linked_receipt_id: [u8; 32],
    pub confidence_bps: u16,
    pub timestamp: i64,
    pub sequence: u64,
}

#[event]
pub struct EvidenceAnchored {
    pub evidence_hash: [u8; 32],
    pub casper_anchor_hash: [u8; 32],
}

#[event]
pub struct PausedSet {
    pub paused: bool,
}

// --------------------------------------------------------------------- errors

#[error_code]
pub enum EvidenceError {
    #[msg("evidence mirror is paused")]
    Paused,
    #[msg("confidence_bps out of range [0, 10000]")]
    ConfidenceOutOfRange,
    #[msg("invalid UAID (must start with 'uaid:')")]
    InvalidUaid,
    #[msg("required field is empty or invalid")]
    InvalidField,
    #[msg("string exceeds maximum length")]
    StringTooLong,
    #[msg("attestation already anchored")]
    AlreadyAnchored,
    #[msg("unauthorized signer")]
    Unauthorized,
}

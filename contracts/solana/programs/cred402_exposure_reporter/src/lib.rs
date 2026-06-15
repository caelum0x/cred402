//! Cred402 Exposure Reporter (Solana satellite).
//!
//! Emits canonical draw/repay exposure deltas for the
//! `solana-to-casper-relayer`, which reports them to the Casper
//! `GlobalExposureManager`. This is the mechanism that prevents an agent from
//! over-borrowing across multiple chains: every credit movement on Solana is
//! reported back to Casper, which maintains the agent's single global exposure.
//!
//! The reporter keeps a satellite-local mirror of the agent's outstanding
//! exposure (per asset) so off-chain indexers and the relayer have a compact,
//! monotonic source of sequenced events, while Casper remains canonical.

use anchor_lang::prelude::*;

declare_id!("Cred402Expo111111111111111111111111111111111");

pub const MAX_AGENT_ID_LEN: usize = 96;
pub const MAX_CHAIN_ID_LEN: usize = 80;
pub const MAX_ASSET_LEN: usize = 16;

/// Direction of an exposure delta.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ExposureKind {
    Draw,
    Repay,
}

#[program]
pub mod cred402_exposure_reporter {
    use super::*;

    /// Initialize the reporter config. `credit_vault_program` is the only
    /// program/authority allowed to push exposure deltas (the relayer or the
    /// vault authority co-signs reports to keep the satellite mirror honest).
    pub fn initialize(ctx: Context<Initialize>, params: InitParams) -> Result<()> {
        require!(
            params.target_chain.as_bytes().len() <= MAX_CHAIN_ID_LEN
                && params.target_chain.starts_with("solana:"),
            ReporterError::InvalidTargetChain
        );
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.reporter = params.reporter;
        cfg.target_chain = params.target_chain;
        cfg.event_seq = 0;
        cfg.paused = false;
        cfg.bump = ctx.bumps.config;
        emit!(ReporterInitialized {
            authority: cfg.authority,
            reporter: cfg.reporter,
            target_chain: cfg.target_chain.clone(),
        });
        Ok(())
    }

    /// Report an exposure delta (draw or repay) for an agent + asset. Updates
    /// the satellite-local exposure mirror and emits a globally-sequenced event
    /// for the Casper relayer.
    pub fn report_exposure(ctx: Context<ReportExposure>, params: ReportParams) -> Result<()> {
        require!(!ctx.accounts.config.paused, ReporterError::Paused);
        require!(
            ctx.accounts.reporter.key() == ctx.accounts.config.reporter,
            ReporterError::Unauthorized
        );
        require!(params.amount > 0, ReporterError::ZeroAmount);
        require!(
            params.agent_id.as_bytes().len() <= MAX_AGENT_ID_LEN && !params.agent_id.is_empty(),
            ReporterError::InvalidField
        );
        require!(
            params.asset.as_bytes().len() <= MAX_ASSET_LEN && !params.asset.is_empty(),
            ReporterError::InvalidField
        );

        let exposure = &mut ctx.accounts.exposure;
        if exposure.agent_id.is_empty() {
            exposure.agent_id = params.agent_id.clone();
            exposure.asset = params.asset.clone();
            exposure.vault = params.vault;
            exposure.outstanding = 0;
            exposure.cumulative_drawn = 0;
            exposure.cumulative_repaid = 0;
            exposure.bump = ctx.bumps.exposure;
        } else {
            require!(
                exposure.agent_id == params.agent_id && exposure.asset == params.asset,
                ReporterError::ExposureMismatch
            );
        }

        match params.kind {
            ExposureKind::Draw => {
                exposure.outstanding = exposure
                    .outstanding
                    .checked_add(params.amount)
                    .ok_or(ReporterError::MathOverflow)?;
                exposure.cumulative_drawn = exposure
                    .cumulative_drawn
                    .checked_add(params.amount)
                    .ok_or(ReporterError::MathOverflow)?;
            }
            ExposureKind::Repay => {
                require!(
                    params.amount <= exposure.outstanding,
                    ReporterError::RepayExceedsOutstanding
                );
                exposure.outstanding = exposure
                    .outstanding
                    .checked_sub(params.amount)
                    .ok_or(ReporterError::MathOverflow)?;
                exposure.cumulative_repaid = exposure
                    .cumulative_repaid
                    .checked_add(params.amount)
                    .ok_or(ReporterError::MathOverflow)?;
            }
        }

        let cfg = &mut ctx.accounts.config;
        cfg.event_seq = cfg.event_seq.saturating_add(1);
        let now = Clock::get()?.unix_timestamp;

        emit!(ExposureReported {
            seq: cfg.event_seq,
            kind: params.kind,
            agent_id: exposure.agent_id.clone(),
            asset: exposure.asset.clone(),
            vault: exposure.vault,
            amount: params.amount,
            outstanding_after: exposure.outstanding,
            global_exposure_after: params.global_exposure_after,
            related_tx_hash: params.related_tx_hash,
            target_chain: cfg.target_chain.clone(),
            reported_at: now,
        });
        Ok(())
    }

    /// Mark a sequenced exposure report as confirmed by Casper (relayer round
    /// trip complete). Emits a confirmation event for indexers.
    pub fn confirm_reported(ctx: Context<ConfirmReported>, seq: u64, casper_tx_hash: [u8; 32]) -> Result<()> {
        require!(
            ctx.accounts.reporter.key() == ctx.accounts.config.reporter,
            ReporterError::Unauthorized
        );
        emit!(ExposureConfirmed {
            seq,
            casper_tx_hash,
        });
        Ok(())
    }

    /// Pause/unpause (authority only).
    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PausedSet { paused });
        Ok(())
    }

    /// Rotate the reporter key (authority only).
    pub fn set_reporter(ctx: Context<AdminConfig>, reporter: Pubkey) -> Result<()> {
        ctx.accounts.config.reporter = reporter;
        emit!(ReporterRotated { reporter });
        Ok(())
    }
}

// ------------------------------------------------------------------ accounts

#[account]
pub struct ReporterConfig {
    pub authority: Pubkey,
    /// Key allowed to push exposure deltas (the relayer / vault authority).
    pub reporter: Pubkey,
    pub target_chain: String,
    pub event_seq: u64,
    pub paused: bool,
    pub bump: u8,
}

impl ReporterConfig {
    pub const SPACE: usize = 8 + 32 + 32 + (4 + MAX_CHAIN_ID_LEN) + 8 + 1 + 1;
}

#[account]
pub struct AgentExposure {
    pub agent_id: String,
    pub asset: String,
    pub vault: Pubkey,
    pub outstanding: u64,
    pub cumulative_drawn: u64,
    pub cumulative_repaid: u64,
    pub bump: u8,
}

impl AgentExposure {
    pub const SPACE: usize =
        8 + (4 + MAX_AGENT_ID_LEN) + (4 + MAX_ASSET_LEN) + 32 + 8 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitParams {
    pub reporter: Pubkey,
    pub target_chain: String,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ReportParams {
    pub kind: ExposureKind,
    pub agent_id: String,
    pub asset: String,
    pub vault: Pubkey,
    /// Smallest-unit integer delta.
    pub amount: u64,
    /// Agent's global exposure after this movement (smallest-unit integer),
    /// mirrored from the CAN / Casper GlobalExposureManager.
    pub global_exposure_after: u64,
    /// The Solana tx hash of the originating draw/repay (32 bytes).
    pub related_tx_hash: [u8; 32],
}

// -------------------------------------------------------------- ix contexts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = ReporterConfig::SPACE,
        seeds = [b"reporter-config"],
        bump
    )]
    pub config: Account<'info, ReporterConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: ReportParams)]
pub struct ReportExposure<'info> {
    #[account(mut, seeds = [b"reporter-config"], bump = config.bump)]
    pub config: Account<'info, ReporterConfig>,
    #[account(
        init_if_needed,
        payer = reporter,
        space = AgentExposure::SPACE,
        seeds = [b"exposure", params.agent_id.as_bytes(), params.asset.as_bytes()],
        bump
    )]
    pub exposure: Account<'info, AgentExposure>,
    #[account(mut)]
    pub reporter: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConfirmReported<'info> {
    #[account(seeds = [b"reporter-config"], bump = config.bump)]
    pub config: Account<'info, ReporterConfig>,
    pub reporter: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(
        mut,
        seeds = [b"reporter-config"],
        bump = config.bump,
        has_one = authority @ ReporterError::Unauthorized
    )]
    pub config: Account<'info, ReporterConfig>,
    pub authority: Signer<'info>,
}

// --------------------------------------------------------------------- events

#[event]
pub struct ReporterInitialized {
    pub authority: Pubkey,
    pub reporter: Pubkey,
    pub target_chain: String,
}

#[event]
pub struct ExposureReported {
    pub seq: u64,
    pub kind: ExposureKind,
    pub agent_id: String,
    pub asset: String,
    pub vault: Pubkey,
    pub amount: u64,
    pub outstanding_after: u64,
    pub global_exposure_after: u64,
    pub related_tx_hash: [u8; 32],
    pub target_chain: String,
    pub reported_at: i64,
}

#[event]
pub struct ExposureConfirmed {
    pub seq: u64,
    pub casper_tx_hash: [u8; 32],
}

#[event]
pub struct ReporterRotated {
    pub reporter: Pubkey,
}

#[event]
pub struct PausedSet {
    pub paused: bool,
}

// --------------------------------------------------------------------- errors

#[error_code]
pub enum ReporterError {
    #[msg("reporter is paused")]
    Paused,
    #[msg("invalid target chain (must start with 'solana:')")]
    InvalidTargetChain,
    #[msg("required field is empty or invalid")]
    InvalidField,
    #[msg("amount must be a positive smallest-unit integer")]
    ZeroAmount,
    #[msg("exposure account agent_id/asset mismatch")]
    ExposureMismatch,
    #[msg("repay exceeds outstanding exposure")]
    RepayExceedsOutstanding,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("unauthorized reporter")]
    Unauthorized,
}

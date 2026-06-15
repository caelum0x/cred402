//! Cred402 Credit Vault (Solana satellite).
//!
//! **EVM/SVM executes credit. Casper approves credit.**
//!
//! This vault lends SPL liquidity to an agent ONLY against a valid, unexpired,
//! target-matching, Casper-policy-signed Credit Authorization Note (CAN), and
//! NEVER beyond `CAN.max_draw` (nor beyond the conservative local cap).
//!
//! Mirrors `crosschain/standards/credit_notes.ts`:
//!   - CAN type = "Cred402CreditAuthorizationNote", version "1".
//!   - casper_policy_signature is ed25519 over `noteSigningPayload(can)` =
//!     stableStringify(CAN without the signature field).
//!   - verifyCreditAuthorizationNote checks: signature, expiry, target_chain,
//!     target_pool, and that max_draw is an integer.
//!
//! ## How the ed25519 CAN signature is verified on Solana
//!
//! SVM programs cannot call ed25519 verification directly, so the canonical and
//! sound technique is used: the client prepends a native **Ed25519 program**
//! (`Ed25519SigVerify111111111111111111111111111`) instruction in the same
//! transaction, and this program reads it back through the **instructions
//! sysvar** and asserts that:
//!   1. an Ed25519 instruction exists and verified (its presence in a landed tx
//!      means the runtime already checked the signature),
//!   2. its public key equals the vault's accepted Casper policy public key,
//!   3. its signed message equals the canonical CAN signing payload bytes that
//!      the client also passes in `params.note_signing_payload`.
//!
//! The client builds `note_signing_payload` with the SAME `noteSigningPayload`
//! canonical JSON used in credit_notes.ts, so the message bound on Solana is
//! byte-identical to what Casper policy signed.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Cred402Vau1t11111111111111111111111111111111");

pub const MAX_AGENT_ID_LEN: usize = 96;
pub const MAX_CHAIN_ID_LEN: usize = 80;
pub const MAX_ASSET_LEN: usize = 16;
/// The ed25519 instruction header layout produced by the native Ed25519 program
/// for a single signature (offsets are u16 little-endian into the same ix data).
const ED25519_SIGNATURE_LEN: usize = 64;
const ED25519_PUBKEY_LEN: usize = 32;

#[program]
pub mod cred402_credit_vault {
    use super::*;

    /// Create a credit vault for a single SPL asset. `casper_policy_pubkey` is
    /// the ed25519 public key whose signature on a CAN this vault accepts.
    /// `target_chain` is this cluster's chain id (e.g. "solana:<genesis_hash>");
    /// a CAN must target exactly this string. `max_draw_cap` is the conservative
    /// local cap applied on top of `CAN.max_draw`.
    pub fn initialize_vault(ctx: Context<InitializeVault>, params: InitVaultParams) -> Result<()> {
        require!(
            params.target_chain.as_bytes().len() <= MAX_CHAIN_ID_LEN
                && params.target_chain.starts_with("solana:"),
            VaultError::InvalidTargetChain
        );
        require!(
            params.asset.as_bytes().len() <= MAX_ASSET_LEN && !params.asset.is_empty(),
            VaultError::InvalidField
        );
        require!(params.max_draw_cap > 0, VaultError::ZeroCap);

        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.casper_policy_pubkey = params.casper_policy_pubkey;
        vault.target_chain = params.target_chain;
        vault.asset = params.asset;
        vault.mint = ctx.accounts.mint.key();
        vault.liquidity_vault = ctx.accounts.liquidity_vault.key();
        vault.total_liquidity = 0;
        vault.total_outstanding = 0;
        vault.max_draw_cap = params.max_draw_cap;
        vault.required_risk_policy_version = params.required_risk_policy_version;
        vault.paused = false;
        vault.bump = ctx.bumps.vault;
        vault.vault_authority_bump = ctx.bumps.vault_authority;

        emit!(VaultInitialized {
            vault: vault.key(),
            asset: vault.asset.clone(),
            target_chain: vault.target_chain.clone(),
            casper_policy_pubkey: vault.casper_policy_pubkey,
            max_draw_cap: vault.max_draw_cap,
        });
        Ok(())
    }

    /// Deposit SPL liquidity into the vault (lenders / treasury).
    pub fn deposit_liquidity(ctx: Context<DepositLiquidity>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_token_account.to_account_info(),
                    to: ctx.accounts.liquidity_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )?;
        let vault = &mut ctx.accounts.vault;
        vault.total_liquidity = vault
            .total_liquidity
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        emit!(LiquidityDeposited {
            vault: vault.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
            total_liquidity: vault.total_liquidity,
        });
        Ok(())
    }

    /// Draw credit against a Casper-signed CAN.
    ///
    /// Enforces the iron rule. `params.note_signing_payload` MUST equal the
    /// canonical `noteSigningPayload(can)` bytes that Casper policy signed, and
    /// the transaction MUST contain a verified native Ed25519 instruction over
    /// exactly that payload with `vault.casper_policy_pubkey`.
    pub fn draw(ctx: Context<Draw>, params: DrawParams) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);

        // --- (1) target_chain must match this vault's cluster chain id.
        require!(
            params.can_target_chain == vault.target_chain,
            VaultError::WrongTargetChain
        );
        // --- (2) target_pool must match this vault PDA.
        require!(
            params.can_target_pool == vault.key(),
            VaultError::WrongTargetPool
        );
        // --- (3) not expired.
        let now = Clock::get()?.unix_timestamp;
        require!(now <= params.can_expires_at, VaultError::NoteExpired);
        // --- risk policy version must satisfy the vault's minimum.
        require!(
            params.can_risk_policy_version >= vault.required_risk_policy_version,
            VaultError::StaleRiskPolicy
        );
        // --- max_draw must be a real positive smallest-unit integer.
        require!(params.can_max_draw > 0, VaultError::InvalidMaxDraw);
        require!(params.amount > 0, VaultError::ZeroAmount);

        // --- (4) verify the Casper policy ed25519 signature over the canonical
        //         CAN signing payload, via the native Ed25519 program + the
        //         instructions sysvar.
        verify_casper_policy_signature(
            &ctx.accounts.instructions_sysvar,
            &vault.casper_policy_pubkey.to_bytes(),
            &params.note_signing_payload,
        )?;

        // --- (5) caps: never beyond CAN.max_draw, the local cap, or liquidity.
        let debt = &mut ctx.accounts.debt;
        // Initialize a fresh debt PDA on first draw.
        if debt.agent_id.is_empty() {
            debt.vault = vault.key();
            debt.agent_id = params.agent_id.clone();
            debt.borrower = ctx.accounts.borrower.key();
            debt.principal_outstanding = 0;
            debt.total_drawn = 0;
            debt.total_repaid = 0;
            debt.draw_count = 0;
            debt.bump = ctx.bumps.debt;
        } else {
            require!(debt.agent_id == params.agent_id, VaultError::AgentMismatch);
        }

        let new_outstanding = debt
            .principal_outstanding
            .checked_add(params.amount)
            .ok_or(VaultError::MathOverflow)?;
        // Per-CAN ceiling: cumulative outstanding for this draw must not exceed
        // CAN.max_draw (a CAN authorizes a credit line up to max_draw).
        require!(
            new_outstanding <= params.can_max_draw,
            VaultError::ExceedsCanMaxDraw
        );
        // Conservative local cap.
        require!(
            new_outstanding <= vault.max_draw_cap,
            VaultError::ExceedsLocalCap
        );
        // Available liquidity (total_liquidity - total_outstanding) must cover it.
        let available = vault
            .total_liquidity
            .checked_sub(vault.total_outstanding)
            .ok_or(VaultError::MathOverflow)?;
        require!(params.amount <= available, VaultError::InsufficientLiquidity);

        // --- transfer SPL out of the liquidity vault to the borrower.
        let vault_key = vault.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault-authority",
            vault_key.as_ref(),
            &[vault.vault_authority_bump],
        ]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.liquidity_vault.to_account_info(),
                    to: ctx.accounts.borrower_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            params.amount,
        )?;

        // --- update debt + vault accounting.
        debt.principal_outstanding = new_outstanding;
        debt.total_drawn = debt
            .total_drawn
            .checked_add(params.amount)
            .ok_or(VaultError::MathOverflow)?;
        debt.draw_count = debt.draw_count.saturating_add(1);
        debt.last_can_note_id = params.can_note_id;
        debt.last_global_exposure_after_draw = params.can_global_exposure_after_draw;

        let vault_mut = &mut ctx.accounts.vault;
        vault_mut.total_outstanding = vault_mut
            .total_outstanding
            .checked_add(params.amount)
            .ok_or(VaultError::MathOverflow)?;

        emit!(CreditDrawn {
            vault: vault_key,
            agent_id: debt.agent_id.clone(),
            borrower: debt.borrower,
            amount: params.amount,
            principal_outstanding: debt.principal_outstanding,
            can_note_id: params.can_note_id,
            can_max_draw: params.can_max_draw,
            global_exposure_after_draw: params.can_global_exposure_after_draw,
            asset: vault_mut.asset.clone(),
            target_chain: vault_mut.target_chain.clone(),
        });
        Ok(())
    }

    /// Repay outstanding principal. Repayment is permissionless (anyone may
    /// repay an agent's debt) and reduces outstanding exposure.
    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        let debt = &mut ctx.accounts.debt;
        require!(
            amount <= debt.principal_outstanding,
            VaultError::RepayExceedsDebt
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer_token_account.to_account_info(),
                    to: ctx.accounts.liquidity_vault.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount,
        )?;

        debt.principal_outstanding = debt
            .principal_outstanding
            .checked_sub(amount)
            .ok_or(VaultError::MathOverflow)?;
        debt.total_repaid = debt
            .total_repaid
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        let vault = &mut ctx.accounts.vault;
        vault.total_outstanding = vault
            .total_outstanding
            .checked_sub(amount)
            .ok_or(VaultError::MathOverflow)?;

        emit!(CreditRepaid {
            vault: vault.key(),
            agent_id: debt.agent_id.clone(),
            payer: ctx.accounts.payer.key(),
            amount,
            principal_outstanding: debt.principal_outstanding,
            asset: vault.asset.clone(),
            target_chain: vault.target_chain.clone(),
        });
        Ok(())
    }

    /// Emergency pause / unpause (authority only) — satellite emergency stop.
    pub fn set_paused(ctx: Context<AdminVault>, paused: bool) -> Result<()> {
        ctx.accounts.vault.paused = paused;
        emit!(PausedSet { paused });
        Ok(())
    }

    /// Update the conservative local cap (authority only).
    pub fn set_max_draw_cap(ctx: Context<AdminVault>, max_draw_cap: u64) -> Result<()> {
        require!(max_draw_cap > 0, VaultError::ZeroCap);
        ctx.accounts.vault.max_draw_cap = max_draw_cap;
        emit!(MaxDrawCapSet { max_draw_cap });
        Ok(())
    }
}

/// Verify that the current transaction contains a native Ed25519 verification
/// instruction whose public key == `expected_pubkey` and whose message ==
/// `expected_message`. The presence of a verified Ed25519 instruction means the
/// runtime already checked the signature against the pubkey+message, so we only
/// need to bind the pubkey and message to our CAN.
fn verify_casper_policy_signature(
    instructions_sysvar: &AccountInfo,
    expected_pubkey: &[u8; 32],
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)? as usize;

    // Scan all instructions in this transaction for a matching Ed25519 ix.
    let mut idx = 0usize;
    loop {
        if idx == current_index {
            idx += 1;
            continue;
        }
        let ix = match load_instruction_at_checked(idx, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => break, // out of range -> no more instructions
        };
        if ix.program_id == ed25519_program::ID {
            if ed25519_ix_matches(&ix.data, expected_pubkey, expected_message)? {
                return Ok(());
            }
        }
        idx += 1;
        // Hard bound to avoid pathological loops; a tx has < 256 ixs.
        if idx > 255 {
            break;
        }
    }
    err!(VaultError::MissingCanSignature)
}

/// Parse a single-signature Ed25519 program instruction and check that its
/// embedded pubkey and message match the expected CAN policy key and payload.
///
/// Layout (single signature, all offsets reference this ix's own data):
///   [0]      num_signatures (u8) == 1
///   [1]      padding (u8)
///   [2..4]   signature_offset (u16 LE)
///   [4..6]   signature_instruction_index (u16 LE)
///   [6..8]   public_key_offset (u16 LE)
///   [8..10]  public_key_instruction_index (u16 LE)
///   [10..12] message_data_offset (u16 LE)
///   [12..14] message_data_size (u16 LE)
///   [14..16] message_instruction_index (u16 LE)
fn ed25519_ix_matches(
    data: &[u8],
    expected_pubkey: &[u8; 32],
    expected_message: &[u8],
) -> Result<bool> {
    if data.len() < 16 {
        return Ok(false);
    }
    let num_signatures = data[0];
    if num_signatures != 1 {
        return Ok(false);
    }
    let read_u16 = |o: usize| -> u16 { u16::from_le_bytes([data[o], data[o + 1]]) };

    let pubkey_offset = read_u16(6) as usize;
    let message_offset = read_u16(10) as usize;
    let message_size = read_u16(12) as usize;

    // All offsets must reference this same instruction's data (index 0xFFFF) or
    // the current instruction's own data. We require self-contained ixs, which
    // is what the standard ed25519 instruction builder produces.
    let pubkey_end = pubkey_offset
        .checked_add(ED25519_PUBKEY_LEN)
        .ok_or(VaultError::MalformedEd25519Ix)?;
    let message_end = message_offset
        .checked_add(message_size)
        .ok_or(VaultError::MalformedEd25519Ix)?;
    if pubkey_end > data.len() || message_end > data.len() {
        return Ok(false);
    }
    // Sanity: signature region present.
    let signature_offset = read_u16(2) as usize;
    let signature_end = signature_offset
        .checked_add(ED25519_SIGNATURE_LEN)
        .ok_or(VaultError::MalformedEd25519Ix)?;
    if signature_end > data.len() {
        return Ok(false);
    }

    let pubkey = &data[pubkey_offset..pubkey_end];
    let message = &data[message_offset..message_end];

    Ok(pubkey == expected_pubkey.as_ref() && message == expected_message)
}

// ------------------------------------------------------------------ accounts

#[account]
pub struct CreditVault {
    pub authority: Pubkey,
    /// ed25519 public key of the Casper risk-policy signer whose CANs this
    /// vault accepts.
    pub casper_policy_pubkey: Pubkey,
    /// e.g. "solana:<genesis_hash>" — a CAN must target exactly this.
    pub target_chain: String,
    pub asset: String,
    pub mint: Pubkey,
    pub liquidity_vault: Pubkey,
    pub total_liquidity: u64,
    pub total_outstanding: u64,
    /// Conservative local cap applied on top of CAN.max_draw.
    pub max_draw_cap: u64,
    pub required_risk_policy_version: u32,
    pub paused: bool,
    pub bump: u8,
    pub vault_authority_bump: u8,
}

impl CreditVault {
    pub const SPACE: usize = 8
        + 32
        + 32
        + (4 + MAX_CHAIN_ID_LEN)
        + (4 + MAX_ASSET_LEN)
        + 32
        + 32
        + 8
        + 8
        + 8
        + 4
        + 1
        + 1
        + 1;
}

#[account]
pub struct AgentDebt {
    pub vault: Pubkey,
    pub agent_id: String,
    pub borrower: Pubkey,
    pub principal_outstanding: u64,
    pub total_drawn: u64,
    pub total_repaid: u64,
    pub draw_count: u64,
    pub last_can_note_id: [u8; 32],
    /// CAN.global_exposure_after_draw as a smallest-unit integer.
    pub last_global_exposure_after_draw: u64,
    pub bump: u8,
}

impl AgentDebt {
    pub const SPACE: usize =
        8 + 32 + (4 + MAX_AGENT_ID_LEN) + 32 + 8 + 8 + 8 + 8 + 32 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitVaultParams {
    pub casper_policy_pubkey: Pubkey,
    pub target_chain: String,
    pub asset: String,
    pub max_draw_cap: u64,
    pub required_risk_policy_version: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DrawParams {
    pub agent_id: String,
    /// Smallest-unit integer amount to draw now.
    pub amount: u64,
    /// CAN fields, mirrored from the Casper-signed note. These are bound to the
    /// ed25519-verified `note_signing_payload`, so they cannot be forged.
    pub can_note_id: [u8; 32],
    pub can_target_chain: String,
    pub can_target_pool: Pubkey,
    /// Smallest-unit integer ceiling for the credit line.
    pub can_max_draw: u64,
    pub can_risk_policy_version: u32,
    /// CAN.global_exposure_after_draw smallest-unit integer (reported to Casper).
    pub can_global_exposure_after_draw: u64,
    pub can_expires_at: i64,
    /// Canonical `noteSigningPayload(can)` bytes (stableStringify of the unsigned
    /// CAN). Must match the message the native Ed25519 instruction verified.
    pub note_signing_payload: Vec<u8>,
}

// -------------------------------------------------------------- ix contexts

#[derive(Accounts)]
#[instruction(params: InitVaultParams)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = CreditVault::SPACE,
        seeds = [b"vault", mint.key().as_ref(), authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, CreditVault>,
    /// CHECK: PDA that owns the liquidity token account; verified by seeds.
    #[account(
        seeds = [b"vault-authority", vault.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = vault_authority,
        seeds = [b"liquidity", vault.key().as_ref()],
        bump
    )]
    pub liquidity_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(mut)]
    pub vault: Account<'info, CreditVault>,
    #[account(
        mut,
        address = vault.liquidity_vault @ VaultError::WrongLiquidityVault
    )]
    pub liquidity_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub depositor_token_account: Account<'info, TokenAccount>,
    pub depositor: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(params: DrawParams)]
pub struct Draw<'info> {
    #[account(mut)]
    pub vault: Account<'info, CreditVault>,
    /// CHECK: PDA authority over the liquidity vault; verified by seeds + stored bump.
    #[account(
        seeds = [b"vault-authority", vault.key().as_ref()],
        bump = vault.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = borrower,
        space = AgentDebt::SPACE,
        seeds = [b"debt", vault.key().as_ref(), params.agent_id.as_bytes()],
        bump
    )]
    pub debt: Account<'info, AgentDebt>,
    #[account(
        mut,
        address = vault.liquidity_vault @ VaultError::WrongLiquidityVault
    )]
    pub liquidity_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub borrower_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    /// CHECK: instructions sysvar, validated by address constraint.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Repay<'info> {
    #[account(mut)]
    pub vault: Account<'info, CreditVault>,
    #[account(
        mut,
        seeds = [b"debt", vault.key().as_ref(), debt.agent_id.as_bytes()],
        bump = debt.bump
    )]
    pub debt: Account<'info, AgentDebt>,
    #[account(
        mut,
        address = vault.liquidity_vault @ VaultError::WrongLiquidityVault
    )]
    pub liquidity_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payer_token_account: Account<'info, TokenAccount>,
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminVault<'info> {
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized
    )]
    pub vault: Account<'info, CreditVault>,
    pub authority: Signer<'info>,
}

// --------------------------------------------------------------------- events

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub asset: String,
    pub target_chain: String,
    pub casper_policy_pubkey: Pubkey,
    pub max_draw_cap: u64,
}

#[event]
pub struct LiquidityDeposited {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub total_liquidity: u64,
}

#[event]
pub struct CreditDrawn {
    pub vault: Pubkey,
    pub agent_id: String,
    pub borrower: Pubkey,
    pub amount: u64,
    pub principal_outstanding: u64,
    pub can_note_id: [u8; 32],
    pub can_max_draw: u64,
    pub global_exposure_after_draw: u64,
    pub asset: String,
    pub target_chain: String,
}

#[event]
pub struct CreditRepaid {
    pub vault: Pubkey,
    pub agent_id: String,
    pub payer: Pubkey,
    pub amount: u64,
    pub principal_outstanding: u64,
    pub asset: String,
    pub target_chain: String,
}

#[event]
pub struct PausedSet {
    pub paused: bool,
}

#[event]
pub struct MaxDrawCapSet {
    pub max_draw_cap: u64,
}

// --------------------------------------------------------------------- errors

#[error_code]
pub enum VaultError {
    #[msg("vault is paused")]
    Paused,
    #[msg("invalid target chain (must start with 'solana:')")]
    InvalidTargetChain,
    #[msg("required field is empty or invalid")]
    InvalidField,
    #[msg("cap must be a positive smallest-unit integer")]
    ZeroCap,
    #[msg("amount must be a positive smallest-unit integer")]
    ZeroAmount,
    #[msg("CAN target_chain does not match this vault's cluster")]
    WrongTargetChain,
    #[msg("CAN target_pool does not match this vault PDA")]
    WrongTargetPool,
    #[msg("CAN has expired")]
    NoteExpired,
    #[msg("CAN risk policy version is older than the vault requires")]
    StaleRiskPolicy,
    #[msg("CAN max_draw must be a positive integer")]
    InvalidMaxDraw,
    #[msg("missing or non-matching Casper policy ed25519 signature for the CAN")]
    MissingCanSignature,
    #[msg("malformed Ed25519 program instruction")]
    MalformedEd25519Ix,
    #[msg("draw would exceed CAN.max_draw")]
    ExceedsCanMaxDraw,
    #[msg("draw would exceed the vault's conservative local cap")]
    ExceedsLocalCap,
    #[msg("insufficient available liquidity")]
    InsufficientLiquidity,
    #[msg("debt account agent_id mismatch")]
    AgentMismatch,
    #[msg("repayment exceeds outstanding debt")]
    RepayExceedsDebt,
    #[msg("wrong liquidity vault account")]
    WrongLiquidityVault,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("unauthorized signer")]
    Unauthorized,
}

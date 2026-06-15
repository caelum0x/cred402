//! Cred402 Satellite Registry (Solana).
//!
//! Binds Solana addresses to Casper-rooted agent identities (CAID) and records
//! the Address Binding Envelope (ABE) commitment that authorized the binding.
//!
//! Mirrors `crosschain/standards/bindings.ts` and `identity.ts`:
//!   - CAID  = "cred402:casper:<agent_id>"
//!   - ABE   = type "Cred402AddressBinding", dual-signed (casper ed25519 +
//!             external secp256k1). The full ABE is verified off-chain by the
//!             relayer / standards library; on-chain we store the binding facts
//!             plus the canonical 32-byte hashes (binding payload + both
//!             signatures) so the binding is auditable from Solana.
//!
//! Casper remains the root: this registry is a *satellite* view of identity, not
//! a second source of truth.

use anchor_lang::prelude::*;

declare_id!("Cred402Reg1111111111111111111111111111111111");

/// CAID prefix, mirrors `makeCaid(agent_id, "casper")` in identity.ts.
pub const CAID_PREFIX: &str = "cred402:casper:";
/// Max byte length of an agent id (the part after the CAID prefix).
pub const MAX_AGENT_ID_LEN: usize = 96;
/// Max byte length of a CAID string.
pub const MAX_CAID_LEN: usize = CAID_PREFIX.len() + MAX_AGENT_ID_LEN;
/// Max byte length of an external chain id string, e.g. "solana:<genesis>".
pub const MAX_CHAIN_ID_LEN: usize = 80;

#[program]
pub mod cred402_satellite_registry {
    use super::*;

    /// Initialize the registry config. The `authority` may pause the registry
    /// and rotate itself; bindings themselves are authorized by the dual-signed
    /// ABE, not by this authority.
    pub fn initialize(ctx: Context<Initialize>, casper_chain_id: String) -> Result<()> {
        require!(
            casper_chain_id.as_bytes().len() <= MAX_CHAIN_ID_LEN,
            RegistryError::StringTooLong
        );
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.casper_chain_id = casper_chain_id;
        cfg.binding_count = 0;
        cfg.paused = false;
        cfg.bump = ctx.bumps.config;
        emit!(RegistryInitialized {
            authority: cfg.authority,
            casper_chain_id: cfg.casper_chain_id.clone(),
        });
        Ok(())
    }

    /// Bind a Solana address (the `solana_address` field) to a Casper-rooted
    /// agent. One PDA per (agent_id, solana_address) pair.
    ///
    /// `binding_payload_hash` is blake2b256 over the unsigned ABE
    /// (`bindingSigningPayload`); `casper_signature_hash` and
    /// `external_signature_hash` are blake2b256 of each signature so the binding
    /// is auditable on Solana while the full ABE lives off-chain.
    pub fn bind_agent_address(ctx: Context<BindAgentAddress>, params: BindParams) -> Result<()> {
        require!(!ctx.accounts.config.paused, RegistryError::Paused);
        require!(
            params.agent_id.as_bytes().len() <= MAX_AGENT_ID_LEN
                && !params.agent_id.is_empty(),
            RegistryError::InvalidAgentId
        );
        require!(
            params.external_chain.as_bytes().len() <= MAX_CHAIN_ID_LEN,
            RegistryError::StringTooLong
        );
        let now = Clock::get()?.unix_timestamp;
        require!(params.expires_at > now, RegistryError::BindingExpired);

        let binding = &mut ctx.accounts.binding;
        binding.agent_id = params.agent_id.clone();
        binding.solana_address = ctx.accounts.solana_address.key();
        binding.external_chain = params.external_chain.clone();
        binding.binding_payload_hash = params.binding_payload_hash;
        binding.casper_signature_hash = params.casper_signature_hash;
        binding.external_signature_hash = params.external_signature_hash;
        binding.expires_at = params.expires_at;
        binding.nonce = params.nonce;
        binding.revoked = false;
        binding.created_at = now;
        binding.bump = ctx.bumps.binding;

        let cfg = &mut ctx.accounts.config;
        cfg.binding_count = cfg.binding_count.saturating_add(1);

        emit!(AddressBound {
            agent_id: binding.agent_id.clone(),
            caid: caid_for(&binding.agent_id),
            solana_address: binding.solana_address,
            external_chain: binding.external_chain.clone(),
            expires_at: binding.expires_at,
            nonce: binding.nonce,
        });
        Ok(())
    }

    /// Revoke a binding. Only the bound Solana address (the externally bound key)
    /// or the registry authority may revoke.
    pub fn revoke_binding(ctx: Context<RevokeBinding>) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        let binding = &mut ctx.accounts.binding;
        require!(
            signer == binding.solana_address || signer == ctx.accounts.config.authority,
            RegistryError::Unauthorized
        );
        require!(!binding.revoked, RegistryError::AlreadyRevoked);
        binding.revoked = true;
        emit!(BindingRevoked {
            agent_id: binding.agent_id.clone(),
            solana_address: binding.solana_address,
        });
        Ok(())
    }

    /// Pause/unpause new bindings (authority only).
    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PausedSet { paused });
        Ok(())
    }
}

/// Build the CAID string for an agent id, mirroring identity.ts `makeCaid`.
pub fn caid_for(agent_id: &str) -> String {
    let mut s = String::with_capacity(CAID_PREFIX.len() + agent_id.len());
    s.push_str(CAID_PREFIX);
    s.push_str(agent_id);
    s
}

// ------------------------------------------------------------------ accounts

#[account]
pub struct RegistryConfig {
    pub authority: Pubkey,
    pub casper_chain_id: String,
    pub binding_count: u64,
    pub paused: bool,
    pub bump: u8,
}

impl RegistryConfig {
    pub const SPACE: usize = 8 + 32 + (4 + MAX_CHAIN_ID_LEN) + 8 + 1 + 1;
}

#[account]
pub struct AgentBinding {
    pub agent_id: String,
    pub solana_address: Pubkey,
    pub external_chain: String,
    pub binding_payload_hash: [u8; 32],
    pub casper_signature_hash: [u8; 32],
    pub external_signature_hash: [u8; 32],
    pub expires_at: i64,
    pub nonce: u64,
    pub revoked: bool,
    pub created_at: i64,
    pub bump: u8,
}

impl AgentBinding {
    pub const SPACE: usize = 8
        + (4 + MAX_AGENT_ID_LEN)
        + 32
        + (4 + MAX_CHAIN_ID_LEN)
        + 32
        + 32
        + 32
        + 8
        + 8
        + 1
        + 8
        + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BindParams {
    pub agent_id: String,
    pub external_chain: String,
    pub binding_payload_hash: [u8; 32],
    pub casper_signature_hash: [u8; 32],
    pub external_signature_hash: [u8; 32],
    pub expires_at: i64,
    pub nonce: u64,
}

// -------------------------------------------------------------- ix contexts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = RegistryConfig::SPACE,
        seeds = [b"registry-config"],
        bump
    )]
    pub config: Account<'info, RegistryConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: BindParams)]
pub struct BindAgentAddress<'info> {
    #[account(mut, seeds = [b"registry-config"], bump = config.bump)]
    pub config: Account<'info, RegistryConfig>,
    #[account(
        init,
        payer = payer,
        space = AgentBinding::SPACE,
        seeds = [
            b"binding",
            params.agent_id.as_bytes(),
            solana_address.key().as_ref(),
        ],
        bump
    )]
    pub binding: Account<'info, AgentBinding>,
    /// CHECK: the Solana address being bound; identity only, not a signer here
    /// because the binding authorization is the dual-signed ABE verified
    /// off-chain. It must sign `revoke_binding` to undo the binding.
    pub solana_address: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeBinding<'info> {
    #[account(seeds = [b"registry-config"], bump = config.bump)]
    pub config: Account<'info, RegistryConfig>,
    #[account(
        mut,
        seeds = [
            b"binding",
            binding.agent_id.as_bytes(),
            binding.solana_address.as_ref(),
        ],
        bump = binding.bump
    )]
    pub binding: Account<'info, AgentBinding>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(
        mut,
        seeds = [b"registry-config"],
        bump = config.bump,
        has_one = authority @ RegistryError::Unauthorized
    )]
    pub config: Account<'info, RegistryConfig>,
    pub authority: Signer<'info>,
}

// --------------------------------------------------------------------- events

#[event]
pub struct RegistryInitialized {
    pub authority: Pubkey,
    pub casper_chain_id: String,
}

#[event]
pub struct AddressBound {
    pub agent_id: String,
    pub caid: String,
    pub solana_address: Pubkey,
    pub external_chain: String,
    pub expires_at: i64,
    pub nonce: u64,
}

#[event]
pub struct BindingRevoked {
    pub agent_id: String,
    pub solana_address: Pubkey,
}

#[event]
pub struct PausedSet {
    pub paused: bool,
}

// --------------------------------------------------------------------- errors

#[error_code]
pub enum RegistryError {
    #[msg("registry is paused")]
    Paused,
    #[msg("agent id is empty or too long")]
    InvalidAgentId,
    #[msg("string exceeds maximum length")]
    StringTooLong,
    #[msg("binding already expired")]
    BindingExpired,
    #[msg("unauthorized signer")]
    Unauthorized,
    #[msg("binding already revoked")]
    AlreadyRevoked,
}

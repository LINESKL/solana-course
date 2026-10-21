use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

declare_id!("5KDkgHuq5VRs3jJcVGkFqNZYNBAvymVFnn6tDdABEUwp");

#[program]
pub mod simple_vault {
    use super::*;

    /// Создать vault для конкретного SPL-токена.
    /// Создаёт: VaultState PDA, vault_token_account PDA, share_mint PDA.
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.admin = ctx.accounts.admin.key();
        vault.token_mint = ctx.accounts.token_mint.key();
        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.bump = ctx.bumps.vault_state;
        vault.paused = false;

        msg!("Vault initialized for mint: {}", vault.token_mint);
        Ok(())
    }

    /// Создать личную «карточку» пользователя в vault.
    /// У каждого пользователя ровно одна карточка (PDA от vault + user).
    pub fn create_user_card(ctx: Context<CreateUserCard>) -> Result<()> {
        require!(!ctx.accounts.vault_state.paused, VaultError::VaultPaused);

        let card = &mut ctx.accounts.user_card;
        card.vault = ctx.accounts.vault_state.key();
        card.owner = ctx.accounts.user.key();
        card.created_at = Clock::get()?.unix_timestamp;
        card.bump = ctx.bumps.user_card;

        msg!("User card created for: {}", card.owner);
        Ok(())
    }

    /// Закрыть свою карточку: аккаунт удаляется, рента возвращается владельцу.
    pub fn close_user_card(ctx: Context<CloseUserCard>) -> Result<()> {
        msg!("User card closed for: {}", ctx.accounts.user.key());
        Ok(())
    }

    /// Поставить vault на паузу или снять с неё. Только админ.
    /// На паузе нельзя создавать новые карточки.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        ctx.accounts.vault_state.paused = paused;
        msg!("Vault paused: {}", paused);
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounts
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    /// VaultState PDA — seeds: ["vault", token_mint]
    #[account(
        init,
        payer = admin,
        space = VaultState::LEN,
        seeds = [b"vault", token_mint.key().as_ref()],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Token account, принадлежащий vault PDA
    #[account(
        init,
        payer = admin,
        token::mint = token_mint,
        token::authority = vault_state,
        seeds = [b"vault_tokens", token_mint.key().as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Mint для shares — выпускается vault PDA
    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = vault_state,
        seeds = [b"share_mint", token_mint.key().as_ref()],
        bump,
    )]
    pub share_mint: Account<'info, Mint>,

    /// SPL-токен, который принимает vault
    pub token_mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CreateUserCard<'info> {
    #[account(
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// UserCard PDA — seeds: ["user_card", vault_state, user]
    #[account(
        init,
        payer = user,
        space = UserCard::LEN,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_card: Account<'info, UserCard>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseUserCard<'info> {
    #[account(
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Seeds строятся из адреса подписанта, поэтому закрыть можно только свою карточку.
    /// close = user — лампорты (рента) уходят владельцу.
    #[account(
        mut,
        close = user,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump,
    )]
    pub user_card: Account<'info, UserCard>,

    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    /// has_one = admin — подписать может только админ, записанный в vault.
    #[account(
        mut,
        has_one = admin,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    pub admin: Signer<'info>,
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

#[account]
#[derive(Default)]
pub struct VaultState {
    pub admin: Pubkey,               // 32
    pub token_mint: Pubkey,          // 32 — SPL-токен vault'а
    pub vault_token_account: Pubkey, // 32 — PDA для токенов
    pub share_mint: Pubkey,          // 32 — mint для shares
    pub bump: u8,                    // 1
    pub paused: bool,                // 1 — на паузе новые карточки не создаются
}

impl VaultState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 1 + 1;
}

/// Карточка пользователя в vault.
#[account]
#[derive(Default)]
pub struct UserCard {
    pub vault: Pubkey, // 32 — к какому vault относится
    pub owner: Pubkey,   // 32 — владелец карточки
    pub bump: u8,        // 1
    pub created_at: i64, // 8 — когда создана (unix time)
}

impl UserCard {
    pub const LEN: usize = 8 + 32 + 32 + 1 + 8;
}

#[error_code]
pub enum VaultError {
    #[msg("Vault is paused")]
    VaultPaused,
}

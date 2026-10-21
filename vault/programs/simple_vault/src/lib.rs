use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, TransferChecked};
use anchor_spl::token_2022::Token2022;
use raydium_amm_v3::cpi::accounts::SwapSingleV2;
use raydium_amm_v3::program::AmmV3;
use raydium_amm_v3::states::PoolState;

/// SPL Memo — Raydium требует его в swap_v2
const MEMO_PROGRAM_ID: Pubkey = anchor_lang::solana_program::pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

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
        // иначе пропала бы запись о внесённых средствах
        require!(ctx.accounts.user_card.deposited == 0, VaultError::CardNotEmpty);
        msg!("User card closed for: {}", ctx.accounts.user.key());
        Ok(())
    }

    /// Внести токены в vault и получить share-токены (свою долю).
    ///
    /// Первый вкладчик получает share-токены 1:1. Дальше — пропорционально:
    /// shares = amount × всего_shares / всего_токенов_в_vault.
    /// Если vault заработал, токенов в нём больше, чем shares, и поздний вкладчик
    /// получает меньше share-токенов, чем внёс: чужой доход ему не достаётся.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.vault_state.paused, VaultError::VaultPaused);
        require!(amount > 0, VaultError::ZeroAmount);

        let shares = shares_for_deposit(
            amount,
            ctx.accounts.share_mint.supply,
            ctx.accounts.vault_token_account.amount,
        )?;
        require!(shares > 0, VaultError::ZeroShares);

        // 1. токены пользователя -> хранилище vault (подписывает сам пользователь)
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.token_mint.decimals,
        )?;

        // 2. выпуск share-токенов пользователю (подписывает программа от имени vault PDA)
        let token_mint = ctx.accounts.vault_state.token_mint;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", token_mint.as_ref(), &[ctx.accounts.vault_state.bump]]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_share_account.to_account_info(),
                    authority: ctx.accounts.vault_state.to_account_info(),
                },
                signer_seeds,
            ),
            shares,
        )?;

        // 3. учёт: всего внесено в vault и в карточке пользователя
        let vault = &mut ctx.accounts.vault_state;
        vault.total_deposited = vault.total_deposited.checked_add(amount).ok_or(VaultError::MathOverflow)?;
        let card = &mut ctx.accounts.user_card;
        card.deposited = card.deposited.checked_add(amount).ok_or(VaultError::MathOverflow)?;

        msg!("Deposit: {} tokens -> {} shares", amount, shares);
        Ok(())
    }

    /// Вывести токены: пользователь возвращает share-токены и забирает свою долю.
    ///
    /// amount = shares × всего_токенов_в_vault / всего_shares.
    /// Два CPI в Token Program:
    ///   1. burn — сжечь share-токены пользователя (подписывает пользователь);
    ///   2. transfer_checked — отдать токены из хранилища (подписывает программа от имени vault PDA).
    /// Пауза вывод не запрещает: выйти из vault пользователь может всегда.
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        require!(shares > 0, VaultError::ZeroAmount);
        let user_shares = ctx.accounts.user_share_account.amount;
        require!(shares <= user_shares, VaultError::InsufficientShares);

        let amount = tokens_for_shares(
            shares,
            ctx.accounts.share_mint.supply,
            ctx.accounts.vault_token_account.amount,
        )?;
        require!(amount > 0, VaultError::ZeroAmount);

        // 1. сжигаем share-токены пользователя
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.user_share_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares,
        )?;

        // 2. отдаём токены из хранилища — подпись vault PDA через seeds
        let token_mint = ctx.accounts.vault_state.token_mint;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", token_mint.as_ref(), &[ctx.accounts.vault_state.bump]]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault_state.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.token_mint.decimals,
        )?;

        // 3. учёт: внесённая сумма уменьшается пропорционально выведенной доле
        let card = &mut ctx.accounts.user_card;
        let principal_out = mul_div(card.deposited, shares, user_shares)?;
        card.deposited -= principal_out;
        let vault = &mut ctx.accounts.vault_state;
        vault.total_deposited = vault.total_deposited.saturating_sub(principal_out);

        msg!("Withdraw: {} shares -> {} tokens", shares, amount);
        Ok(())
    }

    /// Подключить к vault стратегию: пул Raydium CLMM и второе хранилище для второго токена пула.
    /// Только админ, один раз. Пул должен содержать токен vault и второй токен.
    pub fn init_strategy(ctx: Context<InitStrategy>) -> Result<()> {
        let pool = ctx.accounts.pool_state.load()?;
        let vault_token = ctx.accounts.vault_state.token_mint;
        let second = ctx.accounts.second_mint.key();
        let pool_mints = [pool.token_mint_0, pool.token_mint_1];
        require!(
            pool_mints.contains(&vault_token) && pool_mints.contains(&second) && vault_token != second,
            VaultError::PoolMintMismatch
        );

        let strategy = &mut ctx.accounts.strategy;
        strategy.vault = ctx.accounts.vault_state.key();
        strategy.pool = ctx.accounts.pool_state.key();
        strategy.second_mint = second;
        strategy.second_token_account = ctx.accounts.second_token_account.key();
        strategy.bump = ctx.bumps.strategy;
        msg!("Strategy: pool {}, second mint {}", strategy.pool, second);
        Ok(())
    }

    /// Обмен через пул Raydium CLMM (CPI swap_v2). Только админ.
    /// sell_vault_token = true: отдаём токен vault, получаем второй токен; false — наоборот.
    /// minimum_amount_out — защита от slippage: если пул отдаст меньше, Raydium отменит обмен.
    /// Токены отдаёт vault, поэтому подписывает программа от имени VaultState (PDA).
    pub fn swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, Swap<'info>>,
        amount_in: u64,
        minimum_amount_out: u64,
        sell_vault_token: bool,
    ) -> Result<()> {
        require!(amount_in > 0, VaultError::ZeroAmount);
        let a = &ctx.accounts;
        let (input, output) = if sell_vault_token {
            (&a.vault_token_account, &a.second_token_account)
        } else {
            (&a.second_token_account, &a.vault_token_account)
        };
        let output_before = output.amount;

        let token_mint = a.vault_state.token_mint;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", token_mint.as_ref(), &[a.vault_state.bump]]];
        let cpi_accounts = SwapSingleV2 {
            payer: a.vault_state.to_account_info(),
            amm_config: a.amm_config.to_account_info(),
            pool_state: a.pool_state.to_account_info(),
            input_token_account: input.to_account_info(),
            output_token_account: output.to_account_info(),
            input_vault: a.input_pool_vault.to_account_info(),
            output_vault: a.output_pool_vault.to_account_info(),
            observation_state: a.observation_state.to_account_info(),
            token_program: a.token_program.to_account_info(),
            token_program_2022: a.token_program_2022.to_account_info(),
            memo_program: a.memo_program.to_account_info(),
            input_vault_mint: a.input_mint.to_account_info(),
            output_vault_mint: a.output_mint.to_account_info(),
        };
        raydium_amm_v3::cpi::swap_v2(
            CpiContext::new_with_signer(a.clmm_program.to_account_info(), cpi_accounts, signer_seeds)
                // bitmap-расширение и tick-массивы пула, по которым пройдёт обмен
                .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount_in,
            minimum_amount_out,
            0,    // без ограничения цены, защищаемся minimum_amount_out
            true, // amount_in — точная сумма на входе
        )?;

        let output = if sell_vault_token { &mut ctx.accounts.second_token_account } else { &mut ctx.accounts.vault_token_account };
        output.reload()?;
        msg!("Swap: {} in -> {} out", amount_in, output.amount - output_before);
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

/// a × b / c в u128, чтобы произведение не переполнилось; округление вниз — в пользу vault.
pub fn mul_div(a: u64, b: u64, c: u64) -> Result<u64> {
    require!(c > 0, VaultError::MathOverflow);
    let result = (a as u128)
        .checked_mul(b as u128)
        .ok_or(VaultError::MathOverflow)?
        / c as u128;
    u64::try_from(result).map_err(|_| error!(VaultError::MathOverflow))
}

/// Сколько share-токенов положено за депозит.
pub fn shares_for_deposit(amount: u64, total_shares: u64, vault_balance: u64) -> Result<u64> {
    if total_shares == 0 || vault_balance == 0 {
        return Ok(amount);
    }
    mul_div(amount, total_shares, vault_balance)
}

/// Сколько токенов положено за возвращённые share-токены.
pub fn tokens_for_shares(shares: u64, total_shares: u64, vault_balance: u64) -> Result<u64> {
    mul_div(shares, vault_balance, total_shares)
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
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
        has_one = token_mint,
        has_one = vault_token_account,
        has_one = share_mint,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Депозит возможен только с созданной карточкой
    #[account(
        mut,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump,
    )]
    pub user_card: Account<'info, UserCard>,

    pub token_mint: Account<'info, Mint>,

    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub share_mint: Account<'info, Mint>,

    /// Откуда берём токены — только свой токен-аккаунт пользователя
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// Куда придут share-токены; создаётся при первом депозите
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = share_mint,
        associated_token::authority = user,
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
        has_one = token_mint,
        has_one = vault_token_account,
        has_one = share_mint,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump,
    )]
    pub user_card: Account<'info, UserCard>,

    pub token_mint: Account<'info, Mint>,

    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub share_mint: Account<'info, Mint>,

    /// Куда вернутся токены — только свой токен-аккаунт пользователя
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// Откуда сжигаются share-токены
    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = user,
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitStrategy<'info> {
    #[account(
        has_one = admin,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Strategy PDA — seeds: ["strategy", vault_state]. Одна на vault.
    #[account(
        init,
        payer = admin,
        space = Strategy::LEN,
        seeds = [b"strategy", vault_state.key().as_ref()],
        bump,
    )]
    pub strategy: Account<'info, Strategy>,

    pub second_mint: Account<'info, Mint>,

    /// Второе хранилище — для второго токена пула. Authority — vault PDA.
    #[account(
        init,
        payer = admin,
        token::mint = second_mint,
        token::authority = vault_state,
        seeds = [b"vault_tokens_2", vault_state.key().as_ref()],
        bump,
    )]
    pub second_token_account: Account<'info, TokenAccount>,

    /// Пул Raydium CLMM; AccountLoader проверяет, что владелец — программа Raydium
    pub pool_state: AccountLoader<'info, PoolState>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(
        has_one = admin,
        has_one = vault_token_account,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Обменивать можно только через пул стратегии
    #[account(
        seeds = [b"strategy", vault_state.key().as_ref()],
        bump = strategy.bump,
        has_one = second_token_account,
        constraint = strategy.pool == pool_state.key() @ VaultError::WrongPool,
    )]
    pub strategy: Account<'info, Strategy>,

    pub admin: Signer<'info>,

    pub clmm_program: Program<'info, AmmV3>,

    /// CHECK: проверяет Raydium (должен совпадать с pool_state.amm_config)
    pub amm_config: UncheckedAccount<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub second_token_account: Account<'info, TokenAccount>,

    /// CHECK: vault-аккаунт пула для входного токена, проверяет Raydium
    #[account(mut)]
    pub input_pool_vault: UncheckedAccount<'info>,

    /// CHECK: vault-аккаунт пула для выходного токена, проверяет Raydium
    #[account(mut)]
    pub output_pool_vault: UncheckedAccount<'info>,

    /// CHECK: oracle-аккаунт пула, проверяет Raydium
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,

    /// CHECK: SPL Memo, проверяется по адресу
    #[account(address = MEMO_PROGRAM_ID)]
    pub memo_program: UncheckedAccount<'info>,

    /// CHECK: mint входного токена, проверяет Raydium
    pub input_mint: UncheckedAccount<'info>,

    /// CHECK: mint выходного токена, проверяет Raydium
    pub output_mint: UncheckedAccount<'info>,
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
    pub paused: bool,                // 1 — на паузе новые карточки и депозиты запрещены
    pub total_deposited: u64,        // 8 — сколько всего внесено пользователями
}

impl VaultState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 1 + 1 + 8;
}

/// Карточка пользователя в vault.
#[account]
#[derive(Default)]
pub struct UserCard {
    pub vault: Pubkey, // 32 — к какому vault относится
    pub owner: Pubkey,   // 32 — владелец карточки
    pub bump: u8,        // 1
    pub created_at: i64, // 8 — когда создана (unix time)
    pub deposited: u64,  // 8 — сколько пользователь внёс
}

impl UserCard {
    pub const LEN: usize = 8 + 32 + 32 + 1 + 8 + 8;
}

/// Стратегия vault: через какой пул Raydium работать и где хранить второй токен пула.
#[account]
#[derive(Default)]
pub struct Strategy {
    pub vault: Pubkey,                // 32 — vault, к которому относится
    pub pool: Pubkey,                 // 32 — пул Raydium CLMM
    pub second_mint: Pubkey,          // 32 — второй токен пула
    pub second_token_account: Pubkey, // 32 — второе хранилище (PDA)
    pub bump: u8,                     // 1
}

impl Strategy {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 1;
}

#[error_code]
pub enum VaultError {
    #[msg("Vault is paused")]
    VaultPaused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deposit is too small: it would give zero shares")]
    ZeroShares,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Not enough share tokens")]
    InsufficientShares,
    #[msg("Withdraw all funds before closing the card")]
    CardNotEmpty,
    #[msg("Pool must contain the vault token and the second token")]
    PoolMintMismatch,
    #[msg("Swaps are allowed only through the strategy pool")]
    WrongPool,
}

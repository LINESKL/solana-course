use anchor_lang::prelude::*;

declare_id!("83VG5r3tT8ByFZe1PA6zz5MKDaBMmUh3wouVGhxGYnrw");

pub const COUNTER_SEED: &[u8] = b"counter";

#[program]
pub mod counter {
    use super::*;

    /// Создаёт счётчик пользователя. Адрес — PDA от ["counter", authority],
    /// поэтому у каждого кошелька ровно один счётчик.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.authority = ctx.accounts.authority.key();
        counter.count = 0;
        counter.bump = ctx.bumps.counter;
        msg!("Counter created for {}", counter.authority);
        Ok(())
    }

    pub fn increment(ctx: Context<Update>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = counter.count.checked_add(1).ok_or(CounterError::Overflow)?;
        msg!("Counter is now {}", counter.count);
        Ok(())
    }

    pub fn decrement(ctx: Context<Update>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = counter.count.checked_sub(1).ok_or(CounterError::Underflow)?;
        msg!("Counter is now {}", counter.count);
        Ok(())
    }

    pub fn reset(ctx: Context<Update>) -> Result<()> {
        ctx.accounts.counter.count = 0;
        msg!("Counter reset");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Counter::INIT_SPACE,
        seeds = [COUNTER_SEED, authority.key().as_ref()],
        bump
    )]
    pub counter: Account<'info, Counter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Update<'info> {
    /// has_one: менять счётчик может только тот, кто записан в поле authority
    #[account(mut, has_one = authority @ CounterError::Unauthorized)]
    pub counter: Account<'info, Counter>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Counter {
    pub authority: Pubkey,
    pub count: u64,
    pub bump: u8,
}

#[error_code]
pub enum CounterError {
    #[msg("Only the owner can change this counter")]
    Unauthorized,
    #[msg("Counter cannot go below zero")]
    Underflow,
    #[msg("Counter overflow")]
    Overflow,
}

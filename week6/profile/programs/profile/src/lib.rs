use anchor_lang::prelude::*;

declare_id!("pHopUnPkowbYSm8PhfZupMGA1s3g8FBpBydCrHWmkST");

pub const PROFILE_SEED: &[u8] = b"profile";
pub const USERNAME_SEED: &[u8] = b"username";
pub const MAX_USERNAME: usize = 20;
pub const MAX_BIO: usize = 160;
/// место под bio в байтах: UTF-8 символ занимает до 4 байт
pub const MAX_BIO_BYTES: usize = MAX_BIO * 4;

/// On-chain профиль пользователя.
///
/// Два вида PDA:
/// - Profile  ["profile", владелец]  — данные профиля, один на кошелёк;
/// - UsernameRecord ["username", имя] — кому принадлежит имя. Делает имена уникальными
///   и позволяет найти профиль по имени без внешней базы данных.
#[program]
pub mod profile {
    use super::*;

    pub fn create_profile(ctx: Context<CreateProfile>, username: String, bio: String) -> Result<()> {
        validate_username(&username)?;
        require!(bio.chars().count() <= MAX_BIO, ProfileError::BioTooLong);

        let now = Clock::get()?.unix_timestamp;
        let profile = &mut ctx.accounts.profile;
        profile.authority = ctx.accounts.authority.key();
        profile.username = username;
        profile.bio = bio;
        profile.created_at = now;
        profile.updated_at = now;
        profile.bump = ctx.bumps.profile;

        let record = &mut ctx.accounts.username_record;
        record.owner = profile.authority;
        record.bump = ctx.bumps.username_record;

        msg!("Profile @{} created for {}", profile.username, profile.authority);
        Ok(())
    }

    pub fn update_bio(ctx: Context<UpdateBio>, bio: String) -> Result<()> {
        require!(bio.chars().count() <= MAX_BIO, ProfileError::BioTooLong);
        let profile = &mut ctx.accounts.profile;
        profile.bio = bio;
        profile.updated_at = Clock::get()?.unix_timestamp;
        msg!("Profile @{} updated", profile.username);
        Ok(())
    }

    /// Закрывает оба аккаунта (rent возвращается владельцу) и освобождает имя.
    pub fn delete_profile(ctx: Context<DeleteProfile>) -> Result<()> {
        msg!("Profile @{} deleted", ctx.accounts.profile.username);
        Ok(())
    }
}

/// Имя: 3–20 символов, только a-z, 0-9 и "_" — чтобы одно имя нельзя было записать по-разному.
fn validate_username(name: &str) -> Result<()> {
    let ok_len = (3..=MAX_USERNAME).contains(&name.len());
    let ok_chars = name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    require!(ok_len && ok_chars, ProfileError::InvalidUsername);
    Ok(())
}

#[derive(Accounts)]
#[instruction(username: String)]
pub struct CreateProfile<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Profile::INIT_SPACE,
        seeds = [PROFILE_SEED, authority.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, Profile>,
    #[account(
        init,
        payer = authority,
        space = 8 + UsernameRecord::INIT_SPACE,
        seeds = [USERNAME_SEED, username.as_bytes()],
        bump
    )]
    pub username_record: Account<'info, UsernameRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateBio<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, authority.key().as_ref()],
        bump = profile.bump,
        has_one = authority
    )]
    pub profile: Account<'info, Profile>,
}

#[derive(Accounts)]
pub struct DeleteProfile<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        close = authority,
        seeds = [PROFILE_SEED, authority.key().as_ref()],
        bump = profile.bump,
        has_one = authority
    )]
    pub profile: Account<'info, Profile>,
    #[account(
        mut,
        close = authority,
        seeds = [USERNAME_SEED, profile.username.as_bytes()],
        bump = username_record.bump
    )]
    pub username_record: Account<'info, UsernameRecord>,
}

#[account]
#[derive(InitSpace)]
pub struct Profile {
    pub authority: Pubkey,
    #[max_len(MAX_USERNAME)]
    pub username: String,
    #[max_len(MAX_BIO_BYTES)]
    pub bio: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UsernameRecord {
    pub owner: Pubkey,
    pub bump: u8,
}

#[error_code]
pub enum ProfileError {
    #[msg("Username must be 3-20 characters: lowercase letters, digits or underscore")]
    InvalidUsername,
    #[msg("Bio must be at most 160 characters")]
    BioTooLong,
}

//! Первая Solana-программа без фреймворков.
//! Здоровается с тем, кто её вызвал, и считает вызовы в отдельном аккаунте.
//!
//! Аккаунты: [0] пользователь (signer), [1] аккаунт-счётчик (writable, владелец — эта программа).
//! Данные счётчика: u32 little-endian в первых 4 байтах.

use solana_program::{
    account_info::{AccountInfo, next_account_info},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    let accounts = &mut accounts.iter();
    let user = next_account_info(accounts)?;
    let greeting = next_account_info(accounts)?;

    if !user.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // менять данные аккаунта может только его владелец, поэтому проверяем owner явно
    if greeting.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let mut data = greeting.try_borrow_mut_data()?;
    let bytes: &mut [u8; 4] = data
        .get_mut(..4)
        .and_then(|s| s.try_into().ok())
        .ok_or(ProgramError::InvalidAccountData)?;
    let count = u32::from_le_bytes(*bytes)
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    *bytes = count.to_le_bytes();

    msg!("Hello, {}! Greeting #{}", user.key, count);
    Ok(())
}

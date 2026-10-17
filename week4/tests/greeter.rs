//! Интеграционные тесты: настоящая скомпилированная программа (target/deploy/greeter.so)
//! запускается во встроенной Solana VM (litesvm), без сети и валидатора.

use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program::pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

struct Env {
    svm: LiteSVM,
    program_id: Pubkey,
    user: Keypair,
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let program_id = Pubkey::new_unique();
    svm.add_program_from_file(program_id, "target/deploy/greeter.so").expect("run `cargo build-sbf` first");
    let user = Keypair::new();
    svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
    Env { svm, program_id, user }
}

/// Аккаунт для счётчика: 4 байта данных, владелец — наша программа.
fn greeting_account(env: &mut Env, owner: Pubkey) -> Pubkey {
    let key = Pubkey::new_unique();
    let account = solana_account::Account { lamports: 1_000_000, data: vec![0; 4], owner, executable: false, rent_epoch: 0 };
    env.svm.set_account(key, account).unwrap();
    key
}

fn greet(env: &mut Env, greeting: Pubkey, user_signs: bool) -> Result<Vec<String>, String> {
    let ix = Instruction::new_with_bytes(env.program_id, &[], vec![
        AccountMeta::new_readonly(env.user.pubkey(), user_signs),
        AccountMeta::new(greeting, false),
    ]);
    let payer = Keypair::new();
    env.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let signers: Vec<&Keypair> = if user_signs { vec![&payer, &env.user] } else { vec![&payer] };
    let tx = Transaction::new(&signers, Message::new(&[ix], Some(&payer.pubkey())), env.svm.latest_blockhash());
    env.svm.send_transaction(tx).map(|meta| meta.logs).map_err(|e| format!("{:?}", e.err))
}

fn counter(env: &Env, greeting: Pubkey) -> u32 {
    let data = env.svm.get_account(&greeting).unwrap().data;
    u32::from_le_bytes(data[..4].try_into().unwrap())
}

#[test]
fn each_call_increments_counter_and_logs_greeting() {
    let mut env = setup();
    let program_id = env.program_id;
    let greeting = greeting_account(&mut env, program_id);

    let logs = greet(&mut env, greeting, true).unwrap();
    assert_eq!(counter(&env, greeting), 1);
    let expected = format!("Hello, {}! Greeting #1", env.user.pubkey());
    assert!(logs.iter().any(|l| l.contains(&expected)), "logs: {logs:#?}");

    env.svm.expire_blockhash();
    greet(&mut env, greeting, true).unwrap();
    assert_eq!(counter(&env, greeting), 2);
}

#[test]
fn rejects_account_owned_by_another_program() {
    let mut env = setup();
    let foreign = greeting_account(&mut env, Pubkey::new_unique());
    let err = greet(&mut env, foreign, true).unwrap_err();
    assert!(err.contains("IncorrectProgramId"), "{err}");
}

#[test]
fn rejects_unsigned_user() {
    let mut env = setup();
    let program_id = env.program_id;
    let greeting = greeting_account(&mut env, program_id);
    let err = greet(&mut env, greeting, false).unwrap_err();
    assert!(err.contains("MissingRequiredSignature"), "{err}");
    assert_eq!(counter(&env, greeting), 0);
}

#[test]
fn rejects_too_small_account() {
    let mut env = setup();
    let key = Pubkey::new_unique();
    let account = solana_account::Account { lamports: 1_000_000, data: vec![0; 2], owner: env.program_id, executable: false, rent_epoch: 0 };
    env.svm.set_account(key, account).unwrap();
    let err = greet(&mut env, key, true).unwrap_err();
    assert!(err.contains("InvalidAccountData"), "{err}");
}

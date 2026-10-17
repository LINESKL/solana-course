mod error;
mod format;
mod inspect;
mod keypair;
mod pubkey;
mod rpc;
mod tx;
mod ui;

use clap::{Parser, Subcommand};
use error::{Error, Result};
use format::{fmt_sol, fmt_unix_time, parse_sol};
use keypair::Keypair;
use pubkey::Pubkey;
use rpc::{Cluster, HttpRpc};
use std::path::PathBuf;
use std::time::Duration;

/// Базовая комиссия за одну подпись.
const FEE_PER_SIGNATURE: u64 = 5_000;

#[derive(Parser)]
#[command(
    name = "solx",
    version,
    about = "A tiny Solana CLI written from scratch in Rust: keys, SOL transfers and a transaction inspector"
)]
struct Cli {
    /// Cluster: devnet, testnet, mainnet, localhost or an RPC URL
    #[arg(short, long, global = true, default_value = "devnet")]
    url: String,

    /// Keypair file, compatible with solana-keygen [default: ~/.config/solx/id.json]
    #[arg(short, long, global = true)]
    keypair: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate a new keypair
    Keygen {
        /// Overwrite an existing keypair file
        #[arg(long)]
        force: bool,
    },
    /// Print your wallet address
    Address,
    /// Show SOL balance (yours by default)
    Balance { address: Option<Pubkey> },
    /// Request test SOL (devnet/testnet only)
    Airdrop {
        #[arg(value_parser = parse_sol)]
        sol: u64,
    },
    /// Send SOL: the transaction is built, serialized and signed by solx itself
    Transfer {
        to: Pubkey,
        #[arg(value_parser = parse_sol)]
        sol: u64,
        /// Attach a text note via the Memo program
        #[arg(long)]
        memo: Option<String>,
    },
    /// Inspect any transaction: accounts, instructions, CPI, balance changes
    Tx {
        signature: String,
        /// Also print program logs
        #[arg(long)]
        logs: bool,
    },
    /// Show account info: balance, owner program, data size
    Account { address: Pubkey },
    /// Recent transactions of an address (yours by default)
    History {
        address: Option<Pubkey>,
        #[arg(short = 'n', long, default_value_t = 10)]
        limit: usize,
    },
}

fn main() {
    if let Err(e) = run(Cli::parse()) {
        eprintln!("{} {e}", ui::red("error:"));
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<()> {
    let cluster = Cluster::parse(&cli.url);
    let rpc = HttpRpc::new(&cluster.url);
    let keypair_path = cli.keypair.unwrap_or_else(default_keypair_path);
    let me = || Keypair::read(&keypair_path);

    match cli.command {
        Command::Keygen { force } => keygen(&keypair_path, force),
        Command::Address => {
            println!("{}", me()?.pubkey());
            Ok(())
        }
        Command::Balance { address } => {
            let address = address.map_or_else(|| me().map(|k| k.pubkey()), Ok)?;
            let lamports = rpc::get_balance(&rpc, &address)?;
            println!(
                "{} SOL {}",
                ui::bold(fmt_sol(lamports)),
                ui::dim(format!("({lamports} lamports, {})", cluster.name))
            );
            Ok(())
        }
        Command::Airdrop { sol } => airdrop(&rpc, &cluster, &me()?, sol),
        Command::Transfer { to, sol, memo } => {
            transfer(&rpc, &cluster, &me()?, to, sol, memo.as_deref())
        }
        Command::Tx { signature, logs } => {
            let json = rpc::get_transaction(&rpc, &signature)?;
            print!(
                "{}",
                inspect::TxReport::from_json(&signature, &json)?.render(&cluster, logs)
            );
            Ok(())
        }
        Command::Account { address } => account(&rpc, address),
        Command::History { address, limit } => {
            let address = address.map_or_else(|| me().map(|k| k.pubkey()), Ok)?;
            history(&rpc, &address, limit)
        }
    }
}

fn default_keypair_path() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from);
    home.join(".config/solx/id.json")
}

fn keygen(path: &std::path::Path, force: bool) -> Result<()> {
    if path.exists() && !force {
        let reason = "already exists, refusing to overwrite (use --force)".into();
        return Err(Error::Keypair {
            path: path.display().to_string(),
            reason,
        });
    }
    let keypair = Keypair::generate()?;
    keypair.write(path)?;
    println!("{} new keypair saved to {}", ui::green("✔"), path.display());
    print!("{}", ui::kv("Address", ui::bold(keypair.pubkey())));
    println!("{}", ui::dim("Next: solx airdrop 1"));
    Ok(())
}

fn ensure_writable(cluster: &Cluster) -> Result<()> {
    if cluster.is_mainnet() {
        Err(Error::ReadOnlyCluster(cluster.name.clone()))
    } else {
        Ok(())
    }
}

fn confirm(rpc: &HttpRpc, cluster: &Cluster, signature: &str) -> Result<()> {
    println!("{}", ui::dim("⏳ waiting for confirmation…"));
    rpc::wait_for_confirmation(rpc, signature, 60, Duration::from_millis(500))?;
    println!("{} confirmed", ui::green("✔"));
    print!("{}", ui::kv("Explorer", cluster.explorer_tx(signature)));
    print!("{}", ui::kv("Inspect", format!("solx tx {signature}")));
    Ok(())
}

fn airdrop(rpc: &HttpRpc, cluster: &Cluster, me: &Keypair, lamports: u64) -> Result<()> {
    ensure_writable(cluster)?;
    let signature = rpc::request_airdrop(rpc, &me.pubkey(), lamports).inspect_err(|_| {
        eprintln!("{}", ui::dim("hint: the public faucet is heavily rate-limited; https://faucet.solana.com also works"));
    })?;
    print!("{}", ui::kv("Signature", &signature));
    confirm(rpc, cluster, &signature)?;
    print!(
        "{}",
        ui::kv(
            "Balance",
            format!("{} SOL", fmt_sol(rpc::get_balance(rpc, &me.pubkey())?))
        )
    );
    Ok(())
}

fn transfer(
    rpc: &HttpRpc,
    cluster: &Cluster,
    me: &Keypair,
    to: Pubkey,
    lamports: u64,
    memo: Option<&str>,
) -> Result<()> {
    ensure_writable(cluster)?;
    let payer = me.pubkey();
    // проверяем заранее, чтобы дать понятную ошибку вместо отказа симуляции узла
    let have = rpc::get_balance(rpc, &payer)?;
    let need = lamports.saturating_add(FEE_PER_SIGNATURE);
    if have < need {
        return Err(Error::InsufficientFunds {
            need: fmt_sol(need),
            have: fmt_sol(have),
        });
    }

    let mut instructions = vec![tx::transfer(payer, to, lamports)];
    instructions.extend(memo.map(tx::memo));
    let message = tx::Message::new(&instructions, payer, rpc::latest_blockhash(rpc)?);
    let transaction = tx::Transaction::sign(message, me);

    print!("{}", ui::kv("From", payer));
    print!("{}", ui::kv("To", to));
    print!(
        "{}",
        ui::kv(
            "Amount",
            format!(
                "{} SOL + {} SOL fee",
                fmt_sol(lamports),
                fmt_sol(FEE_PER_SIGNATURE)
            )
        )
    );
    let signature = rpc::send_transaction(rpc, &transaction.serialize())?;
    debug_assert_eq!(
        signature,
        transaction.signature(),
        "node must echo our first signature"
    );
    print!("{}", ui::kv("Signature", &signature));
    confirm(rpc, cluster, &signature)
}

fn account(rpc: &HttpRpc, address: Pubkey) -> Result<()> {
    let Some(info) = rpc::get_account(rpc, &address)? else {
        println!(
            "{} {}",
            ui::dim("account does not exist on-chain (0 SOL, no data):"),
            address
        );
        return Ok(());
    };
    print!("{}", ui::kv("Address", ui::bold(address)));
    print!(
        "{}",
        ui::kv(
            "Balance",
            format!(
                "{} SOL {}",
                fmt_sol(info.lamports),
                ui::dim(format!("({} lamports)", info.lamports))
            )
        )
    );
    let owner_label = inspect::label(&info.owner)
        .map(|l| ui::dim(format!("({l})")))
        .unwrap_or_default();
    print!(
        "{}",
        ui::kv("Owner", format!("{} {owner_label}", info.owner))
    );
    print!(
        "{}",
        ui::kv(
            "Executable",
            if info.executable {
                "yes — this is a program"
            } else {
                "no"
            }
        )
    );
    print!("{}", ui::kv("Data", format!("{} bytes", info.data_len)));
    Ok(())
}

fn history(rpc: &HttpRpc, address: &Pubkey, limit: usize) -> Result<()> {
    let items = rpc::signatures_for_address(rpc, address, limit)?;
    if items.is_empty() {
        println!("{}", ui::dim("no transactions yet"));
        return Ok(());
    }
    let mut table = ui::table(&["Time (UTC)", "Status", "Signature"]);
    for item in &items {
        let time = item
            .block_time
            .map(fmt_unix_time)
            .unwrap_or_default()
            .replace(" UTC", "");
        let status = if item.failed { "✘ failed" } else { "✔ ok" };
        table.add_row([time, status.to_string(), item.signature.clone()]);
    }
    println!("{table}");
    println!("{}", ui::dim("Inspect one: solx tx <signature>"));
    Ok(())
}

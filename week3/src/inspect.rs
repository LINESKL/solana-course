//! «Transaction Detective» в терминале: разбор ответа getTransaction (jsonParsed)
//! в отчёт — аккаунты, дерево инструкций с CPI, программы, балансы, логи.

use crate::error::{Error, Result};
use crate::format::{fmt_sol, fmt_sol_delta, fmt_unix_time, short};
use crate::rpc::Cluster;
use crate::ui;
use serde_json::Value;

#[derive(Debug, PartialEq)]
pub struct AccountRow {
    pub address: String,
    pub signer: bool,
    pub writable: bool,
    pub sol_delta: i128,
}

#[derive(Debug, PartialEq)]
pub struct IxRow {
    /// 1 — инструкция транзакции, 2+ — вложенный вызов (CPI).
    pub depth: usize,
    pub program: String,
    pub name: String,
    pub detail: Option<String>,
}

#[derive(Debug, PartialEq)]
pub struct TokenChange {
    pub owner: String,
    pub mint: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug)]
pub struct TxReport {
    pub signature: String,
    pub slot: u64,
    pub block_time: Option<i64>,
    pub error: Option<String>,
    pub fee: u64,
    pub compute_units: Option<u64>,
    pub version: String,
    pub accounts: Vec<AccountRow>,
    pub instructions: Vec<IxRow>,
    pub token_changes: Vec<TokenChange>,
    pub logs: Vec<String>,
}

const COMPUTE_BUDGET: &str = "ComputeBudget111111111111111111111111111111";

/// Человекочитаемые имена известных программ и аккаунтов.
pub fn label(address: &str) -> Option<&'static str> {
    Some(match address {
        "11111111111111111111111111111111" => "System Program",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" => "Token Program",
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" => "Token-2022",
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" => "Associated Token",
        COMPUTE_BUDGET => "Compute Budget",
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" => "Memo Program",
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" => "Jupiter v6",
        "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C" => "Raydium CPMM",
        "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" => "Raydium AMM v4",
        "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" => "Orca Whirlpool",
        "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN" => "Meteora DBC",
        "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" => "Pump.fun",
        "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s" => "Metaplex Metadata",
        "So11111111111111111111111111111111111111112" => "Wrapped SOL",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" => "USDC",
        _ => return None,
    })
}

fn bad(what: &str) -> Error {
    Error::BadResponse(format!("not a transaction: missing {what}"))
}

impl TxReport {
    pub fn from_json(signature: &str, tx: &Value) -> Result<Self> {
        let meta = tx
            .get("meta")
            .filter(|m| m.is_object())
            .ok_or_else(|| bad("meta"))?;
        let message = tx
            .pointer("/transaction/message")
            .ok_or_else(|| bad("transaction.message"))?;
        let keys = message["accountKeys"]
            .as_array()
            .ok_or_else(|| bad("accountKeys"))?;
        let balances = |k: &str| -> Vec<i128> {
            meta[k]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_i64)
                .map(i128::from)
                .collect()
        };
        let (pre, post) = (balances("preBalances"), balances("postBalances"));

        let accounts = keys
            .iter()
            .enumerate()
            .map(|(i, k)| AccountRow {
                address: k["pubkey"].as_str().unwrap_or_default().to_string(),
                signer: k["signer"].as_bool().unwrap_or(false),
                writable: k["writable"].as_bool().unwrap_or(false),
                sol_delta: post.get(i).zip(pre.get(i)).map_or(0, |(b, a)| b - a),
            })
            .collect();

        let logs: Vec<String> = meta["logMessages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| l.as_str().map(String::from))
            .collect();

        Ok(Self {
            signature: signature.to_string(),
            slot: tx["slot"].as_u64().ok_or_else(|| bad("slot"))?,
            block_time: tx["blockTime"].as_i64(),
            error: (!meta["err"].is_null()).then(|| meta["err"].to_string()),
            fee: meta["fee"].as_u64().ok_or_else(|| bad("fee"))?,
            compute_units: meta["computeUnitsConsumed"].as_u64(),
            version: match &tx["version"] {
                Value::String(s) => s.clone(),
                Value::Null => "legacy".into(),
                v => v.to_string(),
            },
            accounts,
            instructions: instruction_tree(message, meta, &logs),
            token_changes: token_changes(meta),
            logs,
        })
    }

    pub fn render(&self, cluster: &Cluster, show_logs: bool) -> String {
        let mut out = String::new();
        out += &ui::kv("Signature", ui::bold(&self.signature));
        out += &ui::kv(
            "Status",
            match &self.error {
                None => ui::green("✔ Success"),
                Some(e) => ui::red(format!("✘ Failed: {e}")),
            },
        );
        let time = self
            .block_time
            .map(fmt_unix_time)
            .unwrap_or_else(|| "unknown".into());
        out += &ui::kv("Slot", format!("{}  {}", self.slot, ui::dim(time)));
        out += &ui::kv(
            "Fee",
            format!(
                "{} SOL {}",
                fmt_sol(self.fee),
                ui::dim(format!("({} lamports)", self.fee))
            ),
        );
        if let Some(cu) = self.compute_units {
            out += &ui::kv("Compute", format!("{cu} CU"));
        }
        out += &ui::kv("Version", &self.version);

        let mut accounts = ui::table(&["#", "Address", "Signer", "Writable", "Known as", "Δ SOL"]);
        for (i, a) in self.accounts.iter().enumerate() {
            let flag = |on: bool| if on { "✔" } else { "" };
            let delta = if a.sol_delta == 0 {
                String::new()
            } else {
                fmt_sol_delta(a.sol_delta)
            };
            accounts.add_row([
                i.to_string(),
                a.address.clone(),
                flag(a.signer).into(),
                flag(a.writable).into(),
                label(&a.address).unwrap_or("").into(),
                delta,
            ]);
        }
        out += &format!(
            "\n{}\n{accounts}\n",
            ui::bold(format!("Accounts ({})", self.accounts.len()))
        );

        out += &format!("\n{}\n", ui::bold("Instructions"));
        let mut top = 0;
        for ix in &self.instructions {
            let prefix = if ix.depth <= 1 {
                top += 1;
                format!("#{top} ")
            } else {
                format!("{}└─ ", "   ".repeat(ix.depth - 1))
            };
            let detail = ix
                .detail
                .as_ref()
                .map(|d| ui::dim(format!("  {d}")))
                .unwrap_or_default();
            out += &format!(
                "  {prefix}{} · {}{detail}\n",
                ui::cyan(&ix.program),
                ix.name
            );
        }

        if !self.token_changes.is_empty() {
            let mut tokens = ui::table(&["Owner", "Mint", "Before", "After"]);
            for t in &self.token_changes {
                tokens.add_row([
                    short(&t.owner),
                    label(&t.mint).map_or_else(|| short(&t.mint), String::from),
                    t.before.clone(),
                    t.after.clone(),
                ]);
            }
            out += &format!("\n{}\n{tokens}\n", ui::bold("Token balance changes"));
        }

        if show_logs {
            out += &format!("\n{}\n", ui::bold("Program logs"));
            self.logs
                .iter()
                .for_each(|l| out += &format!("  {}\n", ui::dim(l)));
        }
        out += &format!(
            "\n{}\n",
            ui::kv("Explorer", cluster.explorer_tx(&self.signature)).trim_end()
        );
        out
    }
}

/// Инструкции верхнего уровня + их CPI в порядке исполнения.
/// Имена для непарсенных программ берутся из логов («Program log: Instruction: X»).
fn instruction_tree(message: &Value, meta: &Value, logs: &[String]) -> Vec<IxRow> {
    let inner: &[Value] = meta["innerInstructions"]
        .as_array()
        .map_or(&[], Vec::as_slice);
    let mut flat: Vec<(usize, &Value)> = vec![];
    for (i, ix) in message["instructions"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        flat.push((1, ix));
        for group in inner
            .iter()
            .filter(|g| g["index"].as_u64() == Some(i as u64))
        {
            for cpi in group["instructions"].as_array().into_iter().flatten() {
                let depth = cpi["stackHeight"].as_u64().map_or(2, |d| d as usize);
                flat.push((depth, cpi));
            }
        }
    }

    let invocations = invocations_from_logs(logs);
    let names_match = invocations.len() == flat.len();
    flat.iter()
        .enumerate()
        .map(|(i, (depth, ix))| {
            let program_id = ix["programId"].as_str().unwrap_or_default();
            let log_name = names_match.then(|| invocations[i].1.clone()).flatten();
            let (name, detail) = describe(ix, program_id, log_name);
            IxRow {
                depth: *depth,
                program: label(program_id).map_or_else(|| short(program_id), String::from),
                name,
                detail,
            }
        })
        .collect()
}

/// Порядок вызовов из логов: (program_id, имя инструкции из «Program log: Instruction: X»).
fn invocations_from_logs(logs: &[String]) -> Vec<(String, Option<String>)> {
    let mut calls: Vec<(String, Option<String>)> = vec![];
    let mut stack: Vec<usize> = vec![];
    for line in logs {
        let words: Vec<&str> = line.split_whitespace().collect();
        match words.as_slice() {
            ["Program", id, "invoke", _] => {
                stack.push(calls.len());
                calls.push((id.to_string(), None));
            }
            ["Program", _, "success"] | ["Program", _, "failed:", ..] => {
                stack.pop();
            }
            ["Program", "log:", "Instruction:", name] => {
                if let Some(&top) = stack.last() {
                    calls[top].1.get_or_insert_with(|| name.to_string());
                }
            }
            _ => {}
        }
    }
    calls
}

fn describe(ix: &Value, program_id: &str, log_name: Option<String>) -> (String, Option<String>) {
    match &ix["parsed"] {
        Value::Object(parsed) => (
            parsed["type"].as_str().unwrap_or("unknown").to_string(),
            parsed_detail(&parsed["info"]),
        ),
        Value::String(text) => ("memo".into(), Some(format!("\"{text}\""))),
        _ if program_id == COMPUTE_BUDGET => {
            compute_budget(ix["data"].as_str().unwrap_or_default())
        }
        _ => (log_name.unwrap_or_else(|| "unknown".into()), None),
    }
}

/// Compute Budget не парсится RPC-узлом — декодируем сами: [tag][u32/u64 LE].
fn compute_budget(data_b58: &str) -> (String, Option<String>) {
    let data = bs58::decode(data_b58).into_vec().unwrap_or_default();
    let le = |n: usize| {
        data.get(1..1 + n)
            .map(|b| b.iter().rev().fold(0u64, |acc, &x| acc << 8 | u64::from(x)))
    };
    match (data.first(), le(4), le(8)) {
        (Some(2), Some(units), _) => ("SetComputeUnitLimit".into(), Some(format!("{units} CU"))),
        (Some(3), _, Some(price)) => (
            "SetComputeUnitPrice".into(),
            Some(format!("{price} µlamports/CU")),
        ),
        (Some(1), Some(bytes), _) => ("RequestHeapFrame".into(), Some(format!("{bytes} bytes"))),
        (Some(4), Some(bytes), _) => (
            "SetLoadedAccountsDataSizeLimit".into(),
            Some(format!("{bytes} bytes")),
        ),
        _ => ("unknown".into(), None),
    }
}

/// Краткая суть распарсенной инструкции: сумма и получатель.
fn parsed_detail(info: &Value) -> Option<String> {
    let amount = if let Some(l) = info["lamports"].as_u64() {
        format!("{} SOL", fmt_sol(l))
    } else if let Some(ui) = info
        .pointer("/tokenAmount/uiAmountString")
        .and_then(Value::as_str)
    {
        format!("{ui} tokens")
    } else {
        format!("{} (raw units)", info["amount"].as_str()?)
    };
    let target = ["destination", "newAccount"]
        .iter()
        .find_map(|k| info[*k].as_str());
    Some(match target {
        Some(t) => format!("{amount} → {}", short(t)),
        None => amount,
    })
}

fn token_changes(meta: &Value) -> Vec<TokenChange> {
    let list = |k: &str| meta[k].as_array().cloned().unwrap_or_default();
    let (pre, post) = (list("preTokenBalances"), list("postTokenBalances"));
    let amount = |b: Option<&Value>| {
        b.and_then(|b| b.pointer("/uiTokenAmount/uiAmountString")?.as_str())
            .unwrap_or("0")
            .to_string()
    };
    let mut indexes: Vec<u64> = pre
        .iter()
        .chain(&post)
        .filter_map(|b| b["accountIndex"].as_u64())
        .collect();
    indexes.sort_unstable();
    indexes.dedup();
    indexes
        .into_iter()
        .filter_map(|i| {
            let find = |v: &[Value]| {
                v.iter()
                    .find(|b| b["accountIndex"].as_u64() == Some(i))
                    .cloned()
            };
            let (before, after) = (find(&pre), find(&post));
            let any = after.as_ref().or(before.as_ref())?;
            let change = TokenChange {
                owner: any["owner"].as_str().unwrap_or_default().to_string(),
                mint: any["mint"].as_str().unwrap_or_default().to_string(),
                before: amount(before.as_ref()),
                after: amount(after.as_ref()),
            };
            (change.before != change.after).then_some(change)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> TxReport {
        let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
        let json: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        TxReport::from_json("SIG", &json).unwrap()
    }

    #[test]
    fn devnet_transfer_summary() {
        let r = fixture("devnet_transfer");
        assert_eq!(
            (r.slot, r.fee, r.compute_units),
            (504_365_287, 79_934, Some(450))
        );
        assert_eq!(r.version, "legacy");
        assert_eq!(r.error, None);
        assert_eq!(r.block_time, Some(1_790_415_973));
    }

    #[test]
    fn devnet_transfer_accounts_and_balance_changes() {
        let r = fixture("devnet_transfer");
        assert_eq!(r.accounts.len(), 4);
        let payer = &r.accounts[0];
        assert!(payer.signer && payer.writable);
        assert_eq!(payer.sol_delta, -2_000_079_934);
        assert_eq!(r.accounts[1].sol_delta, 2_000_000_000);
        assert!(!r.accounts[2].writable && !r.accounts[2].signer);
    }

    #[test]
    fn decodes_compute_budget_and_parsed_transfer() {
        let r = fixture("devnet_transfer");
        let names: Vec<_> = r
            .instructions
            .iter()
            .map(|i| (i.program.as_str(), i.name.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("Compute Budget", "SetComputeUnitPrice"),
                ("Compute Budget", "SetComputeUnitLimit"),
                ("System Program", "transfer"),
            ]
        );
        assert_eq!(r.instructions[1].detail.as_deref(), Some("562 CU"));
        assert_eq!(
            r.instructions[2].detail.as_deref(),
            Some("2 SOL → 8uXE…NpPQ")
        );
    }

    #[test]
    fn swap_builds_cpi_tree_with_names_from_logs() {
        let r = fixture("mainnet_swap");
        assert_eq!(r.instructions.len(), 14); // 5 верхнего уровня + 9 CPI
        let jup = r
            .instructions
            .iter()
            .position(|i| i.program == "Jupiter v6")
            .unwrap();
        assert_eq!(
            (r.instructions[jup].depth, r.instructions[jup].name.as_str()),
            (1, "RouteV2")
        );
        let ray = &r.instructions[jup + 1];
        assert_eq!(
            (ray.depth, ray.program.as_str(), ray.name.as_str()),
            (2, "Raydium CPMM", "SwapBaseInput")
        );
        assert_eq!(r.instructions[jup + 2].depth, 3);
        assert_eq!(r.version, "1");
    }

    #[test]
    fn swap_token_balance_changes() {
        let r = fixture("mainnet_swap");
        let mine = r
            .token_changes
            .iter()
            .find(|t| {
                t.owner == "CfmuThqjzkekEPCmvsqu9dqepS5DSR4oY56H4Pkn7MMf"
                    && t.mint.starts_with("E8fs")
            })
            .unwrap();
        assert_eq!(
            (mine.before.as_str(), mine.after.as_str()),
            ("1224051.066683", "1531595.591301")
        );
    }

    #[test]
    fn render_contains_key_facts() {
        let out = fixture("devnet_transfer").render(&Cluster::parse("devnet"), true);
        for needle in [
            "SIG",
            "Success",
            "504365287",
            "0.000079934",
            "System Program",
            "SetComputeUnitLimit",
            "+2",
            "invoke [1]",
            "?cluster=devnet",
        ] {
            assert!(out.contains(needle), "render must contain {needle}:\n{out}");
        }
    }

    #[test]
    fn rejects_non_transaction_json() {
        assert!(matches!(
            TxReport::from_json("SIG", &serde_json::json!({"foo": 1})),
            Err(Error::BadResponse(_))
        ));
    }
}

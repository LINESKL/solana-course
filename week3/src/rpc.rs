//! JSON-RPC клиент узла Solana. Транспорт спрятан за трейтом `Rpc`,
//! поэтому логика разбора ответов тестируется без сети.

use crate::error::{Error, Result};
use crate::pubkey::{Pubkey, decode32};
use base64::Engine;
use serde_json::{Value, json};
use std::time::Duration;

pub trait Rpc {
    /// Вызов метода; возвращает поле `result` ответа.
    fn call(&self, method: &str, params: Value) -> Result<Value>;
}

pub struct HttpRpc {
    url: String,
}

impl HttpRpc {
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_string(),
        }
    }
}

impl Rpc for HttpRpc {
    fn call(&self, method: &str, params: Value) -> Result<Value> {
        let request = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let response: Value = ureq::post(&self.url)
            .send_json(&request)
            .and_then(|mut r| r.body_mut().read_json())
            .map_err(|e| match e {
                ureq::Error::StatusCode(429) => Error::Http(
                    "429 Too Many Requests: the public RPC is rate-limiting you, retry later"
                        .into(),
                ),
                other => Error::Http(format!("{}: {other}", self.url)),
            })?;
        unwrap_response(response)
    }
}

/// Разбирает конверт JSON-RPC 2.0: либо `result`, либо `error`.
fn unwrap_response(mut response: Value) -> Result<Value> {
    if let Some(err) = response.get("error") {
        return Err(Error::Rpc {
            code: err["code"].as_i64().unwrap_or_default(),
            message: err["message"]
                .as_str()
                .unwrap_or("unknown error")
                .to_string(),
        });
    }
    match response.get_mut("result") {
        Some(result) => Ok(result.take()),
        None => Err(Error::BadResponse(response.to_string())),
    }
}

fn field<'a>(v: &'a Value, pointer: &str) -> Result<&'a Value> {
    v.pointer(pointer)
        .ok_or_else(|| Error::BadResponse(format!("missing {pointer} in {v}")))
}

fn as_u64(v: &Value, pointer: &str) -> Result<u64> {
    field(v, pointer)?
        .as_u64()
        .ok_or_else(|| Error::BadResponse(format!("{pointer} is not a number")))
}

fn as_str<'a>(v: &'a Value, pointer: &str) -> Result<&'a str> {
    field(v, pointer)?
        .as_str()
        .ok_or_else(|| Error::BadResponse(format!("{pointer} is not a string")))
}

/// Кластер: devnet / testnet / mainnet / localhost или произвольный URL.
pub struct Cluster {
    pub name: String,
    pub url: String,
}

impl Cluster {
    pub fn parse(s: &str) -> Self {
        let (name, url) = match s {
            "d" | "devnet" => ("devnet", "https://api.devnet.solana.com"),
            "t" | "testnet" => ("testnet", "https://api.testnet.solana.com"),
            "m" | "mainnet" | "mainnet-beta" => ("mainnet", "https://api.mainnet-beta.solana.com"),
            "l" | "localhost" => ("localhost", "http://127.0.0.1:8899"),
            url => ("custom", url),
        };
        Self {
            name: name.into(),
            url: url.into(),
        }
    }

    pub fn is_mainnet(&self) -> bool {
        self.name == "mainnet"
    }

    pub fn explorer_tx(&self, signature: &str) -> String {
        let query = match self.name.as_str() {
            "mainnet" => String::new(),
            "devnet" | "testnet" => format!("?cluster={}", self.name),
            _ => format!("?cluster=custom&customUrl={}", self.url),
        };
        format!("https://explorer.solana.com/tx/{signature}{query}")
    }
}

pub fn get_balance(rpc: &impl Rpc, pubkey: &Pubkey) -> Result<u64> {
    as_u64(
        &rpc.call("getBalance", json!([pubkey.to_string()]))?,
        "/value",
    )
}

pub fn latest_blockhash(rpc: &impl Rpc) -> Result<[u8; 32]> {
    let result = rpc.call("getLatestBlockhash", json!([{"commitment": "confirmed"}]))?;
    let hash = as_str(&result, "/value/blockhash")?;
    decode32(hash).ok_or_else(|| Error::BadResponse(format!("bad blockhash {hash}")))
}

pub fn send_transaction(rpc: &impl Rpc, wire: &[u8]) -> Result<String> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(wire);
    let result = rpc.call(
        "sendTransaction",
        json!([encoded, {"encoding": "base64", "preflightCommitment": "confirmed"}]),
    )?;
    Ok(as_str(&result, "")?.to_string())
}

pub fn request_airdrop(rpc: &impl Rpc, pubkey: &Pubkey, lamports: u64) -> Result<String> {
    let result = rpc.call("requestAirdrop", json!([pubkey.to_string(), lamports]))?;
    Ok(as_str(&result, "")?.to_string())
}

/// Опрашивает статус, пока транзакция не станет confirmed/finalized или не упадёт.
pub fn wait_for_confirmation(
    rpc: &impl Rpc,
    signature: &str,
    attempts: u32,
    delay: Duration,
) -> Result<()> {
    for _ in 0..attempts {
        let result = rpc.call("getSignatureStatuses", json!([[signature]]))?;
        let status = field(&result, "/value/0")?;
        if !status.is_null() {
            if !status["err"].is_null() {
                return Err(Error::TxFailed(status["err"].to_string()));
            }
            if matches!(
                status["confirmationStatus"].as_str(),
                Some("confirmed" | "finalized")
            ) {
                return Ok(());
            }
        }
        std::thread::sleep(delay);
    }
    Err(Error::Timeout(signature.to_string()))
}

pub fn get_transaction(rpc: &impl Rpc, signature: &str) -> Result<Value> {
    let config = json!({"encoding": "jsonParsed", "maxSupportedTransactionVersion": 1, "commitment": "confirmed"});
    match rpc.call("getTransaction", json!([signature, config]))? {
        Value::Null => Err(Error::TxNotFound(signature.to_string())),
        tx => Ok(tx),
    }
}

#[derive(Debug, PartialEq)]
pub struct AccountInfo {
    pub lamports: u64,
    pub owner: String,
    pub executable: bool,
    pub data_len: usize,
}

pub fn get_account(rpc: &impl Rpc, pubkey: &Pubkey) -> Result<Option<AccountInfo>> {
    let result = rpc.call(
        "getAccountInfo",
        json!([pubkey.to_string(), {"encoding": "base64"}]),
    )?;
    let account = field(&result, "/value")?;
    if account.is_null() {
        return Ok(None);
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(as_str(account, "/data/0")?)
        .map_err(|e| Error::BadResponse(format!("account data: {e}")))?;
    Ok(Some(AccountInfo {
        lamports: as_u64(account, "/lamports")?,
        owner: as_str(account, "/owner")?.to_string(),
        executable: account["executable"].as_bool().unwrap_or(false),
        data_len: data.len(),
    }))
}

#[derive(Debug, PartialEq)]
pub struct SignatureInfo {
    pub signature: String,
    pub slot: u64,
    pub block_time: Option<i64>,
    pub failed: bool,
    pub memo: Option<String>,
}

pub fn signatures_for_address(
    rpc: &impl Rpc,
    pubkey: &Pubkey,
    limit: usize,
) -> Result<Vec<SignatureInfo>> {
    let result = rpc.call(
        "getSignaturesForAddress",
        json!([pubkey.to_string(), {"limit": limit}]),
    )?;
    let items = result
        .as_array()
        .ok_or_else(|| Error::BadResponse("expected an array".into()))?;
    items
        .iter()
        .map(|item| {
            Ok(SignatureInfo {
                signature: as_str(item, "/signature")?.to_string(),
                slot: as_u64(item, "/slot")?,
                block_time: item["blockTime"].as_i64(),
                failed: !item["err"].is_null(),
                memo: item["memo"].as_str().map(String::from),
            })
        })
        .collect()
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    /// Отдаёт заранее заготовленные ответы по очереди и запоминает вызванные методы.
    #[derive(Default)]
    pub struct MockRpc {
        pub responses: RefCell<VecDeque<Result<Value>>>,
        pub calls: RefCell<Vec<String>>,
    }

    impl MockRpc {
        pub fn with(responses: Vec<Result<Value>>) -> Self {
            Self {
                responses: RefCell::new(responses.into()),
                ..Default::default()
            }
        }
    }

    impl Rpc for MockRpc {
        fn call(&self, method: &str, _params: Value) -> Result<Value> {
            self.calls.borrow_mut().push(method.to_string());
            self.responses
                .borrow_mut()
                .pop_front()
                .expect("unexpected RPC call")
        }
    }

    const ADDR: &str = "2ag4fKAcRh6xBdtA3YojgdRoBJ4jRYxQSezDECQWgCoG";

    #[test]
    fn unwraps_result_and_error_envelopes() {
        assert_eq!(
            unwrap_response(json!({"jsonrpc": "2.0", "result": 5, "id": 1})).unwrap(),
            json!(5)
        );
        let err = unwrap_response(json!({"error": {"code": -32602, "message": "Invalid param"}}))
            .unwrap_err();
        assert!(matches!(err, Error::Rpc { code: -32602, .. }));
    }

    #[test]
    fn parses_cluster_aliases_and_urls() {
        assert_eq!(
            Cluster::parse("devnet").url,
            "https://api.devnet.solana.com"
        );
        assert_eq!(Cluster::parse("mainnet-beta").name, "mainnet");
        assert!(Cluster::parse("m").is_mainnet());
        let custom = Cluster::parse("http://127.0.0.1:8899");
        assert_eq!(custom.url, "http://127.0.0.1:8899");
        assert!(
            Cluster::parse("devnet")
                .explorer_tx("SIG")
                .ends_with("/tx/SIG?cluster=devnet")
        );
        assert!(
            !Cluster::parse("mainnet")
                .explorer_tx("SIG")
                .contains("cluster")
        );
    }

    #[test]
    fn reads_balance_value() {
        let rpc = MockRpc::with(vec![Ok(
            json!({"context": {"slot": 1}, "value": 7_999_920_066u64}),
        )]);
        assert_eq!(
            get_balance(&rpc, &ADDR.parse().unwrap()).unwrap(),
            7_999_920_066
        );
        assert_eq!(rpc.calls.borrow()[0], "getBalance");
    }

    #[test]
    fn confirmation_waits_then_succeeds() {
        let rpc = MockRpc::with(vec![
            Ok(json!({"value": [null]})),
            Ok(json!({"value": [{"confirmationStatus": "processed", "err": null}]})),
            Ok(json!({"value": [{"confirmationStatus": "confirmed", "err": null}]})),
        ]);
        wait_for_confirmation(&rpc, "SIG", 5, Duration::ZERO).unwrap();
        assert_eq!(rpc.calls.borrow().len(), 3);
    }

    #[test]
    fn confirmation_reports_onchain_failure_and_timeout() {
        let failed = MockRpc::with(vec![Ok(
            json!({"value": [{"confirmationStatus": "confirmed", "err": {"InstructionError": [0, "Custom"]}}]}),
        )]);
        assert!(matches!(
            wait_for_confirmation(&failed, "SIG", 5, Duration::ZERO),
            Err(Error::TxFailed(_))
        ));

        let pending = MockRpc::with(vec![
            Ok(json!({"value": [null]})),
            Ok(json!({"value": [null]})),
        ]);
        assert!(matches!(
            wait_for_confirmation(&pending, "SIG", 2, Duration::ZERO),
            Err(Error::Timeout(_))
        ));
    }

    #[test]
    fn missing_transaction_is_a_clear_error() {
        let rpc = MockRpc::with(vec![Ok(Value::Null)]);
        assert!(matches!(
            get_transaction(&rpc, "SIG"),
            Err(Error::TxNotFound(_))
        ));
    }

    #[test]
    fn decodes_account_info() {
        let rpc = MockRpc::with(vec![Ok(json!({"value": {
            "lamports": 1_461_600, "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            "executable": false, "data": ["AAECAw==", "base64"], "rentEpoch": 0, "space": 4
        }}))]);
        let info = get_account(&rpc, &ADDR.parse().unwrap()).unwrap().unwrap();
        assert_eq!(
            info,
            AccountInfo {
                lamports: 1_461_600,
                owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".into(),
                executable: false,
                data_len: 4
            }
        );

        let empty = MockRpc::with(vec![Ok(json!({"value": null}))]);
        assert_eq!(get_account(&empty, &ADDR.parse().unwrap()).unwrap(), None);
    }

    #[test]
    fn maps_signature_history() {
        let rpc = MockRpc::with(vec![Ok(json!([
            {"signature": "A", "slot": 10, "blockTime": 1_790_415_973, "err": null, "memo": null},
            {"signature": "B", "slot": 9, "blockTime": null, "err": {"x": 1}, "memo": "[5] hello"}
        ]))]);
        let list = signatures_for_address(&rpc, &ADDR.parse().unwrap(), 2).unwrap();
        assert_eq!(
            list[0],
            SignatureInfo {
                signature: "A".into(),
                slot: 10,
                block_time: Some(1_790_415_973),
                failed: false,
                memo: None
            }
        );
        assert!(list[1].failed);
        assert_eq!(list[1].memo.as_deref(), Some("[5] hello"));
    }
}

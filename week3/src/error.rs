use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid amount '{0}': expected SOL with up to 9 decimals")]
    InvalidAmount(String),
    #[error("invalid address '{0}': expected a base58 32-byte public key")]
    InvalidPubkey(String),
    #[error("keypair {path}: {reason}")]
    Keypair { path: String, reason: String },
    #[error("RPC error {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("network error: {0}")]
    Http(String),
    #[error("unexpected RPC response: {0}")]
    BadResponse(String),
    #[error("transaction {0} not found (still processing, or wrong cluster? try --url)")]
    TxNotFound(String),
    #[error("{0} is read-only in solx: sending transactions there is disabled")]
    ReadOnlyCluster(String),
    #[error("insufficient funds: need {need} SOL, have {have} SOL")]
    InsufficientFunds { need: String, have: String },
    #[error("transaction {0} was not confirmed in time")]
    Timeout(String),
    #[error("transaction failed on-chain: {0}")]
    TxFailed(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

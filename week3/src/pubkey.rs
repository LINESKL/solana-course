use crate::error::Error;
use std::fmt;
use std::str::FromStr;

/// Адрес Solana: 32 байта публичного ключа Ed25519, в тексте — base58.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Pubkey(pub [u8; 32]);

pub const SYSTEM_PROGRAM: Pubkey = Pubkey([0; 32]);
pub const MEMO_PROGRAM: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/// base58 -> ровно 32 байта (подходит и для адресов, и для blockhash).
pub fn decode32(s: &str) -> Option<[u8; 32]> {
    bs58::decode(s).into_vec().ok()?.try_into().ok()
}

impl FromStr for Pubkey {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        decode32(s)
            .map(Pubkey)
            .ok_or_else(|| Error::InvalidPubkey(s.to_string()))
    }
}

impl fmt::Display for Pubkey {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(&bs58::encode(self.0).into_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_program_is_all_zeros_in_base58() {
        assert_eq!(
            SYSTEM_PROGRAM.to_string(),
            "11111111111111111111111111111111"
        );
    }

    #[test]
    fn roundtrips_base58() {
        let s = "2ag4fKAcRh6xBdtA3YojgdRoBJ4jRYxQSezDECQWgCoG";
        assert_eq!(s.parse::<Pubkey>().unwrap().to_string(), s);
    }

    #[test]
    fn rejects_wrong_length_and_alphabet() {
        assert!("abc".parse::<Pubkey>().is_err()); // слишком коротко
        assert!(
            "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"
                .parse::<Pubkey>()
                .is_err()
        ); // не base58
    }
}

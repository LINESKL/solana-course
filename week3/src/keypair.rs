//! Ключи Ed25519. Файл совместим с `solana-keygen`: JSON-массив из 64 байт
//! (32 байта секрета + 32 байта публичного ключа).

use crate::error::{Error, Result};
use crate::pubkey::Pubkey;
use ed25519_dalek::{Signer, SigningKey};
use std::path::Path;

pub struct Keypair(SigningKey);

impl Keypair {
    pub fn generate() -> Result<Self> {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(Self::from_seed(seed))
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self(SigningKey::from_bytes(&seed))
    }

    pub fn pubkey(&self) -> Pubkey {
        Pubkey(self.0.verifying_key().to_bytes())
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.0.sign(message).to_bytes()
    }

    pub fn read(path: &Path) -> Result<Self> {
        let fail = |reason: String| Error::Keypair {
            path: path.display().to_string(),
            reason,
        };
        let text = std::fs::read_to_string(path)
            .map_err(|e| fail(format!("{e} (create one with `solx keygen`)")))?;
        let bytes: Vec<u8> =
            serde_json::from_str(&text).map_err(|e| fail(format!("not a JSON byte array: {e}")))?;
        let bytes: [u8; 64] = bytes
            .try_into()
            .map_err(|b: Vec<u8>| fail(format!("expected 64 bytes, got {}", b.len())))?;
        // from_keypair_bytes проверяет, что публичная половина соответствует секретной
        SigningKey::from_keypair_bytes(&bytes)
            .map(Self)
            .map_err(|_| fail("public key does not match secret key".into()))
    }

    /// Пишет файл с правами 0600: секретный ключ не должен читаться другими.
    pub fn write(&self, path: &Path) -> Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let json =
            serde_json::to_string(&self.0.to_keypair_bytes().to_vec()).expect("bytes serialize");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(json.as_bytes())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("solx-test-{}-{name}", std::process::id()))
    }

    #[test]
    fn seed_gives_known_address() {
        // тот же seed в @solana/web3.js: Keypair.fromSeed(new Uint8Array(32).fill(7))
        let kp = Keypair::from_seed([7; 32]);
        assert_eq!(
            kp.pubkey().to_string(),
            "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB"
        );
    }

    #[test]
    fn file_roundtrip_is_solana_keygen_compatible() {
        let path = tmp("roundtrip.json");
        let kp = Keypair::from_seed([7; 32]);
        kp.write(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let bytes: Vec<u8> = serde_json::from_str(&text).unwrap();
        assert_eq!(bytes.len(), 64);
        assert_eq!(Keypair::read(&path).unwrap().pubkey(), kp.pubkey());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_corrupted_file() {
        let path = tmp("broken.json");
        std::fs::write(&path, "[1,2,3]").unwrap();
        assert!(matches!(Keypair::read(&path), Err(Error::Keypair { .. })));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn generated_keys_differ() {
        assert_ne!(
            Keypair::generate().unwrap().pubkey(),
            Keypair::generate().unwrap().pubkey()
        );
    }
}

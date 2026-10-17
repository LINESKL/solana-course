//! Сборка и подпись legacy-транзакции Solana вручную, байт за байтом.
//!
//! Transaction = [compact-u16 кол-во подписей][подписи по 64 байта][Message]
//! Message     = [header: 3 байта][compact-u16 N][N адресов по 32 байта]
//!               [recent blockhash 32 байта][compact-u16 M][M инструкций]
//! Instruction = [индекс программы][compact-u16 K][K индексов аккаунтов]
//!               [compact-u16 L][L байт данных]

use crate::keypair::Keypair;
use crate::pubkey::{MEMO_PROGRAM, Pubkey, SYSTEM_PROGRAM};

#[derive(Clone, Debug, PartialEq)]
pub struct AccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(Clone, Debug)]
pub struct Instruction {
    pub program_id: Pubkey,
    pub accounts: Vec<AccountMeta>,
    pub data: Vec<u8>,
}

/// System Program: Transfer (индекс инструкции 2, u32 LE) + lamports (u64 LE).
pub fn transfer(from: Pubkey, to: Pubkey, lamports: u64) -> Instruction {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: SYSTEM_PROGRAM,
        accounts: vec![
            AccountMeta {
                pubkey: from,
                is_signer: true,
                is_writable: true,
            },
            AccountMeta {
                pubkey: to,
                is_signer: false,
                is_writable: true,
            },
        ],
        data,
    }
}

/// Memo Program: произвольный UTF-8 текст, сохраняется в логах транзакции.
pub fn memo(text: &str) -> Instruction {
    Instruction {
        program_id: MEMO_PROGRAM.parse().expect("valid memo id"),
        accounts: vec![],
        data: text.as_bytes().to_vec(),
    }
}

/// Длина в формате compact-u16: 7 бит на байт, старший бит = «есть продолжение».
pub fn compact_u16(mut n: usize, out: &mut Vec<u8>) {
    assert!(n <= usize::from(u16::MAX), "compact-u16 overflow");
    loop {
        let byte = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

#[derive(Debug)]
struct CompiledInstruction {
    program_index: u8,
    accounts: Vec<u8>,
    data: Vec<u8>,
}

#[derive(Debug)]
pub struct Message {
    header: [u8; 3],
    account_keys: Vec<Pubkey>,
    recent_blockhash: [u8; 32],
    instructions: Vec<CompiledInstruction>,
}

impl Message {
    /// Собирает уникальный список аккаунтов в порядке, который требует рантайм:
    /// signer+writable, signer+readonly, writable, readonly. Fee payer — всегда первый.
    pub fn new(instructions: &[Instruction], payer: Pubkey, recent_blockhash: [u8; 32]) -> Self {
        let mut metas = vec![AccountMeta {
            pubkey: payer,
            is_signer: true,
            is_writable: true,
        }];
        let program_metas = instructions.iter().map(|ix| AccountMeta {
            pubkey: ix.program_id,
            is_signer: false,
            is_writable: false,
        });
        for meta in instructions
            .iter()
            .flat_map(|ix| ix.accounts.iter().cloned())
            .chain(program_metas)
        {
            match metas.iter_mut().find(|m| m.pubkey == meta.pubkey) {
                // один аккаунт в нескольких инструкциях: права объединяются
                Some(existing) => {
                    existing.is_signer |= meta.is_signer;
                    existing.is_writable |= meta.is_writable;
                }
                None => metas.push(meta),
            }
        }
        metas.sort_by_key(|m| (!m.is_signer, !m.is_writable)); // stable: payer остаётся первым

        let count = |f: fn(&AccountMeta) -> bool| metas.iter().filter(|m| f(m)).count() as u8;
        let header = [
            count(|m| m.is_signer),
            count(|m| m.is_signer && !m.is_writable),
            count(|m| !m.is_signer && !m.is_writable),
        ];
        let account_keys: Vec<Pubkey> = metas.iter().map(|m| m.pubkey).collect();
        let index = |key: &Pubkey| {
            account_keys
                .iter()
                .position(|k| k == key)
                .expect("key compiled") as u8
        };
        let instructions = instructions
            .iter()
            .map(|ix| CompiledInstruction {
                program_index: index(&ix.program_id),
                accounts: ix.accounts.iter().map(|m| index(&m.pubkey)).collect(),
                data: ix.data.clone(),
            })
            .collect();
        Self {
            header,
            account_keys,
            recent_blockhash,
            instructions,
        }
    }

    pub fn serialize(&self) -> Vec<u8> {
        let mut out = self.header.to_vec();
        compact_u16(self.account_keys.len(), &mut out);
        self.account_keys
            .iter()
            .for_each(|k| out.extend_from_slice(&k.0));
        out.extend_from_slice(&self.recent_blockhash);
        compact_u16(self.instructions.len(), &mut out);
        for ix in &self.instructions {
            out.push(ix.program_index);
            compact_u16(ix.accounts.len(), &mut out);
            out.extend_from_slice(&ix.accounts);
            compact_u16(ix.data.len(), &mut out);
            out.extend_from_slice(&ix.data);
        }
        out
    }
}

pub struct Transaction {
    signature: [u8; 64],
    message: Message,
}

impl Transaction {
    /// solx подписывает только одним ключом — fee payer'ом.
    pub fn sign(message: Message, payer: &Keypair) -> Self {
        assert_eq!(
            message.header[0], 1,
            "solx supports single-signer transactions"
        );
        assert_eq!(
            message.account_keys[0],
            payer.pubkey(),
            "payer must be the first account"
        );
        Self {
            signature: payer.sign(&message.serialize()),
            message,
        }
    }

    /// Первая подпись и есть ID транзакции.
    pub fn signature(&self) -> String {
        bs58::encode(self.signature).into_string()
    }

    pub fn serialize(&self) -> Vec<u8> {
        let mut out = vec![];
        compact_u16(1, &mut out);
        out.extend_from_slice(&self.signature);
        out.extend(self.message.serialize());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn pk(s: &str) -> Pubkey {
        s.parse().unwrap()
    }

    #[test]
    fn compact_u16_matches_spec() {
        for (n, expected) in [
            (0, vec![0x00]),
            (127, vec![0x7f]),
            (128, vec![0x80, 0x01]),
            (16383, vec![0xff, 0x7f]),
            (16384, vec![0x80, 0x80, 0x01]),
        ] {
            let mut out = vec![];
            compact_u16(n, &mut out);
            assert_eq!(out, expected, "n = {n}");
        }
    }

    #[test]
    fn transfer_instruction_layout() {
        let ix = transfer(SYSTEM_PROGRAM, SYSTEM_PROGRAM, 100_000_000);
        assert_eq!(ix.data, [2, 0, 0, 0, 0, 0xe1, 0xf5, 0x05, 0, 0, 0, 0]);
        assert!(ix.accounts[0].is_signer && ix.accounts[0].is_writable);
        assert!(!ix.accounts[1].is_signer && ix.accounts[1].is_writable);
    }

    #[test]
    fn orders_and_dedupes_accounts() {
        let payer = pk("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");
        let to = pk("J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf");
        let msg = Message::new(
            &[memo("hi"), transfer(payer, to, 1), transfer(payer, to, 2)],
            payer,
            [0; 32],
        );
        // payer первым, writable раньше readonly, дубликаты схлопнуты
        assert_eq!(
            msg.account_keys,
            [payer, to, pk(MEMO_PROGRAM), SYSTEM_PROGRAM]
        );
        assert_eq!(msg.header, [1, 0, 2]);
    }

    /// Эталон получен из официальной @solana/web3.js с теми же ключами,
    /// blockhash и инструкциями — наша сериализация и подпись должны совпасть побайтно.
    #[test]
    fn signed_bytes_match_solana_web3js() {
        let payer = Keypair::from_seed([7; 32]);
        let to = Keypair::from_seed([9; 32]).pubkey();
        let blockhash =
            crate::pubkey::decode32("EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k").unwrap();
        let msg = Message::new(
            &[transfer(payer.pubkey(), to, 100_000_000), memo("hello")],
            payer.pubkey(),
            blockhash,
        );
        let tx = Transaction::sign(msg, &payer);

        let expected = "Ac83z4v2T/lUdLR1Z1YbFNaSFtK9wZn67ygkV3FcyXHyGOTQ615g0EmFcoGh/XJeOzzIDUh5Jb0dRP8PGvyQVAMBAAIE6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iz9FyQ4WqDHW2T7eM1gL6HZkf3r92sTxY7XAurINen2GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABUpTWpkpIQZNJOhxYNo4fHw1td28kruB5B+oQEEFRI3Emud2A3ggVPF6nezqQ7RE66DtsSxvHTHG4OSoS/BS6wICAgABDAIAAAAA4fUFAAAAAAMABWhlbGxv";
        assert_eq!(
            base64::engine::general_purpose::STANDARD.encode(tx.serialize()),
            expected
        );
        assert_eq!(
            tx.signature(),
            "59HtbqPWGBz8n7WWoqiNfDZP4UYCoxg1DPKMwWZ3JY2DZwGhvmaJ34YCdUjLvKhn9cfpBvw1wxv7PktaZgv213Hk"
        );
    }
}

# solx — мини-CLI для Solana на Rust

Консольный клиент Solana, написанный с нуля: без `solana-sdk` и `solana-client`.
Транзакции собираются, сериализуются и подписываются вручную, байт за байтом.
Корректность подтверждена тестом: байты совпадают с официальной `@solana/web3.js`.

```text
solx keygen                       новый ключ Ed25519 (файл совместим с solana-keygen)
solx address                      адрес кошелька
solx balance [ADDRESS]            баланс
solx airdrop <SOL>                тестовые SOL (devnet/testnet)
solx transfer <TO> <SOL> [--memo] перевод SOL, транзакция собирается и подписывается solx
solx tx <SIGNATURE> [--logs]      разбор любой транзакции: аккаунты, инструкции, CPI, балансы
solx account <ADDRESS>            owner, lamports, executable, размер data
solx history [ADDRESS] [-n N]     последние транзакции адреса

Глобальные флаги: -u devnet|testnet|mainnet|localhost|<URL>   -k <keypair.json>
```

Mainnet доступен только для чтения: `transfer` и `airdrop` там отключены.

## Быстрый старт

```bash
cargo build --release
./target/release/solx keygen
./target/release/solx airdrop 1          # или https://faucet.solana.com
./target/release/solx transfer <ADDRESS> 0.1 --memo "hello"
./target/release/solx tx <SIGNATURE> --logs
./target/release/solx -u mainnet tx <SIGNATURE>   # разбор любой mainnet-транзакции
```

## Устройство

| Модуль | Ответственность |
|---|---|
| `pubkey.rs` | `Pubkey([u8; 32])`, base58, `FromStr` / `Display` |
| `keypair.rs` | Ed25519: генерация, подпись, файл-ключ с правами 0600 |
| `tx.rs` | `Instruction`, `AccountMeta`, компиляция `Message` (порядок и дедупликация аккаунтов, header), compact-u16, сериализация и подпись |
| `rpc.rs` | трейт `Rpc` + `HttpRpc` (JSON-RPC 2.0), типизированные методы, ожидание подтверждения |
| `inspect.rs` | разбор `getTransaction` в отчёт: дерево CPI, имена инструкций из логов, декодер Compute Budget |
| `format.rs` | SOL ↔ lamports без float, время UTC без внешних крейтов |
| `ui.rs`, `main.rs` | цвета (отключаются в pipe и при `NO_COLOR`), таблицы, подкоманды `clap` |

## Формат legacy-транзакции

```text
Transaction = compact-u16(кол-во подписей) | подписи по 64 байта | Message
Message     = header[3] | compact-u16(N) | N × pubkey[32] | recent_blockhash[32]
              | compact-u16(M) | M × CompiledInstruction
header      = [подписантов, readonly-подписантов, readonly-неподписантов]
Порядок аккаунтов: signer+writable → signer+readonly → writable → readonly (fee payer первым)
System Transfer data = u32 LE (2) | u64 LE (lamports)
```

## Тесты

```bash
cargo test     # 32 теста, сеть не нужна: RPC подменяется MockRpc, транзакции взяты из фикстур
```

Ключевой тест `signed_bytes_match_solana_web3js`: те же seed, blockhash и инструкции,
что в `@solana/web3.js`, дают побайтно ту же подписанную транзакцию.

# greeter — первая Solana-программа (native Rust)

Программа здоровается с вызвавшим и считает вызовы в отдельном аккаунте.
Devnet Program ID: `D3AeEuipHLfzvM79BH6Z1B96zD7xnzBSnyPo8wAhaBKB`

Аккаунты: `[0]` пользователь (signer), `[1]` аккаунт-счётчик (writable, владелец — программа, 4 байта u32).

```bash
cargo build-sbf                # сборка -> target/deploy/greeter.so
cargo test                     # 4 теста в litesvm, сеть не нужна
solana program deploy target/deploy/greeter.so
cd client && npm install && node greet.ts   # вызов программы на devnet
```

# Solana: задания курса

Все программы задеплоены в **devnet**.

| Неделя | Тема | Что внутри |
|---|---|---|
| [1](week1) | Вход в Web3: первая транзакция | Отчёт: кошелёк Phantom, airdrop, перевод и его разбор |
| [2](week2) | Как на самом деле работает Solana | Отчёт: разбор трёх транзакций mainnet (USDC, swap через Jupiter, создание токена) |
| [3](week3) | Rust для Solana-разработчика | `solx`: CLI-клиент Solana на Rust, транзакции собираются и подписываются вручную |
| [4](week4) | Первая Solana Program | `greeter`: программа на native Rust + TS-клиент. Program ID `D3AeEuipHLfzvM79BH6Z1B96zD7xnzBSnyPo8wAhaBKB` |
| [5](week5) | Anchor Framework | `counter`: счётчик на Anchor, PDA на пользователя. Program ID `83VG5r3tT8ByFZe1PA6zz5MKDaBMmUh3wouVGhxGYnrw` |
| [6](week6/profile) | Accounts, PDAs и архитектура | `profile`: on-chain профиль на двух PDA. Program ID `pHopUnPkowbYSm8PhfZupMGA1s3g8FBpBydCrHWmkST` |
| [7](week7) | SPL Tokens и Token Extensions | Токен NURK на Token-2022 с метаданными. Mint `9yLnzSXcMayUDWB2VwboFbqaCB6Vx8cK5MeZy34PhWfb` |

| [8–15](vault) | Сквозной проект Liquidity Vault | DeFi-vault на Anchor 0.31.1. Program ID `5KDkgHuq5VRs3jJcVGkFqNZYNBAvymVFnn6tDdABEUwp` |

В каждой папке есть README с командами сборки, тестов и запуска, а также отчёт по неделе (`.docx`).

**Инструменты:** Rust, Solana CLI (Agave 4.3), Anchor 1.2, Node.js 22.

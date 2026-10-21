# Liquidity Vault (недели 8–15)

Учебный DeFi-vault на Anchor 0.31.1. Пользователи вносят токены в общее хранилище и получают
share-токены — квитанцию о своей доле. Основа — шаблон преподавателя
([0xnurda/vault-dev](https://github.com/0xnurda/vault-dev/tree/students-vault-card)).

**Program ID (devnet):** [`5KDkgHuq5VRs3jJcVGkFqNZYNBAvymVFnn6tDdABEUwp`](https://explorer.solana.com/address/5KDkgHuq5VRs3jJcVGkFqNZYNBAvymVFnn6tDdABEUwp?cluster=devnet)

| Неделя | Что сделано |
|---|---|
| 8 | Каркас: vault, share-токен, хранилище, карточка пользователя. Пауза vault, закрытие карточки, время создания |

---

## Неделя 8 — каркас vault

### Схема аккаунтов

```mermaid
flowchart TD
    Admin([Админ — кошелёк]) -- initialize_vault --> VS
    User([Пользователь — кошелёк]) -- create_user_card --> UC

    subgraph program [Программа simple_vault]
        VS["VaultState (PDA)<br/>seeds: vault + token_mint<br/>admin, token_mint, paused…"]
        VT["Хранилище токенов (PDA)<br/>seeds: vault_tokens + token_mint<br/>authority = VaultState"]
        SM["Share mint (PDA)<br/>seeds: share_mint + token_mint<br/>mint authority = VaultState"]
        UC["UserCard (PDA)<br/>seeds: user_card + vault + user<br/>owner, created_at"]
    end

    VS -. распоряжается .-> VT
    VS -. выпускает .-> SM
    UC -. принадлежит vault .-> VS
```

| Аккаунт | Seeds | Владелец аккаунта (owner) | Кто распоряжается | Что хранит |
|---|---|---|---|---|
| `VaultState` | `["vault", token_mint]` | программа vault | меняет только программа; `set_paused` — только админ | admin, token_mint, адреса хранилища и share mint, bump, paused |
| Хранилище токенов | `["vault_tokens", token_mint]` | Token Program | **VaultState (PDA)** — authority токен-аккаунта | внесённые токены |
| Share mint | `["share_mint", token_mint]` | Token Program | **VaultState (PDA)** — mint authority | share-токены (6 знаков) |
| `UserCard` | `["user_card", vault_state, user]` | программа vault | пользователь (закрыть может только он) | vault, owner, bump, created_at |

Главная идея: хранилищем и share-токеном распоряжается **VaultState — PDA без приватного ключа**.
Подписать за него может только сама программа, поэтому ни админ, ни кто-то ещё не может
забрать токены или напечатать share-токены своей подписью.

### Инструкции

| Инструкция | Кто вызывает | Что делает |
|---|---|---|
| `initialize_vault` | админ | один раз создаёт VaultState, хранилище и share mint для токена |
| `create_user_card` | пользователь | создаёт свою карточку; на паузе — ошибка `VaultPaused` |
| `close_user_card` | владелец карточки | закрывает карточку, рента возвращается владельцу |
| `set_paused(bool)` | только админ (`has_one = admin`) | ставит vault на паузу или снимает с неё |

### Аккаунты в devnet

| Что | Ссылка |
|---|---|
| Программа | [5KDk…EUwp](https://explorer.solana.com/address/5KDkgHuq5VRs3jJcVGkFqNZYNBAvymVFnn6tDdABEUwp?cluster=devnet) |
| VaultState | [2Gqx…182d](https://explorer.solana.com/address/2GqxhmtHQR6L8BUD5mw9WmT47GaSchWV7pMiyvAm182d?cluster=devnet) |
| Токен vault (тестовый) | [AETY…Mtd3](https://explorer.solana.com/address/AETYRLKneVCEquYyrzedpQDWspskm8J5dr41QEimMtd3?cluster=devnet) |
| Хранилище токенов | [8urM…SRqi](https://explorer.solana.com/address/8urMhJnqeut6ZNsF3ZQVHDEh9DiPTcZ2tGzGCjveSRqi?cluster=devnet) |
| Share mint | [6spV…TaUqx](https://explorer.solana.com/address/6spVDyGK2CAEUNDB2mNXVf23Zx2kaExQSvQMZnZTaUqx?cluster=devnet) |
| Карточка пользователя | [GMKe…grP](https://explorer.solana.com/address/GMKeqbfv2iHiUfaCCah3XE2N6cz2QJH84jWRzQMVsgrP?cluster=devnet) |
| Транзакция `initialize_vault` | [5tAw…LnNCb](https://explorer.solana.com/tx/5tAwCt8Wn7PXpovLeRLab9Km1PxR97qpSeiLSi8fDnnAhbkVMVRsQDomo6mzycN3PVHExe6FXpkYt2CaqqKLnNCb?cluster=devnet) |
| Транзакция `create_user_card` | [vEbr…5CNg](https://explorer.solana.com/tx/vEbrAmQUcDpywEAJDS7qW1GSobdeHRkdQNac36oRm9a9nmpLbCWRDNhD68cSEXhoSXH77i3qdgrDuYfvPae5CNg?cluster=devnet) |

Все адреса сохранены в [`devnet.json`](devnet.json).

### Проверьте себя

- **Почему share-токен выпускает программа, а не администратор?** Mint authority share-токена —
  VaultState (PDA). Если бы выпускал админ, он мог бы напечатать себе share-токены и забрать
  чужую долю. Программа выпускает их только по правилам кода — при депозите.
- **Что такое PDA и почему у неё нет приватного ключа?** Адрес, вычисленный из seeds и ID
  программы так, что он специально не лежит на кривой Ed25519. Для такого адреса не существует
  приватного ключа, поэтому подписать за него может только программа (через `invoke_signed`).
- **Как найти карточку конкретного пользователя?** Вычислить адрес из seeds
  `["user_card", vault_state, user]` — хранить список пользователей не нужно.

---

## Запуск

Нужны: Rust, Solana CLI, **Anchor CLI 0.31.1**, Node.js 18+.

```bash
npm install                     # или yarn install
anchor build

# тесты на локальном валидаторе
anchor test --provider.cluster localnet

# тесты на devnet (программа уже задеплоена)
anchor test --provider.cluster devnet --skip-local-validator --skip-deploy

# деплой
anchor deploy --provider.cluster devnet

# vault в devnet из терминала
node scripts/devnet.mts init    # тестовый токен + vault
node scripts/devnet.mts card    # своя карточка
node scripts/devnet.mts show    # состояние и ссылки на Explorer
```

Кошелёк берётся из `~/.config/solana/id.json`. Ключи и seed-фразы в репозиторий не коммитятся
(см. `.gitignore`).

Если локальный валидатор не стартует с ошибкой `UnspecifiedIpAddr(0.0.0.0)` (новые версии
Solana CLI), в `Anchor.toml` в `[test.validator]` нужен `bind_address = "127.0.0.1"` — уже добавлен.

# profile — on-chain профиль на PDA (Anchor)

Devnet Program ID: `pHopUnPkowbYSm8PhfZupMGA1s3g8FBpBydCrHWmkST`

- `Profile` — PDA `["profile", владелец]`: username, bio, created_at, updated_at.
- `UsernameRecord` — PDA `["username", имя]`: владелец имени. Имена уникальны, профиль ищется по имени.

Инструкции: `create_profile(username, bio)`, `update_bio(bio)`, `delete_profile` (закрывает оба аккаунта).

```bash
npm install
anchor test --validator legacy                 # 8 тестов
anchor deploy --provider.cluster devnet
node client/profile.ts create <username> <bio>
node client/profile.ts bio <text>
node client/profile.ts show [username]
node client/profile.ts delete
```

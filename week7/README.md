# Свой токен на Token-2022 с метаданными

Mint (devnet): `9yLnzSXcMayUDWB2VwboFbqaCB6Vx8cK5MeZy34PhWfb` — Nurkanat Token (NURK), 6 decimals.
Метаданные хранятся в самом mint (расширения MetadataPointer + TokenMetadata).

```bash
npm install
node cli.ts create                    # создать токен (адрес сохранится в mint.json)
node cli.ts mint 1000000              # выпустить себе
node cli.ts transfer <адрес> 1000     # перевести
node cli.ts info [адрес]              # метаданные, supply, баланс

solana-test-validator                 # в отдельном окне
node --test token.test.ts             # 4 теста на локальном валидаторе
```

Ключ по умолчанию: `~/.config/solx/id.json` (можно задать `KEYPAIR=...`).

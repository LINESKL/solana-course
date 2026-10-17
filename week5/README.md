# counter — счётчик на Anchor

Devnet Program ID: `83VG5r3tT8ByFZe1PA6zz5MKDaBMmUh3wouVGhxGYnrw`

Счётчик — PDA `["counter", владелец]`, менять может только владелец (`has_one = authority`).
Инструкции: `initialize`, `increment`, `decrement` (не ниже нуля), `reset`.

```bash
npm install
anchor build
anchor test --validator legacy                 # 7 тестов на локальном валидаторе
anchor deploy --provider.cluster devnet
node client/counter.ts init | inc | dec | reset | show   # клиент на devnet
```

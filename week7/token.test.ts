// Тесты на локальном валидаторе (solana-test-validator на 127.0.0.1:8899).
// Запуск: node --test token.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { createToken, mintTokens, transferTokens, tokenInfo, balanceOf } from './token.ts';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const payer = Keypair.generate();
const friend = Keypair.generate().publicKey;
let mint: PublicKey;

before(async () => {
  const sig = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig);
});

test('createToken stores name, symbol, uri and extra fields in the mint', async () => {
  mint = await createToken(connection, payer, {
    name: 'Test Token', symbol: 'TST', uri: 'https://example.com/t.json', decimals: 6,
    extra: [['course', 'Solana']],
  });
  const info = await tokenInfo(connection, mint);
  assert.equal(info.name, 'Test Token');
  assert.equal(info.symbol, 'TST');
  assert.equal(info.uri, 'https://example.com/t.json');
  assert.deepEqual(info.extra, [['course', 'Solana']]);
  assert.equal(info.decimals, 6);
  assert.equal(info.supply, 0n);
  assert.equal(info.mintAuthority, payer.publicKey.toBase58());
});

test('mintTokens increases supply and owner balance', async () => {
  await mintTokens(connection, payer, mint, payer.publicKey, 1_000_000n * 10n ** 6n);
  assert.equal((await tokenInfo(connection, mint)).supply, 1_000_000_000_000n);
  assert.equal(await balanceOf(connection, mint, payer.publicKey), 1_000_000_000_000n);
});

test('transferTokens moves tokens and creates the recipient account', async () => {
  assert.equal(await balanceOf(connection, mint, friend), 0n);
  await transferTokens(connection, payer, mint, friend, 1_000n * 10n ** 6n);
  assert.equal(await balanceOf(connection, mint, friend), 1_000_000_000n);
  assert.equal(await balanceOf(connection, mint, payer.publicKey), 999_000_000_000n);
});

test('transferring more than the balance fails', async () => {
  // ошибка 0x1 у Token Program = InsufficientFunds
  await assert.rejects(transferTokens(connection, payer, mint, friend, 10n ** 15n), /insufficient funds|custom program error: 0x1/i);
});

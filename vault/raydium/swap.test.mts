// Тесты недели 12 на devnet: настоящий пул Raydium есть только там.
// Запуск: node --test --test-force-exit swap.test.mts   (тратит немного devnet SOL на комиссии)
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { connection, owner } from "./common.mts";
import { addresses, balance, initStrategy, quoteSwap, swap, vaultProgram } from "./vault.mts";

const UNIT = 1_000_000;
const a = addresses();
const errorCode = (e: any) => e?.error?.errorCode?.code ?? String(e?.message ?? e);

before(async () => {
  // стратегия создаётся один раз; повторный запуск тестов её переиспользует
  if (!(await connection.getAccountInfo(a.strategy))) await initStrategy();
});

test("стратегия хранит пул и второе хранилище, владелец хранилища — vault PDA", async () => {
  const strategy = await vaultProgram().account.strategy.fetch(a.strategy);
  assert.equal(strategy.pool.toBase58(), a.poolId.toBase58());
  assert.equal(strategy.secondMint.toBase58(), a.secondMint.toBase58());
  assert.equal(strategy.secondTokenAccount.toBase58(), a.secondTokenAccount.toBase58());
  const { getAccount } = await import("@solana/spl-token");
  const account = await getAccount(connection, a.secondTokenAccount);
  assert.equal(account.owner.toBase58(), a.vaultState.toBase58());
});

test("swap: vault меняет VLT на tUSD через пул Raydium", async () => {
  const amountIn = new BN(10 * UNIT);
  const [vltBefore, tusdBefore] = [await balance(a.vaultTokenAccount), await balance(a.secondTokenAccount)];
  const { expectedOut, price } = await quoteSwap(amountIn, true);
  const minOut = expectedOut.muln(99).divn(100); // slippage 1%

  await swap(amountIn, minOut, true);

  const [vltAfter, tusdAfter] = [await balance(a.vaultTokenAccount), await balance(a.secondTokenAccount)];
  assert.equal(vltBefore - vltAfter, BigInt(amountIn.toString()));
  assert.ok(tusdAfter - tusdBefore >= BigInt(minOut.toString()), "получено не меньше минимума");
  // продали VLT в пул -> VLT в пуле больше -> VLT дешевеет (цена пула = VLT за 1 tUSD растёт)
  const { price: priceAfter } = await quoteSwap(new BN(UNIT), true);
  assert.ok(priceAfter > price, `цена должна сдвинуться: ${price} -> ${priceAfter}`);
});

test("swap с завышенным минимумом отклоняется (защита от slippage)", async () => {
  const amountIn = new BN(5 * UNIT);
  const { expectedOut } = await quoteSwap(amountIn, true);
  const vltBefore = await balance(a.vaultTokenAccount);
  await assert.rejects(swap(amountIn, expectedOut.muln(2), true), (e) => {
    assert.match(errorCode(e), /TooLittleOutputReceived/);
    return true;
  });
  assert.equal(await balance(a.vaultTokenAccount), vltBefore, "токены vault не тронуты");
});

test("обратный swap: tUSD обратно в VLT", async () => {
  const amountIn = new BN(5 * UNIT);
  const vltBefore = await balance(a.vaultTokenAccount);
  const { expectedOut } = await quoteSwap(amountIn, false);
  await swap(amountIn, expectedOut.muln(99).divn(100), false);
  assert.ok((await balance(a.vaultTokenAccount)) > vltBefore);
});

test("swap может запускать только админ", async () => {
  const stranger = Keypair.generate();
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: stranger.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL })),
    [owner],
  );
  await assert.rejects(swap(new BN(UNIT), new BN(0), true, { signer: stranger }), (e) => {
    assert.match(errorCode(e), /ConstraintHasOne/);
    return true;
  });
});

test("повторно создать стратегию нельзя", async () => {
  await assert.rejects(initStrategy(), /already in use/);
});

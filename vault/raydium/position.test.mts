// Тесты недели 13 на devnet: vault открывает позицию в пуле Raydium, собирает комиссии и закрывает её.
// Запуск: node --test --test-force-exit position.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { connection, owner } from "./common.mts";
import {
  addresses, balance, closePosition, collectFees, marketSwap, openPosition, quoteSwap, rangeToTicks, vaultPositions,
} from "./vault.mts";

const UNIT = 1_000_000;
const a = addresses();
const errorCode = (e: any) => e?.error?.errorCode?.code ?? String(e?.message ?? e);
let nftMint: any;

test("open_position: vault кладёт оба токена в пул и получает NFT позиции", async () => {
  const { price } = await quoteSwap(new BN(UNIT), true); // VLT за 1 tUSD
  const vltPrice = 1 / price; // tUSD за 1 VLT
  const { tickLower, tickUpper } = await rangeToTicks(vltPrice * 0.95, vltPrice * 1.05); // ±5%
  const [vltBefore, tusdBefore] = [await balance(a.vaultTokenAccount), await balance(a.secondTokenAccount)];

  const opened = await openPosition(tickLower, tickUpper, new BN(100 * UNIT), new BN(80 * UNIT));
  nftMint = opened.nftMint;

  const positions = await vaultPositions();
  const position = positions.find((p) => p.nftMint.equals(nftMint));
  assert.ok(position, "NFT позиции принадлежит vault");
  assert.ok(position.liquidity.gtn(0), "в позиции есть ликвидность");
  assert.equal(position.tickLower, tickLower);
  // vault отдал tUSD ровно на базовую сумму и VLT не больше максимума
  assert.equal(tusdBefore - (await balance(a.secondTokenAccount)), 100n * BigInt(UNIT));
  const vltSpent = vltBefore - (await balance(a.vaultTokenAccount));
  assert.ok(vltSpent > 0n && vltSpent <= 80n * BigInt(UNIT), `VLT потрачено ${vltSpent}`);
});

test("collect_fees: после обменов других пользователей vault забирает комиссии", async () => {
  // обычные обмены с нашего кошелька (не vault) в обе стороны — пул берёт с них 0.25%
  await marketSwap(new BN(40 * UNIT), true);
  await marketSwap(new BN(80 * UNIT), false);
  const [vltBefore, tusdBefore] = [await balance(a.vaultTokenAccount), await balance(a.secondTokenAccount)];

  await collectFees(nftMint);

  const earnedVlt = (await balance(a.vaultTokenAccount)) - vltBefore;
  const earnedTusd = (await balance(a.secondTokenAccount)) - tusdBefore;
  assert.ok(earnedVlt > 0n && earnedTusd > 0n, `комиссии: ${earnedVlt} VLT, ${earnedTusd} tUSD`);
  // ликвидность при сборе комиссий не трогается
  assert.ok((await vaultPositions()).find((p) => p.nftMint.equals(nftMint))!.liquidity.gtn(0));
});

test("управлять позицией может только админ", async () => {
  const stranger = Keypair.generate();
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: stranger.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL })),
    [owner],
  );
  await assert.rejects(collectFees(nftMint, stranger), (e) => {
    assert.match(errorCode(e), /ConstraintHasOne/);
    return true;
  });
});

test("close_position с завышенным минимумом отклоняется", async () => {
  await assert.rejects(closePosition(nftMint, new BN(10_000 * UNIT), new BN(0)), (e) => {
    assert.match(errorCode(e), /PriceSlippageCheck|TooLittle|Slippage/i);
    return true;
  });
});

test("close_position: вся ликвидность возвращается в vault, позиция и NFT закрыты", async () => {
  const [vltBefore, tusdBefore] = [await balance(a.vaultTokenAccount), await balance(a.secondTokenAccount)];
  await closePosition(nftMint);
  assert.ok((await balance(a.vaultTokenAccount)) > vltBefore);
  assert.ok((await balance(a.secondTokenAccount)) > tusdBefore);
  assert.ok(!(await vaultPositions()).some((p) => p.nftMint.equals(nftMint)), "позиции больше нет");
});

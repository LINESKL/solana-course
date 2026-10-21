// Состояние пула и наших позиций: цена, ликвидность, сколько токенов в пуле, диапазоны позиций.
import { LiquidityMathUtil, TickUtil } from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import { explorer, initSdk, loadState, owner } from "./common.mts";

const raydium = await initSdk(true);
const state = loadState();
const { poolInfo, rpcPoolInfo } = await raydium.clmm.getPoolInfoFromRpc(state.poolId);
const { mintA, mintB } = poolInfo;
const name = (address: string) => (address === state.vaultToken ? "VLT" : address === state.tusd ? "tUSD" : address.slice(0, 4));
const [A, B] = [name(mintA.address), name(mintB.address)];
const price = new Decimal(poolInfo.price);
const fmt = (amount: { toString(): string }, decimals: number) => new Decimal(amount.toString()).div(10 ** decimals).toFixed(4);

console.log("Пул           ", explorer("address", poolInfo.id));
console.log("Токены        ", `A = ${A} (${mintA.address}), B = ${B} (${mintB.address})`);
console.log("Цена          ", `${price.toFixed(6)} ${B} за 1 ${A}  =  ${new Decimal(1).div(price).toFixed(6)} ${A} за 1 ${B}`);
console.log("Текущий тик   ", rpcPoolInfo.tickCurrent, `(шаг тиков ${poolInfo.config.tickSpacing}, комиссия ${poolInfo.config.tradeFeeRate / 10_000}%)`);
// mintAmountA/B — баланс vault-аккаунтов пула в минимальных единицах
console.log("В пуле        ", `${fmt(poolInfo.mintAmountA, mintA.decimals)} ${A} + ${fmt(poolInfo.mintAmountB, mintB.decimals)} ${B}`);
console.log("Ликвидность   ", rpcPoolInfo.liquidity.toString());

const positions = (await raydium.clmm.getOwnerPositionInfo({ programId: poolInfo.programId })).filter(
  (p) => p.poolId.toBase58() === poolInfo.id,
);
for (const p of positions) {
  // сколько токенов сейчас лежит в позиции при текущей цене
  const { amountA, amountB } = LiquidityMathUtil.getAmountsForLiquidity(
    rpcPoolInfo.sqrtPriceX64,
    TickUtil.getSqrtPriceAtTick(p.tickLower),
    TickUtil.getSqrtPriceAtTick(p.tickUpper),
    p.liquidity,
    false,
  );
  const priceAt = (tick: number) => TickUtil.tickToPrice(tick, mintA.decimals, mintB.decimals).toFixed(6);
  const inRange = rpcPoolInfo.tickCurrent >= p.tickLower && rpcPoolInfo.tickCurrent < p.tickUpper;
  console.log(`Позиция ${p.nftMint.toBase58()} (владелец ${owner.publicKey.toBase58().slice(0, 4)}…)`);
  console.log("  диапазон    ", `${priceAt(p.tickLower)} … ${priceAt(p.tickUpper)} ${B}/${A}  (тики ${p.tickLower}…${p.tickUpper})`, inRange ? "— цена внутри, позиция зарабатывает" : "— цена ВНЕ диапазона");
  console.log("  в позиции   ", `${fmt(amountA, mintA.decimals)} ${A} + ${fmt(amountB, mintB.decimals)} ${B}`);
  console.log("  комиссии    ", `${fmt(p.tokenFeesOwedA, mintA.decimals)} ${A} + ${fmt(p.tokenFeesOwedB, mintB.decimals)} ${B} (начисленные, ещё не собранные)`);
}
process.exit();

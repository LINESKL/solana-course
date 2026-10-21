// Шаг 3. Позиция с нашего кошелька в диапазоне ±RANGE% вокруг текущей цены — чтобы в пуле
// появилась ликвидность. Основано на src/clmm/createPosition.ts из raydium-sdk-V2-demo.
import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import Decimal from "decimal.js";
import { explorer, initSdk, loadState, saveState, txVersion } from "./common.mts";

const RANGE = Number(process.env.RANGE ?? 10); // ±10%
const BASE_AMOUNT = Number(process.env.AMOUNT ?? 10_000); // сколько токена A кладём

const raydium = await initSdk(true);
const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(loadState().poolId);
const { mintA, mintB } = poolInfo;
const price = new Decimal(poolInfo.price);

// цена → тик, выровненный по шагу тиков пула (tickSpacing)
const toTick = (p: Decimal) =>
  TickUtil.toTickIndex(TickUtil.priceToTick(p, mintA.decimals, mintB.decimals), poolInfo.config.tickSpacing);
const tickLower = toTick(price.mul(1 - RANGE / 100));
const tickUpper = toTick(price.mul(1 + RANGE / 100));
const priceAt = (tick: number) => TickUtil.tickToPrice(tick, mintA.decimals, mintB.decimals).toFixed(6);

console.log(`цена пула: ${price.toFixed(6)} ${mintB.symbol || "B"} за 1 ${mintA.symbol || "A"}`);
console.log(`диапазон: тики ${tickLower}…${tickUpper}, цены ${priceAt(tickLower)}…${priceAt(tickUpper)}`);

const baseAmount = new BN(BASE_AMOUNT).mul(new BN(10).pow(new BN(mintA.decimals)));
const { execute, extInfo } = await raydium.clmm.openPositionFromBase({
  poolInfo,
  poolKeys,
  tickLower,
  tickUpper,
  base: "MintA",
  baseAmount,
  // сколько токена B готовы отдать максимум (с запасом)
  otherAmountMax: baseAmount.mul(new BN(price.mul(2).ceil().toString())),
  ownerInfo: { useSOLBalance: false },
  nft2022: true,
  txVersion,
  computeBudgetConfig: { units: 600_000, microLamports: 100_000 },
});
const { txId } = await execute({ sendAndConfirm: true });
saveState({
  positionNft: extInfo.nftMint.toBase58(),
  positionTickLower: String(tickLower),
  positionTickUpper: String(tickUpper),
  openPositionTx: txId,
});
console.log("позиция открыта, NFT:", explorer("address", extInfo.nftMint.toBase58()));
console.log("транзакция:", explorer("tx", txId));
process.exit();

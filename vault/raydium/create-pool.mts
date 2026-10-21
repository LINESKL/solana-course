// Шаг 2. CLMM-пул Raydium из наших токенов с начальной ценой 1 VLT = 2 tUSD.
// Основано на src/clmm/createPool.ts из raydium-sdk-V2-demo.
import { DEVNET_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import { explorer, initSdk, loadState, saveState, txVersion } from "./common.mts";

const INITIAL_PRICE = new Decimal(2); // сколько tUSD за 1 VLT
const state = loadState();
if (state.poolId) throw new Error(`пул уже создан: ${state.poolId}`);

const raydium = await initSdk(true);
const mint1 = await raydium.token.getTokenInfo(state.vaultToken);
const mint2 = await raydium.token.getTokenInfo(state.tusd);
// конфиг пула: комиссия 0.25%, шаг тиков 60 (список: https://api-v3-devnet.raydium.io/main/clmm-config)
const configs = await raydium.api.getClmmConfigs();
const config = configs.find((c) => c.tradeFeeRate === 2500) ?? configs[0];

const { execute, extInfo } = await raydium.clmm.createPool({
  programId: DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID,
  mint1,
  mint2,
  ammConfig: { ...config, id: new PublicKey(config.id), fundOwner: "", description: "" },
  initialPrice: INITIAL_PRICE,
  txVersion,
});
const { txId } = await execute({ sendAndConfirm: true });
// все адреса пула (vault-аккаунты, observation, tick-массивы) — для CPI на неделях 12–13
const pool = Object.fromEntries(
  Object.entries(extInfo.address)
    .filter(([, value]: [string, any]) => value?.toBase58) // только адреса
    .map(([key, value]: [string, any]) => [key, value.toBase58()]),
) as Record<string, string>;
saveState({ clmmProgram: DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID.toBase58(), ammConfig: config.id, poolId: pool.id, createPoolTx: txId });
saveState(Object.fromEntries(Object.entries(pool).map(([k, v]) => [`pool_${k}`, v])));
console.log("пул создан:", explorer("address", pool.id));
console.log(pool);
console.log("транзакция:", explorer("tx", txId));
process.exit();

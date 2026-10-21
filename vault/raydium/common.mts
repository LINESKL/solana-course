// Общие настройки для скриптов Raydium: devnet, наш кошелёк, SDK, файл с адресами.
// Основано на config.ts из raydium-io/raydium-sdk-V2-demo.
import { Raydium, TxVersion, DEV_API_URLS } from "@raydium-io/raydium-sdk-v2";
import { Connection, Keypair } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
export const owner = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.KEYPAIR ?? `${homedir()}/.config/solana/id.json`, "utf8"))),
);
export const txVersion = TxVersion.V0;
export const explorer = (kind: "address" | "tx", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

let raydium: Raydium | undefined;
export async function initSdk(loadToken = false) {
  if (raydium) return raydium;
  raydium = await Raydium.load({
    owner,
    connection,
    cluster: "devnet",
    disableFeatureCheck: true,
    disableLoadToken: !loadToken,
    blockhashCommitment: "finalized",
    urlConfigs: {
      ...DEV_API_URLS,
      BASE_HOST: "https://api-v3-devnet.raydium.io",
      OWNER_BASE_HOST: "https://owner-v1-devnet.raydium.io",
      SWAP_HOST: "https://transaction-v1-devnet.raydium.io",
      CPMM_LOCK: "https://dynamic-ipfs-devnet.raydium.io/lock/cpmm/position",
    },
  });
  patchEmptyPoolTicks(raydium);
  return raydium;
}

// Баг SDK 0.2.74: getPoolInfoFromRpc делает Object.values(tickData[poolId]), но у нового пула
// без ликвидности ещё нет tick-массивов и записи нет — падает с "Cannot convert undefined to object".
// Подставляем пустые данные, чтобы можно было открыть первую позицию.
function patchEmptyPoolTicks(sdk: Raydium) {
  const original = sdk.clmm.getComputeClmmPoolInfos.bind(sdk.clmm);
  sdk.clmm.getComputeClmmPoolInfos = async (args) => {
    const result = await original(args);
    for (const poolId of Object.keys(args.clmmPoolsRpcInfo)) result.computePoolTickData[poolId] ??= {};
    return result;
  };
}

// Адреса пула, токенов и позиции — понадобятся на неделях 12–13
const STATE_FILE = new URL("../raydium.json", import.meta.url);
export type PoolState = Record<string, string>;
export const loadState = (): PoolState => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {});
export const saveState = (patch: PoolState) =>
  writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...patch }, null, 2) + "\n");

// Токен vault из недели 9
export const vaultState = (): PoolState => JSON.parse(readFileSync(new URL("../devnet.json", import.meta.url), "utf8"));

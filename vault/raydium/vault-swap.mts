// Обмен из vault через пул Raydium (CPI), только админ.
//   node vault-swap.mts sell 100        — отдать 100 VLT, получить tUSD (минимум = ожидаемое − 1%)
//   node vault-swap.mts buy 50          — отдать 50 tUSD, получить VLT
//   node vault-swap.mts sell 100 fail   — нарочно завысить минимум вдвое: Raydium отклонит обмен
// Ссылки на транзакции сохраняются в raydium.json.
import BN from "bn.js";
import Decimal from "decimal.js";
import { explorer, saveState } from "./common.mts";
import { addresses, balance, quoteSwap, swap } from "./vault.mts";

const [side, amountArg, mode] = process.argv.slice(2);
if (!["sell", "buy"].includes(side) || !amountArg) {
  console.error("usage: node vault-swap.mts <sell|buy> <amount> [fail]");
  process.exit(1);
}
const sellVaultToken = side === "sell";
const UNIT = 1_000_000;
const amountIn = new BN(new Decimal(amountArg).mul(UNIT).toFixed(0));
const a = addresses();
const show = async (label: string) => {
  const { price } = await quoteSwap(new BN(UNIT), true);
  const [vlt, tusd] = [await balance(a.vaultTokenAccount), await balance(a.secondTokenAccount)];
  console.log(`${label}: цена пула ${new Decimal(1).div(price).toFixed(6)} tUSD за 1 VLT | в vault ${Number(vlt) / UNIT} VLT + ${Number(tusd) / UNIT} tUSD`);
};

await show("до   ");
const { expectedOut } = await quoteSwap(amountIn, sellVaultToken);
const minOut = mode === "fail" ? expectedOut.muln(2) : expectedOut.muln(99).divn(100);
console.log(`ожидаем ${expectedOut.toNumber() / UNIT}, минимум ${minOut.toNumber() / UNIT} ${sellVaultToken ? "tUSD" : "VLT"}`);
try {
  // fail-режим отправляем без симуляции, чтобы отклонённая транзакция осталась в блокчейне
  const sig = await swap(amountIn, minOut, sellVaultToken, { skipPreflight: mode === "fail" });
  saveState({ [mode === "fail" ? "swapFailTx" : `swap_${side}_Tx`]: sig });
  console.log("swap:", explorer("tx", sig));
} catch (e: any) {
  const sig = e?.signature;
  console.log("отклонено:", e?.error?.errorCode?.code ?? e?.message?.split("\n")[0]);
  if (sig) {
    saveState({ swapFailTx: sig });
    console.log("транзакция:", explorer("tx", sig));
  }
}
await show("после");
process.exit();

// Позиция vault в CLMM-пуле Raydium (только админ).
//   node vault-position.mts open 5 100 80   — открыть позицию ±5% вокруг цены: 100 tUSD и не больше 80 VLT
//   node vault-position.mts collect         — забрать комиссии всех позиций vault
//   node vault-position.mts close           — закрыть все позиции vault (ликвидность и комиссии -> vault)
//   node vault-position.mts rebalance 5     — закрыть позиции и открыть новую ±5% вокруг текущей цены
//   node vault-position.mts trade sell 300  — обмен с нашего кошелька (как сторонний трейдер), двигает цену
//   node vault-position.mts info            — позиции vault и балансы хранилищ
// Ссылки на транзакции сохраняются в raydium.json.
import BN from "bn.js";
import Decimal from "decimal.js";
import { explorer, saveState } from "./common.mts";
import {
  addresses, balance, closePosition, collectFees, marketSwap, openPosition, quoteSwap, rangeToTicks, vaultPositions,
} from "./vault.mts";

const UNIT = 1_000_000;
const units = (n: string | number) => new BN(new Decimal(n).mul(UNIT).toFixed(0));
const a = addresses();
const [command, ...args] = process.argv.slice(2);

/** Цена VLT в tUSD (в пуле записана обратная: VLT за 1 tUSD). */
const vltPrice = async () => new Decimal(1).div((await quoteSwap(new BN(UNIT), true)).price).toNumber();

async function info() {
  const price = await vltPrice();
  console.log(`цена пула: ${price.toFixed(6)} tUSD за 1 VLT`);
  console.log(`хранилища vault: ${Number(await balance(a.vaultTokenAccount)) / UNIT} VLT + ${Number(await balance(a.secondTokenAccount)) / UNIT} tUSD`);
  for (const p of await vaultPositions()) {
    // тики пула -> цена VLT в tUSD: верхний тик = нижняя цена VLT
    const priceAt = (tick: number) => new Decimal(1).div(new Decimal(1.0001).pow(tick)).toFixed(6);
    console.log(`позиция ${p.nftMint.toBase58()}: ${priceAt(p.tickUpper)} … ${priceAt(p.tickLower)} tUSD/VLT, ликвидность ${p.liquidity.toString()}`);
  }
}

async function open(rangePercent: number, tusd: string, maxVlt: string) {
  const price = await vltPrice();
  const { tickLower, tickUpper } = await rangeToTicks(price * (1 - rangePercent / 100), price * (1 + rangePercent / 100));
  const { signature, nftMint } = await openPosition(tickLower, tickUpper, units(tusd), units(maxVlt));
  saveState({ vaultPositionNft: nftMint.toBase58(), vaultOpenTx: signature, vaultRange: `±${rangePercent}% от ${price.toFixed(6)}` });
  console.log(`open ±${rangePercent}% вокруг ${price.toFixed(6)}:`, explorer("tx", signature));
}

async function forEachPosition(action: (nft: any) => Promise<string>, key: string) {
  for (const p of await vaultPositions()) {
    const signature = await action(p.nftMint);
    saveState({ [key]: signature });
    console.log(`${key}:`, explorer("tx", signature));
  }
}

const balances = async () => [await balance(a.vaultTokenAccount), await balance(a.secondTokenAccount)];
async function withDelta(label: string, fn: () => Promise<void>) {
  const [vlt, tusd] = await balances();
  await fn();
  const [vlt2, tusd2] = await balances();
  console.log(`${label}: +${Number(vlt2 - vlt) / UNIT} VLT, +${Number(tusd2 - tusd) / UNIT} tUSD в хранилища vault`);
}

switch (command) {
  case "open": await open(Number(args[0] ?? 5), args[1] ?? "100", args[2] ?? "80"); break;
  case "collect": await withDelta("комиссии", () => forEachPosition((nft) => collectFees(nft), "vaultCollectTx")); break;
  case "close": await withDelta("возвращено", () => forEachPosition((nft) => closePosition(nft), "vaultCloseTx")); break;
  case "rebalance":
    await withDelta("закрыто", () => forEachPosition((nft) => closePosition(nft), "rebalanceCloseTx"));
    await open(Number(args[0] ?? 5), args[1] ?? "100", args[2] ?? "80");
    break;
  case "trade": {
    const sig = await marketSwap(units(args[1]), args[0] === "sell");
    console.log(`trade ${args[0]} ${args[1]}:`, explorer("tx", sig));
    break;
  }
  case "info": break;
  default:
    console.error("usage: node vault-position.mts <open|collect|close|rebalance|trade|info>");
    process.exit(1);
}
await info();
process.exit();

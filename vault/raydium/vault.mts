// Клиент vault для работы с Raydium: стратегия (второе хранилище + пул), swap через vault.
// Используется и в тестах (swap.test.mts), и в CLI (vault-swap.mts).
import anchor from "@coral-xyz/anchor";
import {
  getPdaExBitmapAccount,
  getPdaPersonalPositionAddress,
  getPdaProtocolPositionAddress,
  getPdaTickArrayAddress,
  PoolUtils,
  PersonalPositionLayout,
  TickUtil,
  TxVersion,
} from "@raydium-io/raydium-sdk-v2";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import Decimal from "decimal.js";
import { PublicKey, type Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import { connection, initSdk, loadState, owner, vaultState } from "./common.mts";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const idl = JSON.parse(readFileSync(new URL("../target/idl/simple_vault.json", import.meta.url), "utf8"));

export function vaultProgram(signer: Keypair = owner): any {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(signer), { commitment: "confirmed" });
  return new anchor.Program(idl, provider);
}

const program = vaultProgram();
const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];

/** Адреса vault и стратегии — всё вычисляется из mint токена vault. */
export function addresses() {
  const vault = vaultState();
  const pool = loadState();
  const vaultStateKey = new PublicKey(vault.vaultState);
  return {
    vaultState: vaultStateKey,
    vaultToken: new PublicKey(vault.tokenMint),
    vaultTokenAccount: new PublicKey(vault.vaultTokenAccount),
    secondMint: new PublicKey(pool.tusd),
    strategy: pda(Buffer.from("strategy"), vaultStateKey.toBuffer()),
    secondTokenAccount: pda(Buffer.from("vault_tokens_2"), vaultStateKey.toBuffer()),
    poolId: new PublicKey(pool.poolId),
    clmmProgram: new PublicKey(pool.clmmProgram),
  };
}

export const balance = async (account: PublicKey) => (await getAccount(connection, account)).amount;

export async function initStrategy(signer: Keypair = owner) {
  const a = addresses();
  return vaultProgram(signer)
    .methods.initStrategy()
    .accounts({
      vaultState: a.vaultState,
      strategy: a.strategy,
      secondMint: a.secondMint,
      secondTokenAccount: a.secondTokenAccount,
      poolState: a.poolId,
      admin: signer.publicKey,
    })
    .signers([signer])
    .rpc();
}

/**
 * Котировка обмена через пул: сколько получим и какие tick-массивы нужны.
 * sellVaultToken = true: отдаём токен vault (VLT), получаем второй (tUSD).
 */
export async function quoteSwap(amountIn: BN, sellVaultToken: boolean) {
  const a = addresses();
  const raydium = await initSdk(true);
  const { poolInfo, poolKeys, computePoolInfo, tickData } = await raydium.clmm.getPoolInfoFromRpc(a.poolId.toBase58());
  const outMint = sellVaultToken ? a.secondMint : a.vaultToken;
  const tokenOut = poolInfo.mintA.address === outMint.toBase58() ? poolInfo.mintA : poolInfo.mintB;
  const quote = PoolUtils.computeAmountOutFormat({
    poolInfo: computePoolInfo,
    tickarrayBitmapExtension: computePoolInfo.exBitmapInfo,
    tickArrayCache: tickData[a.poolId.toBase58()],
    amountIn,
    tokenOut,
    slippage: 0,
    epochInfo: await raydium.fetchEpochInfo(),
    blockTimestamp: Math.floor(Date.now() / 1000),
  });
  // vault-аккаунты пула: какой из них для входного токена, какой для выходного
  const vaultOf = (mint: PublicKey) =>
    new PublicKey(poolInfo.mintA.address === mint.toBase58() ? poolKeys.vault.A : poolKeys.vault.B);
  const inMint = sellVaultToken ? a.vaultToken : a.secondMint;
  return {
    expectedOut: quote.amountOut.amount.raw as BN,
    price: poolInfo.price,
    accounts: {
      ammConfig: new PublicKey(poolKeys.config.id),
      observationState: new PublicKey(poolKeys.observationId),
      inputPoolVault: vaultOf(inMint),
      outputPoolVault: vaultOf(outMint),
      inputMint: inMint,
      outputMint: outMint,
    },
    // swap_v2 Raydium: сначала bitmap-расширение пула, затем tick-массивы, по которым пройдёт обмен
    remainingAccounts: [getPdaExBitmapAccount(a.clmmProgram, a.poolId).publicKey, ...quote.remainingAccounts].map(
      (pubkey) => ({ pubkey, isSigner: false, isWritable: true }),
    ),
  };
}

/** Обмен через vault. Подписывает админ, токены отдаёт vault (PDA). */
export async function swap(
  amountIn: BN,
  minimumAmountOut: BN,
  sellVaultToken: boolean,
  opts: { signer?: Keypair; skipPreflight?: boolean } = {},
) {
  const a = addresses();
  const signer = opts.signer ?? owner;
  const q = await quoteSwap(amountIn, sellVaultToken);
  const builder = vaultProgram(signer)
    .methods.swap(amountIn, minimumAmountOut, sellVaultToken)
    .accounts({
      vaultState: a.vaultState,
      strategy: a.strategy,
      admin: signer.publicKey,
      clmmProgram: a.clmmProgram,
      ammConfig: q.accounts.ammConfig,
      poolState: a.poolId,
      vaultTokenAccount: a.vaultTokenAccount,
      secondTokenAccount: a.secondTokenAccount,
      inputPoolVault: q.accounts.inputPoolVault,
      outputPoolVault: q.accounts.outputPoolVault,
      observationState: q.accounts.observationState,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM,
      inputMint: q.accounts.inputMint,
      outputMint: q.accounts.outputMint,
    })
    .remainingAccounts(q.remainingAccounts)
    .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .signers([signer]);
  if (!opts.skipPreflight) return builder.rpc();
  return sendWithoutPreflight(await builder.transaction(), signer);
}

/**
 * Отправить транзакцию без симуляции: даже если она упадёт, она попадёт в блокчейн
 * (так получаем ссылку на отклонённый swap). Ошибку бросаем вместе с подписью.
 */
async function sendWithoutPreflight(tx: anchor.web3.Transaction, signer: Keypair) {
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(signer);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  // confirmTransaction может как вернуть ошибку в value.err, так и бросить её — ловим оба случая
  const err = await connection.confirmTransaction(signature, "confirmed").then((r) => r.value.err, (e) => e);
  if (!err) return signature;
  const meta = (await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))?.meta;
  const reason = meta?.logMessages?.find((l) => l.includes("Error Code:")) ?? JSON.stringify(err);
  throw Object.assign(new Error(reason), { signature });
}

// ── Неделя 13: позиция vault в CLMM-пуле ────────────────────────────────────

const TICK_ARRAY_SIZE = 60; // тиков в одном tick-массиве Raydium
/** Начало tick-массива, в который попадает тик: кратно tickSpacing × 60. */
const tickArrayStart = (tick: number, spacing: number) =>
  Math.floor(tick / (spacing * TICK_ARRAY_SIZE)) * spacing * TICK_ARRAY_SIZE;

/** Все аккаунты позиции Raydium вычисляются из пула, тиков и mint NFT. */
async function positionAccounts(nftMint: PublicKey, tickLower: number, tickUpper: number) {
  const a = addresses();
  const raydium = await initSdk(true);
  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(a.poolId.toBase58());
  const spacing = poolInfo.config.tickSpacing;
  const [lowerStart, upperStart] = [tickArrayStart(tickLower, spacing), tickArrayStart(tickUpper, spacing)];
  const [mint0, mint1] = [new PublicKey(poolInfo.mintA.address), new PublicKey(poolInfo.mintB.address)];
  // хранилища vault в порядке токенов пула
  const vaultAccountFor = (mint: PublicKey) => (mint.equals(a.vaultToken) ? a.vaultTokenAccount : a.secondTokenAccount);
  return {
    poolInfo,
    lowerStart,
    upperStart,
    accounts: {
      vaultState: a.vaultState,
      strategy: a.strategy,
      clmmProgram: a.clmmProgram,
      poolState: a.poolId,
      positionNftMint: nftMint,
      positionNftAccount: getAssociatedTokenAddressSync(nftMint, a.vaultState, true, TOKEN_2022_PROGRAM_ID),
      personalPosition: getPdaPersonalPositionAddress(a.clmmProgram, nftMint).publicKey,
      protocolPosition: getPdaProtocolPositionAddress(a.clmmProgram, a.poolId, tickLower, tickUpper).publicKey,
      tickArrayLower: getPdaTickArrayAddress(a.clmmProgram, a.poolId, lowerStart).publicKey,
      tickArrayUpper: getPdaTickArrayAddress(a.clmmProgram, a.poolId, upperStart).publicKey,
      tokenAccount0: vaultAccountFor(mint0),
      tokenAccount1: vaultAccountFor(mint1),
      tokenVault0: new PublicKey(poolKeys.vault.A),
      tokenVault1: new PublicKey(poolKeys.vault.B),
      vault0Mint: mint0,
      vault1Mint: mint1,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM,
    },
    bitmap: [{ pubkey: getPdaExBitmapAccount(a.clmmProgram, a.poolId).publicKey, isSigner: false, isWritable: true }],
  };
}

/** Цены диапазона (tUSD за 1 VLT, как удобнее человеку) -> тики пула. В пуле цена = VLT за tUSD. */
export async function rangeToTicks(lowVltPrice: number, highVltPrice: number) {
  const raydium = await initSdk(true);
  const { poolInfo } = await raydium.clmm.getPoolInfoFromRpc(addresses().poolId.toBase58());
  const toTick = (poolPrice: Decimal) =>
    TickUtil.toTickIndex(
      TickUtil.priceToTick(poolPrice, poolInfo.mintA.decimals, poolInfo.mintB.decimals),
      poolInfo.config.tickSpacing,
    );
  // чем дороже VLT, тем меньше VLT за tUSD: границы меняются местами
  return {
    tickLower: toTick(new Decimal(1).div(highVltPrice)),
    tickUpper: toTick(new Decimal(1).div(lowVltPrice)),
    poolInfo,
  };
}

/**
 * Открыть позицию vault: tUSD (token0) — базовая сумма, VLT (token1) — не больше maxVlt.
 * Возвращает подпись и mint NFT позиции.
 */
export async function openPosition(tickLower: number, tickUpper: number, tusdAmount: BN, maxVlt: BN, signer: Keypair = owner) {
  const nft = anchor.web3.Keypair.generate();
  const p = await positionAccounts(nft.publicKey, tickLower, tickUpper);
  const signature = await vaultProgram(signer)
    .methods.openPosition(tickLower, tickUpper, p.lowerStart, p.upperStart, tusdAmount, maxVlt)
    .accounts({ ...p.accounts, admin: signer.publicKey })
    .remainingAccounts(p.bitmap)
    .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
    .signers([signer, nft])
    .rpc();
  return { signature, nftMint: nft.publicKey };
}

/** Позиции, NFT которых принадлежит vault (Raydium находит их по владельцу NFT). */
export async function vaultPositions() {
  const a = addresses();
  const nftAccounts = await connection.getParsedTokenAccountsByOwner(a.vaultState, { programId: TOKEN_2022_PROGRAM_ID });
  const mints = nftAccounts.value
    .filter((t) => t.account.data.parsed.info.tokenAmount.amount === "1")
    .map((t) => new PublicKey(t.account.data.parsed.info.mint));
  const result = [];
  for (const mint of mints) {
    const address = getPdaPersonalPositionAddress(a.clmmProgram, mint).publicKey;
    const info = await connection.getAccountInfo(address);
    if (!info) continue;
    const position = PersonalPositionLayout.decode(info.data);
    if (position.poolId.equals(a.poolId)) result.push({ nftMint: mint, ...position });
  }
  return result;
}

async function manage(method: "collectFees" | "closePosition", nftMint: PublicKey, args: BN[], signer: Keypair) {
  const position = (await vaultPositions()).find((p) => p.nftMint.equals(nftMint));
  if (!position) throw new Error(`у vault нет позиции ${nftMint.toBase58()}`);
  const p = await positionAccounts(nftMint, position.tickLower, position.tickUpper);
  return vaultProgram(signer)
    .methods[method](...args)
    .accounts({ ...p.accounts, admin: signer.publicKey })
    .remainingAccounts(p.bitmap)
    .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
    .signers([signer])
    .rpc();
}

/** Забрать накопленные комиссии позиции в хранилища vault. */
export const collectFees = (nftMint: PublicKey, signer: Keypair = owner) => manage("collectFees", nftMint, [], signer);

/** Вывести всю ликвидность (не меньше минимумов) и закрыть позицию. */
export const closePosition = (nftMint: PublicKey, min0 = new BN(0), min1 = new BN(0), signer: Keypair = owner) =>
  manage("closePosition", nftMint, [min0, min1], signer);

/** Обычный пользовательский обмен в пуле с нашего кошелька (не через vault) — чтобы позиции заработали комиссии. */
export async function marketSwap(amountIn: BN, sellVaultToken: boolean) {
  const a = addresses();
  const raydium = await initSdk(true);
  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(a.poolId.toBase58());
  const q = await quoteSwap(amountIn, sellVaultToken);
  const { execute } = await raydium.clmm.swap({
    poolInfo,
    poolKeys,
    inputMint: (sellVaultToken ? a.vaultToken : a.secondMint).toBase58(),
    amountIn,
    amountOutMin: q.expectedOut.muln(98).divn(100),
    observationId: q.accounts.observationState,
    ownerInfo: { useSOLBalance: false },
    remainingAccounts: q.remainingAccounts.slice(1).map((r) => r.pubkey),
    txVersion: TxVersion.V0,
  });
  return (await execute({ sendAndConfirm: true })).txId;
}

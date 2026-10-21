// Клиент vault для работы с Raydium: стратегия (второе хранилище + пул), swap через vault.
// Используется и в тестах (swap.test.mts), и в CLI (vault-swap.mts).
import anchor from "@coral-xyz/anchor";
import { getPdaExBitmapAccount, PoolUtils } from "@raydium-io/raydium-sdk-v2";
import { getAccount, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
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

// Свой токен на Token-2022: метаданные (имя, тикер, картинка) хранятся прямо в mint-аккаунте
// через расширения MetadataPointer + TokenMetadata, без отдельной программы Metaplex.
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ExtensionType, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TYPE_SIZE,
  createAssociatedTokenAccountIdempotent, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, getAccount, getAssociatedTokenAddressSync, getMint,
  getMintLen, getTokenMetadata, mintTo, transferChecked,
} from '@solana/spl-token';
import { createInitializeInstruction, createUpdateFieldInstruction, pack, type TokenMetadata } from '@solana/spl-token-metadata';

export type TokenParams = { name: string; symbol: string; uri: string; decimals: number; extra?: [string, string][] };

export async function createToken(connection: Connection, payer: Keypair, p: TokenParams): Promise<PublicKey> {
  const mint = Keypair.generate();
  const metadata: TokenMetadata = {
    mint: mint.publicKey, updateAuthority: payer.publicKey,
    name: p.name, symbol: p.symbol, uri: p.uri, additionalMetadata: p.extra ?? [],
  };
  // аккаунт создаётся под размер mint + расширение-указатель; место под сами метаданные
  // программа добавит позже, но rent за него нужно заплатить сразу
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);
  const common = { programId: TOKEN_2022_PROGRAM_ID, metadata: mint.publicKey, updateAuthority: payer.publicKey };

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
      space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID,
    }),
    // метаданные будут лежать в самом mint
    createInitializeMetadataPointerInstruction(mint.publicKey, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, p.decimals, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      ...common, mint: mint.publicKey, mintAuthority: payer.publicKey,
      name: p.name, symbol: p.symbol, uri: p.uri,
    }),
    ...(p.extra ?? []).map(([field, value]) => createUpdateFieldInstruction({ ...common, field, value })),
  );
  await sendAndConfirmTransaction(connection, tx, [payer, mint]);
  return mint.publicKey;
}

/** Токен-аккаунт владельца (ATA); создаётся, если его ещё нет. */
const ataFor = (connection: Connection, payer: Keypair, mint: PublicKey, owner: PublicKey) =>
  createAssociatedTokenAccountIdempotent(connection, payer, mint, owner, { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID);

export async function mintTokens(connection: Connection, payer: Keypair, mint: PublicKey, to: PublicKey, amount: bigint): Promise<string> {
  const account = await ataFor(connection, payer, mint, to);
  return mintTo(connection, payer, mint, account, payer, amount, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID);
}

export async function transferTokens(connection: Connection, payer: Keypair, mint: PublicKey, to: PublicKey, amount: bigint): Promise<string> {
  const { decimals } = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const from = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const destination = await ataFor(connection, payer, mint, to);
  return transferChecked(connection, payer, from, mint, destination, payer, amount, decimals, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID);
}

export async function balanceOf(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  const address = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  try {
    return (await getAccount(connection, address, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
  } catch {
    return 0n; // токен-аккаунта ещё нет
  }
}

export async function tokenInfo(connection: Connection, mint: PublicKey) {
  const [account, metadata] = await Promise.all([
    getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID),
    getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID),
  ]);
  return {
    name: metadata?.name, symbol: metadata?.symbol, uri: metadata?.uri,
    extra: metadata?.additionalMetadata ?? [],
    decimals: account.decimals, supply: account.supply,
    mintAuthority: account.mintAuthority?.toBase58() ?? null,
  };
}

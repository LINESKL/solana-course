// Клиент для программы greeter: создаёт (при первом запуске) аккаунт-счётчик
// и вызывает программу. Запуск: node greet.ts
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, clusterApiUrl,
} from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const PROGRAM_ID = new PublicKey('D3AeEuipHLfzvM79BH6Z1B96zD7xnzBSnyPo8wAhaBKB');
const SEED = 'greeter';
const SPACE = 4; // u32 счётчик

const keypairPath = process.env.KEYPAIR ?? `${homedir()}/.config/solx/id.json`;
const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))));
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');

// Адрес счётчика выводится из адреса пользователя + seed, поэтому у каждого пользователя свой
const greeting = await PublicKey.createWithSeed(user.publicKey, SEED, PROGRAM_ID);
const tx = new Transaction();

if (!(await connection.getAccountInfo(greeting))) {
  console.log('Creating greeting account', greeting.toBase58());
  tx.add(SystemProgram.createAccountWithSeed({
    fromPubkey: user.publicKey,
    basePubkey: user.publicKey,
    seed: SEED,
    newAccountPubkey: greeting,
    lamports: await connection.getMinimumBalanceForRentExemption(SPACE),
    space: SPACE,
    programId: PROGRAM_ID,
  }));
}

tx.add(new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: user.publicKey, isSigner: true, isWritable: false },
    { pubkey: greeting, isSigner: false, isWritable: true },
  ],
  data: Buffer.alloc(0),
}));

const signature = await sendAndConfirmTransaction(connection, tx, [user]);
const sent = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
const data = (await connection.getAccountInfo(greeting))!.data;

console.log('Program   ', PROGRAM_ID.toBase58());
console.log('Signature ', signature);
console.log('Log       ', sent?.meta?.logMessages?.find(l => l.includes('Hello')));
console.log('Counter   ', data.readUInt32LE(0));
console.log('Explorer  ', `https://explorer.solana.com/tx/${signature}?cluster=devnet`);

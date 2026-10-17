// Клиент счётчика на devnet: node client/counter.ts <init|inc|dec|reset|show>
import * as anchor from '@anchor-lang/core';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const idl = JSON.parse(readFileSync(new URL('../target/idl/counter.json', import.meta.url), 'utf8'));
const secret = JSON.parse(readFileSync(process.env.KEYPAIR ?? `${homedir()}/.config/solx/id.json`, 'utf8'));
const wallet = new anchor.Wallet(anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secret)));
const connection = new anchor.web3.Connection(process.env.RPC_URL ?? 'https://api.devnet.solana.com', 'confirmed');
const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' }));

const [counter] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from('counter'), wallet.publicKey.toBuffer()],
  program.programId,
);
const show = async () => {
  const state: any = await (program.account as any).counter.fetch(counter);
  console.log(`Counter ${counter.toBase58()} = ${state.count.toString()} (owner ${state.authority.toBase58()})`);
};

const action = process.argv[2] ?? 'show';
const methods: Record<string, () => any> = {
  init: () => program.methods.initialize(),
  inc: () => program.methods.increment().accounts({ counter }),
  dec: () => program.methods.decrement().accounts({ counter }),
  reset: () => program.methods.reset().accounts({ counter }),
};
if (action !== 'show') {
  if (!methods[action]) throw new Error('usage: node client/counter.ts <init|inc|dec|reset|show>');
  const sig = await methods[action]().rpc();
  console.log(`${action}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}
await show();

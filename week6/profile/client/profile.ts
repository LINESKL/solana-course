// Клиент профиля на devnet:
//   node client/profile.ts create <username> <bio>
//   node client/profile.ts bio <new bio>
//   node client/profile.ts show [username]
//   node client/profile.ts delete
import * as anchor from '@anchor-lang/core';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const idl = JSON.parse(readFileSync(new URL('../target/idl/profile.json', import.meta.url), 'utf8'));
const secret = JSON.parse(readFileSync(process.env.KEYPAIR ?? `${homedir()}/.config/solx/id.json`, 'utf8'));
const wallet = new anchor.Wallet(anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secret)));
const connection = new anchor.web3.Connection(process.env.RPC_URL ?? 'https://api.devnet.solana.com', 'confirmed');
const program: any = new anchor.Program(idl, new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' }));

const pda = (...seeds: Buffer[]) => anchor.web3.PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const profileOf = (owner: anchor.web3.PublicKey) => pda(Buffer.from('profile'), owner.toBuffer());
const usernameRecord = (name: string) => pda(Buffer.from('username'), Buffer.from(name));

async function show(username?: string) {
  // по имени: UsernameRecord -> владелец -> профиль; без имени — свой профиль
  const owner = username ? (await program.account.usernameRecord.fetch(usernameRecord(username))).owner : wallet.publicKey;
  const address = profileOf(owner);
  const p = await program.account.profile.fetch(address);
  console.log(`@${p.username}  (${address.toBase58()})`);
  console.log(`  owner   ${p.authority.toBase58()}`);
  console.log(`  bio     ${p.bio}`);
  console.log(`  created ${new Date(p.createdAt.toNumber() * 1000).toISOString()}`);
  console.log(`  updated ${new Date(p.updatedAt.toNumber() * 1000).toISOString()}`);
}

const [action = 'show', ...args] = process.argv.slice(2);
const link = (sig: string) => console.log(`${action}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
switch (action) {
  case 'create': link(await program.methods.createProfile(args[0], args.slice(1).join(' ')).rpc()); await show(); break;
  case 'bio': link(await program.methods.updateBio(args.join(' ')).rpc()); await show(); break;
  case 'delete': link(await program.methods.deleteProfile().rpc()); break;
  case 'show': await show(args[0]); break;
  default: throw new Error('usage: create <username> <bio> | bio <text> | show [username] | delete');
}

// CLI для своего токена на devnet.
//   node cli.ts create               — выпустить токен (адрес mint сохраняется в mint.json)
//   node cli.ts mint <amount>        — начислить себе
//   node cli.ts transfer <to> <amount>
//   node cli.ts info [owner]         — метаданные, supply и баланс
import { Connection, Keypair, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { balanceOf, createToken, mintTokens, tokenInfo, transferTokens } from './token.ts';

const DECIMALS = 6;
const MINT_FILE = 'mint.json';
const connection = new Connection(process.env.RPC_URL ?? clusterApiUrl('devnet'), 'confirmed');
const keypairPath = process.env.KEYPAIR ?? `${homedir()}/.config/solx/id.json`;
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))));
const explorer = (kind: string, id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

/** "1000.5" -> 1000500000n при 6 знаках; строкой, без float. */
function toBaseUnits(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount);
  if (!match) throw new Error(`invalid amount "${amount}" (up to ${DECIMALS} decimals)`);
  return BigInt(match[1]) * 10n ** BigInt(DECIMALS) + BigInt((match[2] ?? '').padEnd(DECIMALS, '0'));
}
const fromBaseUnits = (units: bigint) =>
  `${units / 10n ** BigInt(DECIMALS)}.${(units % 10n ** BigInt(DECIMALS)).toString().padStart(DECIMALS, '0')}`.replace(/\.?0+$/, '');

function savedMint(): PublicKey {
  if (!existsSync(MINT_FILE)) throw new Error('no token yet: run `node cli.ts create` first');
  return new PublicKey(JSON.parse(readFileSync(MINT_FILE, 'utf8')).mint);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'create': {
    const mint = await createToken(connection, payer, {
      name: 'Nurkanat Token',
      symbol: 'NURK',
      uri: 'https://raw.githubusercontent.com/solana-developers/opos-asset/main/assets/DeveloperPortal/metadata.json',
      decimals: DECIMALS,
      extra: [['course', 'Solana, week 7']],
    });
    writeFileSync(MINT_FILE, JSON.stringify({ mint: mint.toBase58() }, null, 2));
    console.log('Token created:', mint.toBase58());
    console.log(explorer('address', mint.toBase58()));
    break;
  }
  case 'mint': {
    const sig = await mintTokens(connection, payer, savedMint(), payer.publicKey, toBaseUnits(args[0]));
    console.log(`Minted ${args[0]} to ${payer.publicKey.toBase58()}`);
    console.log(explorer('tx', sig));
    break;
  }
  case 'transfer': {
    const sig = await transferTokens(connection, payer, savedMint(), new PublicKey(args[0]), toBaseUnits(args[1]));
    console.log(`Sent ${args[1]} to ${args[0]}`);
    console.log(explorer('tx', sig));
    break;
  }
  case 'info': {
    const mint = savedMint();
    const owner = new PublicKey(args[0] ?? payer.publicKey);
    const info = await tokenInfo(connection, mint);
    console.log('Mint          ', mint.toBase58());
    console.log('Name / Symbol ', `${info.name} / ${info.symbol}`);
    console.log('URI           ', info.uri);
    console.log('Extra         ', info.extra.map(([k, v]: string[]) => `${k}=${v}`).join(', '));
    console.log('Decimals      ', info.decimals);
    console.log('Supply        ', fromBaseUnits(info.supply));
    console.log('Mint authority', info.mintAuthority);
    console.log(`Balance of ${owner.toBase58().slice(0, 4)}…`, fromBaseUnits(await balanceOf(connection, mint, owner)));
    break;
  }
  default:
    console.log('usage: node cli.ts create | mint <amount> | transfer <to> <amount> | info [owner]');
    process.exit(command ? 1 : 0);
}

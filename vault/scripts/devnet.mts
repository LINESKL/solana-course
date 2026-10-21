// Работа с vault в devnet из терминала.
//   node scripts/devnet.mts init   — создать тестовый токен и vault для него
//   node scripts/devnet.mts card   — создать свою карточку пользователя
//   node scripts/devnet.mts mint 1000     — начислить себе тестовые токены vault (мы — mint authority)
//   node scripts/devnet.mts deposit 100   — внести токены и получить share-токены
//   node scripts/devnet.mts show   — показать состояние vault и ссылки на Explorer
// Адреса созданных аккаунтов сохраняются в devnet.json.
import anchor from "@coral-xyz/anchor";
import { createMint, getAccount, getAssociatedTokenAddressSync, getMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const { web3, BN } = anchor;
const UNIT = 1_000_000; // 6 знаков после запятой

/** "100.5" -> 100500000 без float */
function toUnits(amount: string | undefined): InstanceType<typeof BN> {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount ?? "");
  if (!match) throw new Error(`укажите сумму, например 100 или 0.5 (получено "${amount}")`);
  return new BN(match[1]).mul(new BN(UNIT)).add(new BN((match[2] ?? "").padEnd(6, "0")));
}
const fromUnits = (units: bigint | number) => (Number(units) / UNIT).toString();
const { PublicKey, Keypair, Connection } = web3;

const STATE_FILE = new URL("../devnet.json", import.meta.url);
const idl = JSON.parse(readFileSync(new URL("../target/idl/simple_vault.json", import.meta.url), "utf8"));
const secret = JSON.parse(readFileSync(process.env.KEYPAIR ?? `${homedir()}/.config/solana/id.json`, "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
const program: any = new anchor.Program(idl, provider);

const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const explorer = (kind: "address" | "tx", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

type State = Record<string, string>;
const load = (): State => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {});
const save = (state: State) => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

/** Все адреса vault вычисляются из mint токена — их не нужно хранить где-то ещё. */
function vaultAccounts(tokenMint: InstanceType<typeof PublicKey>) {
  const vaultState = pda(Buffer.from("vault"), tokenMint.toBuffer());
  return {
    vaultState,
    vaultTokenAccount: pda(Buffer.from("vault_tokens"), tokenMint.toBuffer()),
    shareMint: pda(Buffer.from("share_mint"), tokenMint.toBuffer()),
    userCard: (user: InstanceType<typeof PublicKey>) =>
      pda(Buffer.from("user_card"), vaultState.toBuffer(), user.toBuffer()),
  };
}

function requireVault(state: State) {
  if (!state.tokenMint) throw new Error("vault ещё не создан: node scripts/devnet.mts init");
  return vaultAccounts(new PublicKey(state.tokenMint));
}

async function init() {
  const state = load();
  if (state.vaultState) throw new Error(`vault уже создан: ${state.vaultState}`);
  // тестовый токен, который принимает vault (6 знаков, как у USDC)
  const tokenMint = await createMint(connection, payer, payer.publicKey, null, 6);
  const accounts = vaultAccounts(tokenMint);
  const sig = await program.methods
    .initializeVault()
    .accounts({
      vaultState: accounts.vaultState,
      vaultTokenAccount: accounts.vaultTokenAccount,
      shareMint: accounts.shareMint,
      tokenMint,
      admin: payer.publicKey,
    })
    .rpc();
  save({
    programId: program.programId.toBase58(),
    tokenMint: tokenMint.toBase58(),
    vaultState: accounts.vaultState.toBase58(),
    vaultTokenAccount: accounts.vaultTokenAccount.toBase58(),
    shareMint: accounts.shareMint.toBase58(),
    initializeTx: sig,
  });
  console.log("initialize_vault:", explorer("tx", sig));
  await show();
}

async function card() {
  const state = load();
  const accounts = requireVault(state);
  const userCard = accounts.userCard(payer.publicKey);
  const sig = await program.methods
    .createUserCard()
    .accounts({ vaultState: accounts.vaultState, userCard, user: payer.publicKey })
    .rpc();
  save({ ...state, userCard: userCard.toBase58(), createUserCardTx: sig });
  console.log("create_user_card:", explorer("tx", sig));
  await show();
}

async function mint() {
  const state = load();
  requireVault(state);
  const tokenMint = new PublicKey(state.tokenMint);
  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, tokenMint, payer.publicKey);
  const sig = await mintTo(connection, payer, tokenMint, ata.address, payer, BigInt(toUnits(process.argv[3]).toString()));
  console.log(`mint ${process.argv[3]}:`, explorer("tx", sig));
  await show();
}

async function deposit() {
  const state = load();
  const accounts = requireVault(state);
  const tokenMint = new PublicKey(state.tokenMint);
  const sig = await program.methods
    .deposit(toUnits(process.argv[3]))
    .accounts({
      vaultState: accounts.vaultState,
      userCard: accounts.userCard(payer.publicKey),
      tokenMint,
      vaultTokenAccount: accounts.vaultTokenAccount,
      shareMint: accounts.shareMint,
      userTokenAccount: getAssociatedTokenAddressSync(tokenMint, payer.publicKey),
      user: payer.publicKey,
    })
    .rpc();
  save({ ...state, depositTx: sig });
  console.log(`deposit ${process.argv[3]}:`, explorer("tx", sig));
  await show();
}

async function show() {
  const state = load();
  const accounts = requireVault(state);
  const vault = await program.account.vaultState.fetch(accounts.vaultState);
  console.log("Program            ", explorer("address", program.programId.toBase58()));
  console.log("VaultState (PDA)   ", explorer("address", accounts.vaultState.toBase58()));
  console.log("  admin            ", vault.admin.toBase58());
  console.log("  paused           ", vault.paused);
  console.log("Token mint         ", explorer("address", state.tokenMint));
  console.log("Хранилище (PDA)    ", explorer("address", accounts.vaultTokenAccount.toBase58()));
  console.log("Share mint (PDA)   ", explorer("address", accounts.shareMint.toBase58()));
  const vaultBalance = (await getAccount(connection, accounts.vaultTokenAccount)).amount;
  const shareSupply = (await getMint(connection, accounts.shareMint)).supply;
  console.log("  в vault токенов  ", fromUnits(vaultBalance), " | выпущено shares", fromUnits(shareSupply));
  console.log("  total_deposited  ", fromUnits(vault.totalDeposited.toNumber()));
  const userCard = accounts.userCard(payer.publicKey);
  const cardData = await program.account.userCard.fetchNullable(userCard);
  if (cardData) {
    console.log("Карточка (PDA)     ", explorer("address", userCard.toBase58()));
    console.log("  owner            ", cardData.owner.toBase58());
    console.log("  created_at       ", new Date(cardData.createdAt.toNumber() * 1000).toISOString());
    console.log("  deposited        ", fromUnits(cardData.deposited.toNumber()));
    const myShares = await getAccount(connection, getAssociatedTokenAddressSync(accounts.shareMint, payer.publicKey)).catch(() => null);
    console.log("  мои shares       ", myShares ? fromUnits(myShares.amount) : "0");
  } else {
    console.log("Карточки пока нет: node scripts/devnet.mts card");
  }
}

const commands: Record<string, () => Promise<void>> = { init, card, mint, deposit, show };
const command = commands[process.argv[2] ?? "show"];
if (!command) {
  console.error("usage: node scripts/devnet.mts <init|card|mint N|deposit N|show>");
  process.exit(1);
}
await command();

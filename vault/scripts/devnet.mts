// Работа с vault в devnet из терминала.
//   node scripts/devnet.mts init   — создать тестовый токен и vault для него
//   node scripts/devnet.mts card   — создать свою карточку пользователя
//   node scripts/devnet.mts show   — показать состояние vault и ссылки на Explorer
// Адреса созданных аккаунтов сохраняются в devnet.json.
import anchor from "@coral-xyz/anchor";
import { createMint } from "@solana/spl-token";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const { web3 } = anchor;
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
  const userCard = accounts.userCard(payer.publicKey);
  const cardData = await program.account.userCard.fetchNullable(userCard);
  if (cardData) {
    console.log("Карточка (PDA)     ", explorer("address", userCard.toBase58()));
    console.log("  owner            ", cardData.owner.toBase58());
    console.log("  created_at       ", new Date(cardData.createdAt.toNumber() * 1000).toISOString());
  } else {
    console.log("Карточки пока нет: node scripts/devnet.mts card");
  }
}

const commands: Record<string, () => Promise<void>> = { init, card, show };
const command = commands[process.argv[2] ?? "show"];
if (!command) {
  console.error("usage: node scripts/devnet.mts <init|card|show>");
  process.exit(1);
}
await command();

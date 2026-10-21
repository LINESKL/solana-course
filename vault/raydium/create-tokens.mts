// Шаг 1. Второй тестовый токен пула (tUSD) + пополнение обоих токенов на наш кошелёк.
// Первый токен пула — токен vault из недели 9 (мы его mint authority).
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { connection, explorer, loadState, owner, saveState, vaultState } from "./common.mts";

const UNIT = 1_000_000n;
const vaultToken = new PublicKey(vaultState().tokenMint);
const tusd = loadState().tusd ? new PublicKey(loadState().tusd) : await createMint(connection, owner, owner.publicKey, null, 6);

for (const [name, mint, amount] of [["VLT (токен vault)", vaultToken, 100_000n], ["tUSD", tusd, 200_000n]] as const) {
  const ata = await getOrCreateAssociatedTokenAccount(connection, owner, mint, owner.publicKey);
  await mintTo(connection, owner, mint, ata.address, owner, amount * UNIT);
  console.log(`${name}: ${mint.toBase58()} — начислено ${amount}`);
  console.log(`  ${explorer("address", mint.toBase58())}`);
}
saveState({ vaultToken: vaultToken.toBase58(), tusd: tusd.toBase58() });

/**
 * Тесты для Simple Vault на devnet
 *
 * Сценарий:
 *   1. Admin создаёт vault (initialize_vault)
 *   2. Пользователи A и B создают свои карточки (create_user_card)
 *   3. Повторное создание карточки A падает
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createMint } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { SimpleVault } from "../target/types/simple_vault";

// Переводим SOL от admin → pubkey (обходит rate limit devnet airdrop)
async function fundFromAdmin(
  provider: anchor.AnchorProvider,
  admin: Keypair,
  pubkey: PublicKey,
  lamports = 0.05 * LAMPORTS_PER_SOL
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: pubkey, lamports })
  );
  await provider.sendAndConfirm(tx, [admin]);
}

// Ожидаем, что транзакция упадёт с конкретной ошибкой.
// Важно: assert.fail вне try, иначе catch поймает и его.
async function expectError(promise: Promise<unknown>, code: string) {
  let error: any;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  assert.exists(error, `ожидалась ошибка ${code}, но транзакция прошла`);
  assert.include(error.error?.errorCode?.code ?? String(error), code);
}

describe("simple_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const userA = Keypair.generate();
  const userB = Keypair.generate();

  let tokenMint: PublicKey;
  let vaultStatePDA: PublicKey;
  let vaultTokenAccountPDA: PublicKey;
  let shareMintPDA: PublicKey;

  const cardPda = (user: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), vaultStatePDA.toBuffer(), user.toBuffer()],
      program.programId
    )[0];

  before(async () => {
    await fundFromAdmin(provider, admin, userA.publicKey);
    await fundFromAdmin(provider, admin, userB.publicKey);

    tokenMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    [vaultStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );
    [vaultTokenAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), tokenMint.toBuffer()],
      program.programId
    );
    [shareMintPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), tokenMint.toBuffer()],
      program.programId
    );
  });

  it("initialize_vault: vault создан", async () => {
    await program.methods
      .initializeVault()
      .accounts({
        vaultState: vaultStatePDA,
        vaultTokenAccount: vaultTokenAccountPDA,
        shareMint: shareMintPDA,
        tokenMint,
        admin: admin.publicKey,
      } as any)
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(vault.tokenMint.toBase58(), tokenMint.toBase58());
    assert.equal(vault.shareMint.toBase58(), shareMintPDA.toBase58());
  });

  it("create_user_card: у каждого пользователя своя карточка", async () => {
    for (const user of [userA, userB]) {
      const userCard = cardPda(user.publicKey);
      await program.methods
        .createUserCard()
        .accounts({ vaultState: vaultStatePDA, userCard, user: user.publicKey } as any)
        .signers([user])
        .rpc();

      const card = await program.account.userCard.fetch(userCard);
      assert.equal(card.owner.toBase58(), user.publicKey.toBase58());
      assert.equal(card.vault.toBase58(), vaultStatePDA.toBase58());
    }
    assert.notEqual(cardPda(userA.publicKey).toBase58(), cardPda(userB.publicKey).toBase58());
  });

  it("create_user_card: вторая карточка для того же пользователя — ошибка", async () => {
    let failed = false;
    try {
      await program.methods
        .createUserCard()
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userA.publicKey),
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "повторная карточка должна быть отклонена");
  });

  // ── Неделя 8: задания для практики ──────────────────────────────────────

  const createCard = (user: Keypair) =>
    program.methods
      .createUserCard()
      .accounts({ vaultState: vaultStatePDA, userCard: cardPda(user.publicKey), user: user.publicKey } as any)
      .signers([user])
      .rpc();

  const closeCard = (user: Keypair, card = cardPda(user.publicKey)) =>
    program.methods
      .closeUserCard()
      .accounts({ vaultState: vaultStatePDA, userCard: card, user: user.publicKey } as any)
      .signers([user])
      .rpc();

  const setPaused = (paused: boolean, signer: Keypair = admin) =>
    program.methods
      .setPaused(paused)
      .accounts({ vaultState: vaultStatePDA, admin: signer.publicKey } as any)
      .signers(signer === admin ? [] : [signer])
      .rpc();

  it("карточка хранит время создания (created_at)", async () => {
    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));
    const now = Math.floor(Date.now() / 1000);
    assert.isAbove(card.createdAt.toNumber(), 0);
    assert.isAtMost(Math.abs(card.createdAt.toNumber() - now), 600);
  });

  it("новый vault не на паузе", async () => {
    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.isFalse(vault.paused);
  });

  it("set_paused: только админ может ставить vault на паузу", async () => {
    await expectError(setPaused(true, userA), "ConstraintHasOne");
    assert.isFalse((await program.account.vaultState.fetch(vaultStatePDA)).paused);
  });

  it("на паузе новые карточки не создаются, после снятия паузы — создаются", async () => {
    const userC = Keypair.generate();
    await fundFromAdmin(provider, admin, userC.publicKey);

    await setPaused(true);
    assert.isTrue((await program.account.vaultState.fetch(vaultStatePDA)).paused);
    await expectError(createCard(userC), "VaultPaused");

    await setPaused(false);
    await createCard(userC);
    const card = await program.account.userCard.fetch(cardPda(userC.publicKey));
    assert.equal(card.owner.toBase58(), userC.publicKey.toBase58());
  });

  it("close_user_card: чужую карточку закрыть нельзя", async () => {
    await expectError(closeCard(userB, cardPda(userA.publicKey)), "ConstraintSeeds");
  });

  it("close_user_card: карточка закрывается, рента возвращается владельцу", async () => {
    const card = cardPda(userB.publicKey);
    const rent = (await provider.connection.getAccountInfo(card))!.lamports;
    const before = await provider.connection.getBalance(userB.publicKey);

    await closeCard(userB);

    assert.isNull(await provider.connection.getAccountInfo(card));
    const after = await provider.connection.getBalance(userB.publicKey);
    // комиссию платит кошелёк провайдера (fee payer), поэтому пользователю возвращается вся рента
    assert.equal(after - before, rent);
  });

  it("после закрытия карточку можно создать заново", async () => {
    await createCard(userB);
    const card = await program.account.userCard.fetch(cardPda(userB.publicKey));
    assert.equal(card.owner.toBase58(), userB.publicKey.toBase58());
  });
});

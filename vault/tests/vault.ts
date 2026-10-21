/**
 * Тесты для Simple Vault на devnet
 *
 * Сценарий:
 *   1. Admin создаёт vault (initialize_vault)
 *   2. Пользователи A и B создают свои карточки (create_user_card)
 *   3. Повторное создание карточки A падает
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from "@solana/spl-token";
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

  // ── Неделя 9: депозит и share-токены ─────────────────────────────────────

  const UNIT = 1_000_000; // 6 знаков после запятой
  const tokens = (n: number) => new BN(n * UNIT);

  // токен-аккаунт пользователя с тестовыми токенами vault
  const fundTokens = async (user: PublicKey, amount: number) => {
    const ata = await getOrCreateAssociatedTokenAccount(provider.connection, admin, tokenMint, user);
    await mintTo(provider.connection, admin, tokenMint, ata.address, admin, amount * UNIT);
    return ata.address;
  };

  const deposit = (user: Keypair, amount: BN, userTokenAccount = getAssociatedTokenAddressSync(tokenMint, user.publicKey)) =>
    program.methods
      .deposit(amount)
      .accounts({
        vaultState: vaultStatePDA,
        userCard: cardPda(user.publicKey),
        tokenMint,
        vaultTokenAccount: vaultTokenAccountPDA,
        shareMint: shareMintPDA,
        userTokenAccount,
        user: user.publicKey,
      } as any)
      .signers([user])
      .rpc();

  const shareBalance = async (user: PublicKey) =>
    Number((await getAccount(provider.connection, getAssociatedTokenAddressSync(shareMintPDA, user))).amount) / UNIT;
  const vaultBalance = async () => Number((await getAccount(provider.connection, vaultTokenAccountPDA)).amount) / UNIT;

  it("первый вкладчик получает share-токены 1:1", async () => {
    await fundTokens(userA.publicKey, 5_000);
    await deposit(userA, tokens(1_000));

    assert.equal(await shareBalance(userA.publicKey), 1_000);
    assert.equal(await vaultBalance(), 1_000);
    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));
    assert.equal(card.deposited.toNumber(), 1_000 * UNIT);
    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.totalDeposited.toNumber(), 1_000 * UNIT);
  });

  it("после дохода vault поздний вкладчик получает долю по курсу (пример из методички)", async () => {
    // vault «заработал» 100 токенов: кладём их в хранилище напрямую, share-токены при этом не выпускаются
    const adminAta = await fundTokens(admin.publicKey, 100);
    await transfer(provider.connection, admin, adminAta, vaultTokenAccountPDA, admin, 100 * UNIT);
    assert.equal(await vaultBalance(), 1_100);

    await fundTokens(userB.publicKey, 1_000);
    await deposit(userB, tokens(110));

    // 110 / 1100 × 1000 = 100 share-токенов — меньше, чем внёс
    assert.equal(await shareBalance(userB.publicKey), 100);
    assert.equal(await vaultBalance(), 1_210);
    const supply = Number((await getMint(provider.connection, shareMintPDA)).supply) / UNIT;
    assert.equal(supply, 1_100);
  });

  it("повторный депозит добавляется к карточке", async () => {
    await deposit(userA, tokens(11));
    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));
    assert.equal(card.deposited.toNumber(), 1_011 * UNIT);
    // 11 / 1210 × 1100 = 10 share-токенов
    assert.equal(await shareBalance(userA.publicKey), 1_010);
  });

  it("депозит нуля запрещён", async () => {
    await expectError(deposit(userA, new BN(0)), "ZeroAmount");
  });

  it("слишком маленький депозит, за который положено 0 share-токенов, запрещён", async () => {
    // 1 минимальная единица × 1100 / 1210 = 0 после округления вниз
    await expectError(deposit(userA, new BN(1)), "ZeroShares");
  });

  it("без карточки депозит невозможен", async () => {
    const stranger = Keypair.generate();
    await fundFromAdmin(provider, admin, stranger.publicKey);
    await fundTokens(stranger.publicKey, 10);
    await expectError(deposit(stranger, tokens(1)), "AccountNotInitialized");
  });

  it("нельзя внести токены с чужого токен-аккаунта", async () => {
    const othersAccount = getAssociatedTokenAddressSync(tokenMint, userA.publicKey);
    await expectError(deposit(userB, tokens(1), othersAccount), "ConstraintTokenOwner");
  });

  it("на паузе депозит запрещён", async () => {
    await setPaused(true);
    await expectError(deposit(userA, tokens(1)), "VaultPaused");
    await setPaused(false);
  });

  // ── Неделя 10: вывод через CPI ──────────────────────────────────────────

  const withdraw = (user: Keypair, shares: BN, userTokenAccount = getAssociatedTokenAddressSync(tokenMint, user.publicKey)) =>
    program.methods
      .withdraw(shares)
      .accounts({
        vaultState: vaultStatePDA,
        userCard: cardPda(user.publicKey),
        tokenMint,
        vaultTokenAccount: vaultTokenAccountPDA,
        shareMint: shareMintPDA,
        userTokenAccount,
        userShareAccount: getAssociatedTokenAddressSync(shareMintPDA, user.publicKey),
        user: user.publicKey,
      } as any)
      .signers([user])
      .rpc();

  const tokenBalance = async (user: PublicKey) =>
    Number((await getAccount(provider.connection, getAssociatedTokenAddressSync(tokenMint, user))).amount) / UNIT;
  const shareSupply = async () => Number((await getMint(provider.connection, shareMintPDA)).supply) / UNIT;

  it("вывод: share-токены сжигаются, токены возвращаются по курсу", async () => {
    // сейчас: в vault 1221 токен, выпущено 1110 shares, у userB 100 shares (внёс 110)
    const vaultBefore = await vaultBalance();
    const supplyBefore = await shareSupply();
    const walletBefore = await tokenBalance(userB.publicKey);

    await withdraw(userB, tokens(100));

    // 100 / 1110 × 1221 = 110 токенов: userB получил свои 110 обратно
    const expected = Math.floor((100 * UNIT * vaultBefore * UNIT) / (supplyBefore * UNIT)) / UNIT;
    assert.equal(expected, 110);
    assert.equal(await tokenBalance(userB.publicKey), walletBefore + expected);
    assert.equal(await shareBalance(userB.publicKey), 0);
    assert.equal(await shareSupply(), supplyBefore - 100);
    assert.equal(await vaultBalance(), vaultBefore - expected);

    const card = await program.account.userCard.fetch(cardPda(userB.publicKey));
    assert.equal(card.deposited.toNumber(), 0);
  });

  it("частичный вывод уменьшает внесённую сумму пропорционально", async () => {
    // у userA 1010 shares и внесено 1011 токенов; выводим половину shares
    const cardBefore = await program.account.userCard.fetch(cardPda(userA.publicKey));
    const vaultBefore = await program.account.vaultState.fetch(vaultStatePDA);

    await withdraw(userA, tokens(505));

    assert.equal(await shareBalance(userA.publicKey), 505);
    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));
    const principalOut = Math.floor((cardBefore.deposited.toNumber() * 505) / 1010);
    assert.equal(card.deposited.toNumber(), cardBefore.deposited.toNumber() - principalOut);
    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.totalDeposited.toNumber(), vaultBefore.totalDeposited.toNumber() - principalOut);
  });

  it("вывод нуля запрещён", async () => {
    await expectError(withdraw(userA, new BN(0)), "ZeroAmount");
  });

  it("нельзя вывести больше share-токенов, чем есть", async () => {
    await expectError(withdraw(userA, tokens(506)), "InsufficientShares");
  });

  it("нельзя вывести на чужой токен-аккаунт", async () => {
    const othersAccount = getAssociatedTokenAddressSync(tokenMint, userB.publicKey);
    await expectError(withdraw(userA, tokens(1), othersAccount), "ConstraintTokenOwner");
  });

  it("на паузе вывод разрешён: выйти из vault можно всегда", async () => {
    await setPaused(true);
    await withdraw(userA, tokens(5));
    await setPaused(false);
    assert.equal(await shareBalance(userA.publicKey), 500);
  });

  it("карточку с внесёнными средствами закрыть нельзя", async () => {
    await expectError(closeCard(userA), "CardNotEmpty");
  });

  it("после полного вывода карточку можно закрыть", async () => {
    await withdraw(userA, tokens(500));
    assert.equal((await program.account.userCard.fetch(cardPda(userA.publicKey))).deposited.toNumber(), 0);
    await closeCard(userA);
    assert.isNull(await provider.connection.getAccountInfo(cardPda(userA.publicKey)));
  });
});

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { expect } from "chai";
import { Profile } from "../target/types/profile";

const { PublicKey, Keypair, LAMPORTS_PER_SOL } = anchor.web3;

describe("profile", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.profile as Program<Profile>;
  const me = provider.wallet.publicKey;

  const profilePda = (owner: anchor.web3.PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("profile"), owner.toBuffer()], program.programId)[0];
  const usernamePda = (name: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("username"), Buffer.from(name)], program.programId)[0];

  const funded = async () => {
    const kp = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    return kp;
  };

  const expectError = async (promise: Promise<unknown>, code: string) => {
    let error: any;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    expect(error, `expected error ${code}, but the transaction succeeded`).to.exist;
    expect(error.error?.errorCode?.code ?? String(error)).to.contain(code);
  };

  it("create_profile stores username and bio", async () => {
    await program.methods.createProfile("alice_dev", "Learning Solana").rpc();
    const profile = await program.account.profile.fetch(profilePda(me));
    expect(profile.authority.toBase58()).to.equal(me.toBase58());
    expect(profile.username).to.equal("alice_dev");
    expect(profile.bio).to.equal("Learning Solana");
    expect(profile.createdAt.toNumber()).to.be.greaterThan(0);
  });

  it("profile can be found by username", async () => {
    const record = await program.account.usernameRecord.fetch(usernamePda("alice_dev"));
    expect(record.owner.toBase58()).to.equal(me.toBase58());
    const profile = await program.account.profile.fetch(profilePda(record.owner));
    expect(profile.username).to.equal("alice_dev");
  });

  it("a taken username cannot be registered again", async () => {
    const bob = await funded();
    await expectError(
      program.methods.createProfile("alice_dev", "copycat").accounts({ authority: bob.publicKey }).signers([bob]).rpc(),
      "already in use"
    );
  });

  it("rejects invalid usernames", async () => {
    const bob = await funded();
    for (const bad of ["ab", "Has Space", "UPPER", "a".repeat(21)]) {
      await expectError(
        program.methods.createProfile(bad, "").accounts({ authority: bob.publicKey }).signers([bob]).rpc(),
        "InvalidUsername"
      );
    }
  });

  it("rejects a bio longer than 160 characters", async () => {
    const bob = await funded();
    await expectError(
      program.methods.createProfile("bob", "x".repeat(161)).accounts({ authority: bob.publicKey }).signers([bob]).rpc(),
      "BioTooLong"
    );
  });

  it("update_bio changes the bio", async () => {
    await program.methods.updateBio("Building on Solana").rpc();
    const profile = await program.account.profile.fetch(profilePda(me));
    expect(profile.bio).to.equal("Building on Solana");
    expect(profile.updatedAt.toNumber()).to.be.at.least(profile.createdAt.toNumber());
  });

  it("a stranger cannot update my profile", async () => {
    const eve = await funded();
    await expectError(
      program.methods.updateBio("hacked").accountsPartial({ authority: eve.publicKey, profile: profilePda(me) }).signers([eve]).rpc(),
      "ConstraintSeeds"
    );
  });

  it("delete_profile closes both accounts and frees the username", async () => {
    const before = await provider.connection.getBalance(me);
    await program.methods.deleteProfile().rpc();
    expect(await provider.connection.getAccountInfo(profilePda(me))).to.equal(null);
    expect(await provider.connection.getAccountInfo(usernamePda("alice_dev"))).to.equal(null);
    expect(await provider.connection.getBalance(me)).to.be.greaterThan(before); // rent вернулся

    const bob = await funded();
    await program.methods.createProfile("alice_dev", "now mine").accounts({ authority: bob.publicKey }).signers([bob]).rpc();
    const record = await program.account.usernameRecord.fetch(usernamePda("alice_dev"));
    expect(record.owner.toBase58()).to.equal(bob.publicKey.toBase58());
  });
});

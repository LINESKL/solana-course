import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { expect } from "chai";
import { Counter } from "../target/types/counter";

describe("counter", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.counter as Program<Counter>;
  const owner = provider.wallet.publicKey;

  // PDA счётчика: у каждого владельца свой адрес
  const counterFor = (authority: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("counter"), authority.toBuffer()],
      program.programId
    )[0];
  const counter = counterFor(owner);
  const count = async () => (await program.account.counter.fetch(counter)).count.toNumber();

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

  it("initialize creates a zero counter owned by the caller", async () => {
    await program.methods.initialize().rpc();
    const state = await program.account.counter.fetch(counter);
    expect(state.count.toNumber()).to.equal(0);
    expect(state.authority.toBase58()).to.equal(owner.toBase58());
  });

  it("increment adds one", async () => {
    await program.methods.increment().accounts({ counter }).rpc();
    await program.methods.increment().accounts({ counter }).rpc();
    expect(await count()).to.equal(2);
  });

  it("decrement subtracts one", async () => {
    await program.methods.decrement().accounts({ counter }).rpc();
    expect(await count()).to.equal(1);
  });

  it("reset sets the counter back to zero", async () => {
    await program.methods.reset().accounts({ counter }).rpc();
    expect(await count()).to.equal(0);
  });

  it("decrement below zero fails", async () => {
    await expectError(program.methods.decrement().accounts({ counter }).rpc(), "Underflow");
    expect(await count()).to.equal(0);
  });

  it("someone else cannot change my counter", async () => {
    const stranger = anchor.web3.Keypair.generate();
    await expectError(
      program.methods.increment().accounts({ counter, authority: stranger.publicKey }).signers([stranger]).rpc(),
      "Unauthorized"
    );
  });

  it("second initialize for the same owner fails", async () => {
    await expectError(program.methods.initialize().rpc(), "already in use");
  });
});

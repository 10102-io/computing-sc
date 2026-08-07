import { strict as assert } from "node:assert";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/** Matches the repo idiom: check a custom error selector inside revert data. */
function revertedWith(err: any, signature: string): boolean {
  const selector = ethers.utils.id(signature).slice(0, 10);
  const raw = JSON.stringify(err ?? "");
  return raw.includes(selector) || raw.includes(signature.replace("()", ""));
}

describe("QuantumRecoveryRegistry", function () {
  this.timeout(120000);

  async function deployFixture() {
    const [alice, bob] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("QuantumRecoveryRegistry");
    const registry = await Factory.deploy();
    await registry.deployed();
    return { registry, alice, bob };
  }

  const digest = (label: string) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label));

  it("registers a commitment for msg.sender with timestamp and event", async () => {
    const { registry, alice } = await loadFixture(deployFixture);
    const d = digest("slh-dsa pubkey");

    const tx = await registry.connect(alice).register(d, 1, ethers.constants.AddressZero);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    const parsed = receipt.logs
      .map((l: any) => {
        try {
          return registry.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e?.name === "CommitmentRegistered");
    assert(parsed, "CommitmentRegistered event not emitted");
    assert.equal(parsed!.args.account, alice.address);
    assert.equal(parsed!.args.index.toString(), "0");
    assert.equal(parsed!.args.digest, d);
    assert.equal(parsed!.args.scheme, 1);
    assert.equal(parsed!.args.recoveryContext, ethers.constants.AddressZero);

    assert.equal((await registry.commitmentCount(alice.address)).toString(), "1");
    const c = await registry.firstCommitment(alice.address);
    assert.equal(c.digest, d);
    assert.equal(c.scheme, 1);
    assert.equal(c.recoveryContext, ethers.constants.AddressZero);
    assert.equal(c.registeredAt.toString(), String(block.timestamp));
  });

  it("is append-only: later registrations never erase the first timestamp", async () => {
    const { registry, alice } = await loadFixture(deployFixture);
    const d1 = digest("first");
    const d2 = digest("second");

    await (await registry.connect(alice).register(d1, 5, ethers.constants.AddressZero)).wait();
    const first = await registry.firstCommitment(alice.address);

    await (await registry.connect(alice).register(d2, 2, ethers.constants.AddressZero)).wait();

    assert.equal((await registry.commitmentCount(alice.address)).toString(), "2");
    const firstAgain = await registry.firstCommitment(alice.address);
    assert.equal(firstAgain.digest, d1);
    assert.equal(firstAgain.registeredAt.toString(), first.registeredAt.toString());

    const latest = await registry.latestCommitment(alice.address);
    assert.equal(latest.digest, d2);
    assert.equal(latest.scheme, 2);

    const all = await registry.commitmentsOf(alice.address);
    assert.equal(all.length, 2);
    assert.equal(all[0].digest, d1);
    assert.equal(all[1].digest, d2);
  });

  it("keeps accounts isolated", async () => {
    const { registry, alice, bob } = await loadFixture(deployFixture);
    await (await registry.connect(alice).register(digest("alice"), 0, ethers.constants.AddressZero)).wait();

    assert.equal((await registry.commitmentCount(bob.address)).toString(), "0");
    assert.equal((await registry.commitmentsOf(bob.address)).length, 0);

    let caught: any = null;
    try {
      await registry.firstCommitment(bob.address);
    } catch (e) {
      caught = e;
    }
    assert(caught, "firstCommitment on empty history must revert");
  });

  it("stores an optional recoveryContext", async () => {
    const { registry, alice, bob } = await loadFixture(deployFixture);
    // e.g. the account's legacy contract or Safe address
    await (await registry.connect(alice).register(digest("bound"), 1, bob.address)).wait();
    const c = await registry.latestCommitment(alice.address);
    assert.equal(c.recoveryContext, bob.address);
  });

  it("rejects an empty digest", async () => {
    const { registry, alice } = await loadFixture(deployFixture);
    let caught: any = null;
    try {
      await (await registry.connect(alice).register(ethers.constants.HashZero, 0, ethers.constants.AddressZero)).wait();
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected empty digest to revert");
    assert(revertedWith(caught, "EmptyDigest()"), `got: ${caught?.message}`);
  });

  it("accepts any scheme label without gating (future schemes)", async () => {
    const { registry, alice } = await loadFixture(deployFixture);
    await (await registry.connect(alice).register(digest("future"), 200, ethers.constants.AddressZero)).wait();
    const c = await registry.latestCommitment(alice.address);
    assert.equal(c.scheme, 200);
  });
});

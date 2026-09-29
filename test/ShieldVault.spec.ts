import { strict as assert } from "node:assert";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { increase } from "./utils/time";

// ShieldVault (docs/plans/shield-vault.md). Each block pins one invariant of
// the spec's threat model; the property test at the end drives random
// operation sequences and checks the accounting invariant after each step.

const DAY = 86400;
const NO_VETO = ethers.constants.MaxUint256;
const SCHEME_HASH_PREIMAGE = 5;
const E18 = ethers.constants.WeiPerEther;
/** `open`'s maxFeeBps: the contract's cap, so no test trips on it unless it means to. */
const MAX_FEE = 50;

function revertedWith(err: any, signature: string): boolean {
  const selector = ethers.utils.id(signature).slice(0, 10);
  const raw = (JSON.stringify(err ?? "") + " " + (err?.message ?? "")).toLowerCase();
  return raw.includes(selector.toLowerCase()) || raw.includes(signature.replace("()", "").toLowerCase());
}

async function expectRevert(p: Promise<unknown>, signature: string, label = ""): Promise<void> {
  let caught: any;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  assert(caught, `${label} expected revert ${signature}`);
  assert(revertedWith(caught, signature), `${label} expected ${signature}, got: ${caught?.message}`);
}

const config = (
  exitDelayDays: number,
  silenceDays = 0,
  beneficiaries: string[] = [],
  sharesBps: number[] = [],
  holdMask = 0
) => ({
  exitDelay: exitDelayDays * DAY,
  silencePeriod: silenceDays * DAY,
  beneficiaries,
  sharesBps,
  holdMask,
});

const SIG_TYPES = {
  CheckIn: [
    { name: "id", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  CancelPending: [
    { name: "id", type: "uint256" },
    { name: "readyAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  ClaimOwed: [
    { name: "id", type: "uint256" },
    { name: "beneficiary", type: "address" },
    { name: "to", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

describe("ShieldVault", function () {
  this.timeout(180000);

  async function deployFixture() {
    const [admin, owner, alice, bob, thief, relayer, recovery, carol, treasury] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("QuantumRecoveryRegistry")).deploy();
    const token = await (await ethers.getContractFactory("MockAwkwardERC20")).deploy();
    const other = await (await ethers.getContractFactory("MockAwkwardERC20")).deploy();
    // Fee 0 here, so every pre-fee invariant reads as before; the fee block sets it.
    const vault = await (await ethers.getContractFactory("ShieldVault")).deploy(
      registry.address,
      admin.address,
      [token.address],
      treasury.address,
      0
    );
    for (const s of [owner, alice, bob, thief]) {
      await token.mint(s.address, E18.mul(1000));
      await token.connect(s).approve(vault.address, ethers.constants.MaxUint256);
    }
    const chainId = (await ethers.provider.getNetwork()).chainId;
    /** The v2 commitment: bound to chain, vault, owner, secret and recovery wallet. */
    const vetoDigest = (owner: string, secret: string, to: string) =>
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", "uint256", "address", "address", "bytes32", "address"],
          [ethers.utils.id("10102.ShieldVault.veto.v2"), chainId, vault.address, owner, secret, to]
        )
      );
    const domain = { name: "10102 ShieldVault", version: "2", chainId, verifyingContract: vault.address };
    /** EIP-712 signature by `signer` over a `kind` struct of the vault's domain. */
    const sign = (signer: any, kind: keyof typeof SIG_TYPES, value: Record<string, unknown>) =>
      signer._signTypedData(domain, { [kind]: SIG_TYPES[kind] }, value);
    return { admin, owner, alice, bob, thief, relayer, recovery, carol, treasury, registry, token, other, vault, vetoDigest, sign };
  }

  const deadlineIn = async (seconds: number) => (await ethers.provider.getBlock("latest")).timestamp + seconds;

  /** Registers a scheme-5 commitment for `signer` and returns its index. */
  async function commit(f: any, signer: any, secret: string, to: string): Promise<number> {
    const index = (await f.registry.commitmentCount(signer.address)).toNumber();
    await f.registry.connect(signer).register(f.vetoDigest(signer.address, secret, to), SCHEME_HASH_PREIMAGE, f.vault.address);
    return index;
  }

  async function openWithVeto(f: any, amount = E18.mul(10)) {
    const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const index = await commit(f, f.owner, secret, f.recovery.address);
    await f.vault.connect(f.owner).open(f.token.address, amount, config(30, 365, [f.alice.address, f.bob.address], [6000, 4000]), index, MAX_FEE);
    return { id: (await f.vault.positionCount()).toNumber(), secret };
  }

  // ───────────── opening and config validation ─────────────

  it("opens a position, credits the deposit, lists it for the owner", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    const p = await f.vault.positionOf(id);
    assert.equal(p.owner, f.owner.address);
    assert.equal(p.balance.toString(), E18.mul(10).toString());
    assert.equal(p.config.exitDelay, 30 * DAY);
    assert.notEqual(p.vetoDigest, ethers.constants.HashZero);
    assert.deepEqual((await f.vault.positionsOf(f.owner.address)).map((x: any) => x.toNumber()), [id]);
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), E18.mul(10).toString());
  });

  it("rejects invalid configs", async () => {
    const f = await loadFixture(deployFixture);
    const open = (c: any) => f.vault.connect(f.owner).open(f.token.address, E18, c, NO_VETO, MAX_FEE);
    await expectRevert(open(config(10)), "InvalidDelay()", "delay not in the set:");
    await expectRevert(open(config(30, 100, [f.alice.address], [10000])), "InvalidSilence()", "silence too short:");
    await expectRevert(open(config(30, 2000, [f.alice.address], [10000])), "InvalidSilence()", "silence too long:");
    await expectRevert(open(config(30, 365, [], [])), "InvalidBeneficiaries()", "fallback without people:");
    await expectRevert(open(config(30, 0, [f.alice.address], [10000])), "InvalidBeneficiaries()", "people without fallback:");
    await expectRevert(open(config(30, 365, [f.alice.address, f.bob.address], [5000, 4000])), "InvalidBeneficiaries()", "shares != 100%:");
    await expectRevert(open(config(30, 365, [f.alice.address, f.alice.address], [5000, 5000])), "InvalidBeneficiaries()", "duplicate:");
    await expectRevert(open(config(30, 365, [ethers.constants.AddressZero], [10000])), "InvalidBeneficiaries()", "zero address:");
    await expectRevert(open(config(30, 365, [f.alice.address, f.bob.address], [10000, 0])), "InvalidBeneficiaries()", "zero share:");
    const eleven = Array.from({ length: 11 }, () => ethers.Wallet.createRandom().address);
    const shares = [...Array(10).fill(909), 910];
    await expectRevert(open(config(30, 365, eleven, shares)), "InvalidBeneficiaries()", "more than 10:");
  });

  it("only accepts supported tokens, credits what actually arrives, and pauses deposits only", async () => {
    const f = await loadFixture(deployFixture);
    await expectRevert(f.vault.connect(f.owner).open(f.other.address, E18, config(7), NO_VETO, MAX_FEE), "TokenNotSupported()");

    await f.token.setFeeBps(100); // 1% transfer fee
    await f.vault.connect(f.owner).open(f.token.address, E18.mul(100), config(7), NO_VETO, MAX_FEE);
    const p = await f.vault.positionOf(1);
    assert.equal(p.balance.toString(), E18.mul(99).toString(), "credited the received delta");
    await f.token.setFeeBps(0);

    await expectRevert(f.vault.connect(f.thief).setDepositsPaused(true), "OwnableUnauthorizedAccount(address)", "admin only:");
    await f.vault.connect(f.admin).setDepositsPaused(true);
    await expectRevert(f.vault.connect(f.owner).deposit(1, E18), "DepositsPaused()");
    // Exits are never pausable.
    await f.vault.connect(f.owner).requestWithdraw(1, E18.mul(99), f.owner.address);
    await increase(7 * DAY);
    await f.vault.connect(f.relayer).executePending(1);
    assert.equal((await f.vault.positionOf(1)).closed, true);
  });

  it("removing a token's support blocks deposits, never exits", async () => {
    const f = await loadFixture(deployFixture);
    const { id, secret } = await openWithVeto(f);
    await f.vault.connect(f.admin).setTokenSupported(f.token.address, false);
    await expectRevert(f.vault.connect(f.owner).deposit(id, E18), "TokenNotSupported()");
    await f.vault.connect(f.relayer).veto(id, secret, f.recovery.address);
    assert.equal((await f.token.balanceOf(f.recovery.address)).toString(), E18.mul(10).toString());
  });

  // ───────────── withdrawal waits the delay ─────────────

  it("a withdrawal waits the exit delay, then anyone can finish it to the address fixed at request", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    await f.vault.connect(f.owner).requestWithdraw(id, E18.mul(4), f.carol.address);
    await expectRevert(f.vault.connect(f.relayer).executePending(id), "NotReady()");
    await increase(30 * DAY - 10);
    await expectRevert(f.vault.connect(f.relayer).executePending(id), "NotReady()", "one second early:");
    await increase(10);
    await f.vault.connect(f.relayer).executePending(id);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(4).toString());
    const p = await f.vault.positionOf(id);
    assert.equal(p.balance.toString(), E18.mul(6).toString());
    assert.equal(p.closed, false, "partial withdrawal keeps the position open");
    await expectRevert(f.vault.connect(f.relayer).executePending(id), "NothingPending()", "no replay:");
  });

  it("only the owner starts or cancels; one pending operation at a time", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    await expectRevert(f.vault.connect(f.thief).requestWithdraw(id, E18, f.thief.address), "NotOwner()");
    await expectRevert(f.vault.connect(f.owner).requestWithdraw(id, E18.mul(11), f.owner.address), "InsufficientBalance()");
    await expectRevert(f.vault.connect(f.owner).requestWithdraw(id, E18, ethers.constants.AddressZero), "InvalidAddress()");
    await expectRevert(f.vault.connect(f.owner).requestWithdraw(id, E18, f.vault.address), "InvalidAddress()");
    await f.vault.connect(f.owner).requestWithdraw(id, E18, f.owner.address);
    await expectRevert(f.vault.connect(f.owner).requestWithdraw(id, E18, f.owner.address), "PendingExists()");
    await expectRevert(f.vault.connect(f.thief).cancelPending(id), "NotOwner()");
    await f.vault.connect(f.owner).cancelPending(id);
    await increase(31 * DAY);
    await expectRevert(f.vault.connect(f.relayer).executePending(id), "NothingPending()", "cancelled cannot execute:");
  });

  // ───────────── the veto ─────────────

  it("the veto moves everything to the committed wallet at once, clearing a pending theft", async () => {
    const f = await loadFixture(deployFixture);
    const { id, secret } = await openWithVeto(f);
    // The thief holds the owner's key: they request a withdrawal to themselves.
    await f.vault.connect(f.owner).requestWithdraw(id, E18.mul(10), f.thief.address);
    await f.vault.connect(f.relayer).veto(id, secret, f.recovery.address);
    assert.equal((await f.token.balanceOf(f.recovery.address)).toString(), E18.mul(10).toString());
    const p = await f.vault.positionOf(id);
    assert.equal(p.closed, true);
    assert.equal(p.pending.kind, 0, "pending cleared");
    await increase(31 * DAY);
    await expectRevert(f.vault.connect(f.relayer).executePending(id), "PositionClosed()");
    assert.equal((await f.token.balanceOf(f.thief.address)).toString(), E18.mul(1000).toString(), "thief got nothing");
  });

  it("a copied secret cannot redirect: the destination is part of the commitment", async () => {
    const f = await loadFixture(deployFixture);
    const { id, secret } = await openWithVeto(f);
    await expectRevert(f.vault.connect(f.thief).veto(id, secret, f.thief.address), "WrongSecret()", "front-run with own address:");
    await expectRevert(
      f.vault.connect(f.thief).veto(id, ethers.utils.hexlify(ethers.utils.randomBytes(32)), f.recovery.address),
      "WrongSecret()",
      "guessed secret:"
    );
    await expectRevert(f.vault.connect(f.thief).veto(id, secret, ethers.constants.AddressZero), "InvalidAddress()");
    // A front-runner who copies the exact call only does the owner's bidding.
    await f.vault.connect(f.thief).veto(id, secret, f.recovery.address);
    assert.equal((await f.token.balanceOf(f.recovery.address)).toString(), E18.mul(10).toString());
  });

  it("a commitment made for another vault, chain or owner, or in the v1 format, does not verify here", async () => {
    const f = await loadFixture(deployFixture);
    const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const enc = (types: string[], values: unknown[]) => ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(types, values));
    const v2 = ["bytes32", "uint256", "address", "address", "bytes32", "address"];
    const tag = ethers.utils.id("10102.ShieldVault.veto.v2");
    const foreign = [
      enc(v2, [tag, 1, f.carol.address, f.owner.address, secret, f.recovery.address]), // other chain and vault
      enc(v2, [tag, chainId, f.vault.address, f.alice.address, secret, f.recovery.address]), // other owner
      enc(
        ["bytes32", "uint256", "address", "bytes32", "address"],
        [ethers.utils.id("10102.ShieldVault.veto.v1"), chainId, f.vault.address, secret, f.recovery.address]
      ) // a v1 sheet
    ];
    for (const [i, digest] of foreign.entries()) {
      await f.registry.connect(f.owner).register(digest, SCHEME_HASH_PREIMAGE, ethers.constants.AddressZero);
      await f.vault.connect(f.owner).open(f.token.address, E18, config(7), i, MAX_FEE);
      await expectRevert(f.vault.veto(i + 1, secret, f.recovery.address), "WrongSecret()", `commitment ${i}:`);
    }
  });

  it("the thief's fresh commitment is useless: the vault honours only the pinned one", async () => {
    const f = await loadFixture(deployFixture);
    const { id, secret } = await openWithVeto(f);
    // With the owner's key, the thief registers their own commitment.
    const thiefSecret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const thiefIndex = await commit(f, f.owner, thiefSecret, f.thief.address);
    await expectRevert(f.vault.veto(id, thiefSecret, f.thief.address), "WrongSecret()", "unpinned commitment:");

    // They can only try to install it through a delayed change...
    await f.vault.connect(f.owner).requestChange(id, config(30, 365, [f.alice.address, f.bob.address], [6000, 4000]), thiefIndex);
    await expectRevert(f.vault.veto(id, thiefSecret, f.thief.address), "WrongSecret()", "still pending:");
    // ...which the real secret stops for the whole wait.
    await f.vault.veto(id, secret, f.recovery.address);
    assert.equal((await f.token.balanceOf(f.recovery.address)).toString(), E18.mul(10).toString());
  });

  it("only scheme-5 commitments of the caller can be pinned", async () => {
    const f = await loadFixture(deployFixture);
    await f.registry.connect(f.owner).register(ethers.utils.id("a pq key"), 1, ethers.constants.AddressZero);
    await expectRevert(f.vault.connect(f.owner).open(f.token.address, E18, config(7), 0, MAX_FEE), "InvalidCommitment()");
    // Index belongs to the caller: alice has no commitment 0.
    let caught: any;
    try {
      await f.vault.connect(f.alice).open(f.token.address, E18, config(7), 0, MAX_FEE);
    } catch (e) {
      caught = e;
    }
    assert(caught, "someone else's index must not resolve");
    await expectRevert(f.vault.connect(f.owner).open(f.token.address, E18, config(7), NO_VETO, MAX_FEE).then(() => f.vault.veto(1, ethers.constants.HashZero, f.recovery.address)), "NoVeto()");
  });

  // ───────────── config changes ─────────────

  it("a config change waits the CURRENT delay, then applies, including a new veto commitment", async () => {
    const f = await loadFixture(deployFixture);
    const { id, secret } = await openWithVeto(f);
    const newSecret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const newIndex = await commit(f, f.owner, newSecret, f.carol.address);
    await f.vault.connect(f.owner).requestChange(id, config(7, 180, [f.carol.address], [10000]), newIndex);
    await increase(29 * DAY);
    await expectRevert(f.vault.executePending(id), "NotReady()", "old 30-day delay still applies:");
    await increase(1 * DAY);
    await f.vault.connect(f.relayer).executePending(id);
    const p = await f.vault.positionOf(id);
    assert.equal(p.config.exitDelay, 7 * DAY);
    assert.deepEqual(p.config.beneficiaries, [f.carol.address]);
    await expectRevert(f.vault.veto(id, secret, f.recovery.address), "WrongSecret()", "old secret retired:");
    await f.vault.veto(id, newSecret, f.carol.address);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(10).toString());
  });

  // ───────────── inactivity fallback ─────────────

  it("after the silence period anyone pays the beneficiaries their shares; activity resets the clock", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    await increase(364 * DAY);
    await expectRevert(f.vault.executeFallback(id), "OwnerStillActive()");
    await f.vault.connect(f.owner).checkIn(id);
    await increase(364 * DAY);
    await expectRevert(f.vault.executeFallback(id), "OwnerStillActive()", "check-in reset the clock:");
    await increase(1 * DAY);
    const before = await f.token.balanceOf(f.alice.address);
    await f.vault.connect(f.relayer).executeFallback(id);
    assert.equal((await f.token.balanceOf(f.alice.address)).sub(before).toString(), E18.mul(6).toString());
    assert.equal((await f.token.balanceOf(f.bob.address)).sub(E18.mul(1000)).toString(), E18.mul(4).toString());
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), "0");
    await expectRevert(f.vault.executeFallback(id), "PositionClosed()", "no second fallback:");
  });

  it("a deposit by a stranger does not count as the owner's activity", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    await increase(360 * DAY);
    await f.vault.connect(f.thief).deposit(id, E18);
    await increase(5 * DAY);
    await f.vault.executeFallback(id);
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), "0");
  });

  it("a pending operation blocks the fallback until someone finishes it", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    await f.vault.connect(f.owner).requestWithdraw(id, E18.mul(2), f.owner.address);
    await increase(400 * DAY);
    await expectRevert(f.vault.executeFallback(id), "PendingExists()");
    await f.vault.executePending(id);
    await f.vault.executeFallback(id);
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), "0");
  });

  it("a blacklisted beneficiary does not block the others; its share stays claimable", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    await f.token.setBlocked(f.bob.address, true);
    await increase(366 * DAY);
    await f.vault.executeFallback(id);
    assert.equal((await f.token.balanceOf(f.alice.address)).sub(E18.mul(1000)).toString(), E18.mul(6).toString());
    assert.equal((await f.vault.owed(id, f.bob.address)).toString(), E18.mul(4).toString());
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), E18.mul(4).toString(), "owed stays in the vault");
    await expectRevert(f.vault.claimOwed(id, f.bob.address), "blocked", "still blocked:");
    await f.token.setBlocked(f.bob.address, false);
    await f.vault.connect(f.relayer).claimOwed(id, f.bob.address);
    assert.equal((await f.token.balanceOf(f.bob.address)).sub(E18.mul(1000)).toString(), E18.mul(4).toString());
    await expectRevert(f.vault.claimOwed(id, f.bob.address), "NothingOwed()");
  });

  it("a position without a fallback never pays anyone but its owner", async () => {
    const f = await loadFixture(deployFixture);
    await f.vault.connect(f.owner).open(f.token.address, E18, config(7), NO_VETO, MAX_FEE);
    await increase(2000 * DAY);
    await expectRevert(f.vault.executeFallback(1), "NoFallback()");
  });

  // ───────────── findings of the 2026-09-28 review ─────────────

  it("a withdrawal payee that cannot receive becomes owed instead of freezing the position", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    await f.vault.connect(f.owner).requestWithdraw(id, E18.mul(4), f.carol.address);
    await f.token.setBlocked(f.carol.address, true); // blacklisted after the request
    await increase(30 * DAY);
    await f.vault.connect(f.relayer).executePending(id);
    assert.equal((await f.vault.owed(id, f.carol.address)).toString(), E18.mul(4).toString());
    const p = await f.vault.positionOf(id);
    assert.equal(p.pending.kind, 0, "pending slot cleared");
    assert.equal(p.balance.toString(), E18.mul(6).toString());
    // The inheritance path is no longer blocked.
    await increase(366 * DAY);
    await f.vault.executeFallback(id);
    await f.token.setBlocked(f.carol.address, false);
    await f.vault.claimOwed(id, f.carol.address);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(4).toString());
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), "0");
  });

  it("withdrawing ALL resolves at execution, so a stranger's dust cannot keep the position open", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    const ALL = await f.vault.ALL();
    await f.vault.connect(f.owner).requestWithdraw(id, ALL, f.carol.address);
    await f.vault.connect(f.thief).deposit(id, 1);
    await increase(30 * DAY);
    await f.vault.executePending(id);
    const p = await f.vault.positionOf(id);
    assert.equal(p.closed, true);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(10).add(1).toString());
    await expectRevert(f.vault.connect(f.thief).deposit(id, 1), "PositionClosed()", "closed stays closed:");
  });

  it("the vault itself cannot be a beneficiary", async () => {
    const f = await loadFixture(deployFixture);
    await expectRevert(
      f.vault.connect(f.owner).open(f.token.address, E18, config(7, 365, [f.vault.address], [10000]), NO_VETO, MAX_FEE),
      "InvalidBeneficiaries()"
    );
  });

  it("one recovery sheet protects one position; keeping it through a change is allowed", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    const reused = (await f.registry.commitmentCount(f.owner.address)).toNumber() - 1;
    await expectRevert(
      f.vault.connect(f.owner).open(f.token.address, E18, config(7), reused, MAX_FEE),
      "CommitmentReused()",
      "second position on the same sheet:"
    );
    await f.vault.connect(f.owner).requestChange(id, config(30, 180, [f.carol.address], [10000]), reused);
    const ev = (await f.vault.queryFilter(f.vault.filters.ChangeRequested(id))).pop()!;
    assert.equal(ev.args!.newVetoDigest, (await f.vault.positionOf(id)).vetoDigest, "event names the digest");
    assert.equal(
      ev.args!.beneficiariesHash,
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(["address[]", "uint16[]", "uint16"], [[f.carol.address], [10000], 0])
      )
    );
  });

  it("changing to a short delay does not shorten anything until the change itself has waited", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f); // 30-day delay
    await f.vault.connect(f.owner).requestChange(id, config(7, 365, [f.alice.address, f.bob.address], [6000, 4000]), NO_VETO);
    await expectRevert(f.vault.connect(f.owner).requestWithdraw(id, E18, f.owner.address), "PendingExists()");
    await increase(30 * DAY);
    await f.vault.executePending(id);
    await f.vault.connect(f.owner).requestWithdraw(id, E18, f.owner.address);
    await increase(7 * DAY - 10);
    await expectRevert(f.vault.executePending(id), "NotReady()", "7 days only after the 30-day change:");
    // Cancel and re-request restarts the full delay.
    await f.vault.connect(f.owner).cancelPending(id);
    await f.vault.connect(f.owner).requestWithdraw(id, E18, f.owner.address);
    await increase(20);
    await expectRevert(f.vault.executePending(id), "NotReady()", "re-request restarts the clock:");
  });

  it("exits keep working with deposits paused and the token delisted", async () => {
    const f = await loadFixture(deployFixture);
    const a = await openWithVeto(f);
    const b = await openWithVeto(f);
    await f.vault.connect(f.owner).requestWithdraw(a.id, E18, f.owner.address);
    await f.vault.connect(f.admin).setDepositsPaused(true);
    await f.vault.connect(f.admin).setTokenSupported(f.token.address, false);
    await f.token.setBlocked(f.bob.address, true);
    await increase(366 * DAY);
    await f.vault.executePending(a.id);
    await f.vault.executeFallback(b.id);
    await f.token.setBlocked(f.bob.address, false);
    await f.vault.claimOwed(b.id, f.bob.address);
    await f.vault.veto(a.id, a.secret, f.recovery.address);
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), "0");
  });

  it("fallbackAvailableAt accounts for a pending operation", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    const opened = (await f.vault.positionOf(id)).lastActivity.toNumber();
    assert.equal((await f.vault.fallbackAvailableAt(id)).toNumber(), opened + 365 * DAY);
    await increase(340 * DAY);
    await f.vault.connect(f.owner).requestWithdraw(id, E18, f.owner.address); // activity + 30-day wait
    const p = await f.vault.positionOf(id);
    assert.equal((await f.vault.fallbackAvailableAt(id)).toNumber(), p.lastActivity.toNumber() + 365 * DAY);
  });

  // ───────────── v2: findings of the audit preparation, fee, signed actions ─────────────

  it("a copied digest can neither burn the owner's sheet nor absorb its veto in a decoy", async () => {
    const f = await loadFixture(deployFixture);
    const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const index = await commit(f, f.owner, secret, f.recovery.address);
    const digest = f.vetoDigest(f.owner.address, secret, f.recovery.address);
    // A griefer copies the public digest into its own registry entry and opens a decoy with it first.
    const copied = (await f.registry.commitmentCount(f.thief.address)).toNumber();
    await f.registry.connect(f.thief).register(digest, SCHEME_HASH_PREIMAGE, f.vault.address);
    await f.vault.connect(f.thief).open(f.token.address, 1, config(7), copied, MAX_FEE);
    // The owner's open still works (per-owner pinning).
    await f.vault.connect(f.owner).open(f.token.address, E18, config(30), index, MAX_FEE);
    assert.equal(await f.vault.digestPinned(f.owner.address, digest), true);
    // The owner's secret never verifies on the decoy (the digest binds the owner) ...
    await expectRevert(f.vault.veto(1, secret, f.recovery.address), "WrongSecret()", "decoy:");
    // ... and stops the real holding.
    await f.vault.connect(f.owner).requestWithdraw(2, await f.vault.ALL(), f.thief.address);
    await f.vault.veto(2, secret, f.recovery.address);
    assert.equal((await f.token.balanceOf(f.recovery.address)).toString(), E18.toString());
    const ev = (await f.vault.queryFilter(f.vault.filters.PositionOpened(2))).pop()!;
    assert.equal(ev.args!.vetoDigest, digest, "the digest is in the open event, for sheet-only lookups");
  });

  it("open refuses a fee above the caller's bound, so a raise cannot catch it mid-flight", async () => {
    const f = await loadFixture(deployFixture);
    await f.vault.connect(f.admin).setFee(50);
    await expectRevert(f.vault.connect(f.owner).open(f.token.address, E18, config(7), NO_VETO, 25), "FeeTooHigh()");
    await f.vault.connect(f.owner).open(f.token.address, E18, config(7), NO_VETO, 50);
    assert.equal((await f.vault.positionOf(1)).feeBps, 50);
  });

  it("each signed action has its own nonce: a check-in never voids a cancel or a claim", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    await f.vault.connect(f.owner).requestWithdraw(id, E18, f.thief.address);
    const deadline = await deadlineIn(3600);
    const readyAt = (await f.vault.positionOf(id)).pending.readyAt;
    const cancel = await f.sign(f.owner, "CancelPending", { id, readyAt, nonce: 0, deadline });
    // A thief holding the same key spends check-in nonces...
    for (let n = 0; n < 3; n++) {
      await f.vault.checkInWithSig(id, deadline, await f.sign(f.owner, "CheckIn", { id, nonce: n, deadline }));
    }
    // ...and the owner's signed cancel still works.
    await f.vault.connect(f.relayer).cancelPendingWithSig(id, deadline, cancel);
    assert.equal((await f.vault.positionOf(id)).pending.kind, 0);
    assert.equal((await f.vault.nonces(f.owner.address, 0)).toNumber(), 3);
    assert.equal((await f.vault.nonces(f.owner.address, 1)).toNumber(), 1);
    assert.equal((await f.vault.nonces(f.owner.address, 2)).toNumber(), 0);
  });

  it("nobody can push a held share onto its card's address; only the card moves it", async () => {
    const f = await loadFixture(deployFixture);
    const paper = ethers.Wallet.createRandom();
    await f.vault
      .connect(f.owner)
      .open(f.token.address, E18.mul(10), config(30, 365, [f.alice.address, paper.address], [5000, 5000], 2), NO_VETO, MAX_FEE);
    await increase(366 * DAY);
    const tx = await f.vault.executeFallback(1);
    const held = (await tx.wait()).events!.find((e: any) => e.event === "ShareHeld");
    assert.equal(held?.args?.beneficiary, paper.address, "a held share has its own event");
    await expectRevert(f.vault.connect(f.relayer).claimOwed(1, paper.address), "ShareIsHeld()");
    const deadline = await deadlineIn(3600);
    const sig = await f.sign(paper, "ClaimOwed", { id: 1, beneficiary: paper.address, to: f.carol.address, nonce: 0, deadline });
    await f.vault.connect(f.relayer).claimOwedWithSig(1, paper.address, f.carol.address, deadline, sig);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(5).toString());
  });

  it("a veto never fails: an unpayable recovery wallet is owed, and the thief's withdrawal is gone", async () => {
    const f = await loadFixture(deployFixture);
    const { id, secret } = await openWithVeto(f);
    await f.vault.connect(f.owner).requestWithdraw(id, await f.vault.ALL(), f.thief.address);
    await f.token.setBlocked(f.recovery.address, true);
    await increase(30 * DAY);
    await f.vault.connect(f.relayer).veto(id, secret, f.recovery.address);
    const p = await f.vault.positionOf(id);
    assert.equal(p.closed, true);
    assert.equal(p.pending.kind, 0, "the theft is cleared");
    assert.equal((await f.vault.owed(id, f.recovery.address)).toString(), E18.mul(10).toString());
    await expectRevert(f.vault.executePending(id), "PositionClosed()", "nothing left to execute:");
    await f.token.setBlocked(f.recovery.address, false);
    await f.vault.claimOwed(id, f.recovery.address);
    assert.equal((await f.token.balanceOf(f.recovery.address)).toString(), E18.mul(10).toString());
  });

  it("fallbackAvailableAt follows a pending change and is 0 for closed or unknown positions", async () => {
    const f = await loadFixture(deployFixture);
    const { id, secret } = await openWithVeto(f);
    await f.vault.connect(f.owner).requestChange(id, config(30), NO_VETO);
    assert.equal((await f.vault.fallbackAvailableAt(id)).toNumber(), 0, "the change would remove the fallback");
    await f.vault.connect(f.owner).cancelPending(id);
    await f.vault.connect(f.owner).requestChange(id, config(30, 730, [f.carol.address], [10000]), NO_VETO);
    const p = await f.vault.positionOf(id);
    assert.equal((await f.vault.fallbackAvailableAt(id)).toNumber(), p.lastActivity.toNumber() + 730 * DAY);
    assert.equal((await f.vault.fallbackAvailableAt(999)).toNumber(), 0);
    await f.vault.veto(id, secret, f.recovery.address);
    assert.equal((await f.vault.fallbackAvailableAt(id)).toNumber(), 0);
  });

  it("the fee is fixed at opening, capped, charged on withdrawals and releases, never on a veto", async () => {
    const f = await loadFixture(deployFixture);
    await expectRevert(f.vault.connect(f.admin).setFee(51), "FeeTooHigh()");
    await f.vault.connect(f.admin).setFee(25);
    const a = await openWithVeto(f); // 10 E18 at 0.25%
    await f.vault.connect(f.admin).setFee(50);
    assert.equal((await f.vault.positionOf(a.id)).feeBps, 25, "a later rate never applies to an open position");

    await f.vault.connect(f.owner).requestWithdraw(a.id, E18.mul(4), f.carol.address);
    await increase(30 * DAY);
    await f.vault.executePending(a.id);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(4).mul(9975).div(10000).toString());
    assert.equal((await f.vault.feesAccrued(f.token.address)).toString(), E18.mul(4).mul(25).div(10000).toString());

    await increase(366 * DAY);
    await f.vault.executeFallback(a.id); // 6 E18 at 0.25%, then 60/40
    const releasedNet = E18.mul(6).sub(E18.mul(6).mul(25).div(10000));
    const alice = (await f.token.balanceOf(f.alice.address)).sub(E18.mul(1000));
    const bob = (await f.token.balanceOf(f.bob.address)).sub(E18.mul(1000));
    assert.equal(alice.add(bob).toString(), releasedNet.toString());

    const b = await openWithVeto(f); // opened at 0.5%
    await f.vault.veto(b.id, b.secret, f.recovery.address);
    assert.equal((await f.token.balanceOf(f.recovery.address)).toString(), E18.mul(10).toString(), "a stop is free");

    const accrued = await f.vault.feesAccrued(f.token.address);
    await f.vault.connect(f.relayer).collectFees(f.token.address);
    assert.equal((await f.token.balanceOf(f.treasury.address)).toString(), accrued.toString());
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), "0");
    await expectRevert(f.vault.collectFees(f.token.address), "NothingOwed()");
  });

  it("an unpayable fee recipient never blocks an exit", async () => {
    const f = await loadFixture(deployFixture);
    await f.vault.connect(f.admin).setFee(50);
    const { id } = await openWithVeto(f);
    await f.token.setBlocked(f.treasury.address, true);
    await f.vault.connect(f.owner).requestWithdraw(id, await f.vault.ALL(), f.owner.address);
    await increase(30 * DAY);
    await f.vault.executePending(id);
    await expectRevert(f.vault.collectFees(f.token.address), "blocked", "collect fails alone:");
    await f.vault.connect(f.admin).setFeeRecipient(f.carol.address);
    await f.vault.collectFees(f.token.address);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(10).mul(50).div(10000).toString());
  });

  it("a held share waits for its paper key, which sends it anywhere without paying gas", async () => {
    const f = await loadFixture(deployFixture);
    const paper = ethers.Wallet.createRandom(); // never funded
    await expectRevert(
      f.vault.connect(f.owner).open(f.token.address, E18, config(7, 365, [f.alice.address], [10000], 2), NO_VETO, MAX_FEE),
      "InvalidBeneficiaries()",
      "mask beyond the list:"
    );
    await expectRevert(
      f.vault.connect(f.owner).open(f.token.address, E18, config(7, 0, [], [], 1), NO_VETO, MAX_FEE),
      "InvalidBeneficiaries()",
      "mask without a fallback:"
    );
    await f.vault
      .connect(f.owner)
      .open(f.token.address, E18.mul(10), config(30, 365, [f.alice.address, paper.address], [5000, 5000], 2), NO_VETO, MAX_FEE);
    await increase(366 * DAY);
    await f.vault.executeFallback(1);
    assert.equal((await f.token.balanceOf(f.alice.address)).sub(E18.mul(1000)).toString(), E18.mul(5).toString());
    assert.equal((await f.token.balanceOf(paper.address)).toString(), "0", "held, not sent");
    assert.equal((await f.vault.owed(1, paper.address)).toString(), E18.mul(5).toString());

    const deadline = await deadlineIn(3600);
    const value = { id: 1, beneficiary: paper.address, to: f.carol.address, nonce: 0, deadline };
    const forged = await f.sign(f.thief, "ClaimOwed", value);
    await expectRevert(
      f.vault.connect(f.relayer).claimOwedWithSig(1, paper.address, f.carol.address, deadline, forged),
      "InvalidSignature()"
    );
    const good = await f.sign(paper, "ClaimOwed", value);
    await expectRevert(
      f.vault.connect(f.relayer).claimOwedWithSig(1, paper.address, f.thief.address, deadline, good),
      "InvalidSignature()",
      "the destination is signed:"
    );
    await f.vault.connect(f.relayer).claimOwedWithSig(1, paper.address, f.carol.address, deadline, good);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(5).toString());
    await expectRevert(
      f.vault.connect(f.relayer).claimOwedWithSig(1, paper.address, f.carol.address, deadline, good),
      "InvalidSignature()",
      "replay (nonce used):"
    );
    const late = await f.sign(paper, "ClaimOwed", { ...value, nonce: 1, deadline: 1 });
    await expectRevert(f.vault.claimOwedWithSig(1, paper.address, f.carol.address, 1, late), "SignatureExpired()");
  });

  it("the owner's signed check-in and cancel can be sent by anyone, once, for what was signed", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    await increase(100 * DAY);
    const deadline = await deadlineIn(3600);
    const sig = await f.sign(f.owner, "CheckIn", { id, nonce: 0, deadline });
    await expectRevert(
      f.vault.connect(f.relayer).checkInWithSig(id, deadline, await f.sign(f.thief, "CheckIn", { id, nonce: 0, deadline })),
      "InvalidSignature()"
    );
    await f.vault.connect(f.relayer).checkInWithSig(id, deadline, sig);
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    assert.equal((await f.vault.positionOf(id)).lastActivity.toNumber(), now);
    await expectRevert(f.vault.connect(f.relayer).checkInWithSig(id, deadline, sig), "InvalidSignature()", "replay:");

    await f.vault.connect(f.owner).requestWithdraw(id, E18, f.thief.address);
    const first = (await f.vault.positionOf(id)).pending.readyAt;
    const cancelFirst = await f.sign(f.owner, "CancelPending", { id, readyAt: first, nonce: 0, deadline });
    // The owner cancels directly and a new request follows: the old signature must not cancel it.
    await f.vault.connect(f.owner).cancelPending(id);
    await increase(10);
    await f.vault.connect(f.owner).requestWithdraw(id, E18, f.owner.address);
    await expectRevert(f.vault.connect(f.relayer).cancelPendingWithSig(id, deadline, cancelFirst), "InvalidSignature()");
    const second = (await f.vault.positionOf(id)).pending.readyAt;
    await f.vault
      .connect(f.relayer)
      .cancelPendingWithSig(id, deadline, await f.sign(f.owner, "CancelPending", { id, readyAt: second, nonce: 0, deadline }));
    assert.equal((await f.vault.positionOf(id)).pending.kind, 0);
    await expectRevert(f.vault.cancelPendingWithSig(id, deadline, cancelFirst), "NothingPending()");
  });

  it("a contract payee is never locked by the hold: anyone can pay it, held share or later-held retry", async () => {
    const f = await loadFixture(deployFixture);
    // A contract that can neither sign (ERC-1271 returns a wrong value) nor make calls: a splitter, a vesting contract.
    const mute = await (await ethers.getContractFactory("MockERC1271WrongValue")).deploy();
    await f.vault
      .connect(f.owner)
      .open(f.token.address, E18.mul(10), config(7, 180, [f.alice.address, mute.address], [5000, 5000], 2), NO_VETO, MAX_FEE);
    // A failed withdrawal owed to the same contract, made while open...
    await f.vault.connect(f.owner).requestWithdraw(1, E18.mul(4), mute.address);
    await f.token.setBlocked(mute.address, true);
    await increase(7 * DAY);
    await f.vault.executePending(1);
    await f.token.setBlocked(mute.address, false);
    // ...and its held release share afterwards.
    await increase(181 * DAY);
    await f.vault.executeFallback(1);
    assert.equal((await f.vault.owed(1, mute.address)).toString(), E18.mul(7).toString());
    await f.vault.connect(f.relayer).claimOwed(1, mute.address);
    assert.equal((await f.token.balanceOf(mute.address)).toString(), E18.mul(7).toString());
  });

  it("10 beneficiaries, all held, odd total and fee: exact split, remainder to the last, books balance", async () => {
    const f = await loadFixture(deployFixture);
    await f.vault.connect(f.admin).setFee(50);
    const bens = Array.from({ length: 10 }, () => ethers.Wallet.createRandom());
    const shares = [1, 1, 1, 1, 1, 1, 1, 1, 1, 9991];
    await expectRevert(
      f.vault.connect(f.owner).open(f.token.address, 1003, config(7, 180, bens.map((b) => b.address), shares, 0x7ff), NO_VETO, MAX_FEE),
      "InvalidBeneficiaries()",
      "bit 10 set:"
    );
    await f.vault.connect(f.owner).open(f.token.address, 1003, config(7, 180, bens.map((b) => b.address), shares, 0x3ff), NO_VETO, MAX_FEE);
    await increase(181 * DAY);
    await f.vault.executeFallback(1);
    const fee = await f.vault.feesAccrued(f.token.address);
    assert.equal(fee.toNumber(), Math.floor((1003 * 50) / 10000));
    let sum = ethers.BigNumber.from(0);
    for (const b of bens) sum = sum.add(await f.vault.owed(1, b.address));
    assert.equal(sum.add(fee).toString(), "1003");
    assert.equal((await f.vault.owed(1, bens[0].address)).toNumber(), 0, "tiny shares round to 0 and are skipped");
    assert.equal((await f.vault.owed(1, bens[9].address)).toNumber(), 1003 - fee.toNumber());
  });

  it("a third party cannot consume a signer's nonce without a valid signature", async () => {
    const f = await loadFixture(deployFixture);
    await f.vault.connect(f.owner).open(f.token.address, E18, config(7), NO_VETO, MAX_FEE);
    const deadline = await deadlineIn(3600);
    await expectRevert(
      f.vault.connect(f.thief).checkInWithSig(1, deadline, await f.sign(f.thief, "CheckIn", { id: 1, nonce: 0, deadline })),
      "InvalidSignature()"
    );
    assert.equal((await f.vault.nonces(f.owner.address, 0)).toNumber(), 0);
  });

  it("smart-wallet owners (ERC-1271) sign too, and malformed verifiers never pass", async () => {
    const f = await loadFixture(deployFixture);
    /** Opens a position owned by the contract at `address` (impersonated, as its own wallet would). */
    const openAs = async (address: string) => {
      await ethers.provider.send("hardhat_impersonateAccount", [address]);
      await ethers.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
      const as = await ethers.getSigner(address);
      await f.token.mint(address, E18);
      await f.token.connect(as).approve(f.vault.address, E18);
      await f.vault.connect(as).open(f.token.address, E18, config(7), NO_VETO, MAX_FEE);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [address]);
      return (await f.vault.positionCount()).toNumber();
    };
    const good = await (await ethers.getContractFactory("MockERC1271Wallet")).deploy(f.alice.address);
    const id = await openAs(good.address);
    await increase(50 * DAY);
    const deadline = await deadlineIn(3600);
    await f.vault.connect(f.relayer).checkInWithSig(id, deadline, await f.sign(f.alice, "CheckIn", { id, nonce: 0, deadline }));
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    assert.equal((await f.vault.positionOf(id)).lastActivity.toNumber(), now);

    for (const name of ["MockERC1271MagicRevert", "MockERC1271WrongValue", "MockERC1271ShortReturn"]) {
      const bad = await (await ethers.getContractFactory(name)).deploy();
      const badId = await openAs(bad.address);
      const sig = await f.sign(f.alice, "CheckIn", { id: badId, nonce: 0, deadline });
      await expectRevert(f.vault.connect(f.relayer).checkInWithSig(badId, deadline, sig), "InvalidSignature()", `${name}:`);
    }
  });

  // ───────────── admin has no reach into positions ─────────────

  it("ownership is two-step and the admin surface is curation and the future fee only", async () => {
    const f = await loadFixture(deployFixture);
    await f.vault.connect(f.admin).transferOwnership(f.carol.address);
    assert.equal(await f.vault.owner(), f.admin.address, "not until accepted");
    await f.vault.connect(f.carol).acceptOwnership();
    assert.equal(await f.vault.owner(), f.carol.address);
    const adminFns = f.vault.interface.fragments
      .filter((x: any) => x.type === "function" && !["view", "pure"].includes(x.stateMutability))
      .map((x: any) => x.name)
      .sort();
    assert.deepEqual(adminFns, [
      "acceptOwnership",
      "cancelPending",
      "cancelPendingWithSig",
      "checkIn",
      "checkInWithSig",
      "claimOwed",
      "claimOwedWithSig",
      "collectFees",
      "deposit",
      "executeFallback",
      "executePending",
      "open",
      "renounceOwnership",
      "requestChange",
      "requestWithdraw",
      "setDepositsPaused",
      "setFee",
      "setFeeRecipient",
      "setTokenSupported",
      "transferOwnership",
      "veto",
    ]);
    for (const fn of ["setFee", "setFeeRecipient", "setDepositsPaused", "setTokenSupported"]) {
      const args = fn === "setFee" ? [1] : fn === "setFeeRecipient" ? [f.thief.address] : fn === "setDepositsPaused" ? [true] : [f.token.address, false];
      await expectRevert((f.vault.connect(f.thief) as any)[fn](...args), "OwnableUnauthorizedAccount(address)", `${fn} by a stranger:`);
    }
  });

  // ───────────── property: accounting never drifts ─────────────

  it("property: over random operation sequences the vault always holds balances plus owed plus fees", async () => {
    const f = await loadFixture(deployFixture);
    await f.vault.connect(f.admin).setFee(25);
    let seed = 0xc0ffee;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const owners = [f.owner, f.alice, f.bob];
    const secrets = new Map<number, { secret: string; to: string }>();
    const ids: number[] = [];

    const payees = [...owners.map((o) => o.address), f.carol.address, f.recovery.address];
    for (let step = 0; step < 80; step++) {
      const op = rnd(12);
      try {
        // Awkward-token and third-party moves the review asked to cover.
        if (op === 8) await f.token.setFeeBps(rnd(2) ? 0 : 50);
        if (op === 9) await f.token.setBlocked(payees[rnd(payees.length)], rnd(2) === 0);
        if (op === 10 && ids.length) await f.vault.connect(f.thief).deposit(ids[rnd(ids.length)], 1 + rnd(1000));
        if (op === 11 && ids.length) {
          if (rnd(3) === 0) await f.vault.collectFees(f.token.address);
          else await f.vault.claimOwed(ids[rnd(ids.length)], payees[rnd(payees.length)]);
        }
        if (op >= 8) throw new Error("done");
        if (op === 0 || ids.length === 0) {
          const o = owners[rnd(owners.length)];
          const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
          const index = await commit(f, o, secret, f.recovery.address);
          const bens = owners.filter((x) => x !== o).map((x) => x.address);
          await f.vault.connect(o).open(f.token.address, E18.mul(1 + rnd(20)), config([7, 30, 90][rnd(3)], 180, bens, [5000, 5000]), index, MAX_FEE);
          const id = (await f.vault.positionCount()).toNumber();
          ids.push(id);
          secrets.set(id, { secret, to: f.recovery.address });
        } else {
          const id = ids[rnd(ids.length)];
          const p = await f.vault.positionOf(id);
          const o = owners.find((x) => x.address === p.owner)!;
          if (op === 1) await f.vault.connect(o).deposit(id, E18.mul(1 + rnd(5)));
          if (op === 2 && p.balance.gt(0)) {
            const amount = rnd(4) === 0 ? await f.vault.ALL() : p.balance.div(1 + rnd(3)).add(1);
            await f.vault.connect(o).requestWithdraw(id, amount, f.carol.address);
          }
          if (op === 3) await f.vault.executePending(id);
          if (op === 4) {
            if (rnd(2)) await f.vault.connect(o).cancelPending(id);
            else await f.vault.connect(o).requestChange(id, config([7, 30, 90][rnd(3)], 180, owners.filter((x) => x !== o).map((x) => x.address), [5000, 5000]), NO_VETO);
          }
          if (op === 5) await f.vault.veto(id, secrets.get(id)!.secret, secrets.get(id)!.to);
          if (op === 6) await f.vault.executeFallback(id);
          if (op === 7) await increase((1 + rnd(120)) * DAY);
        }
      } catch {
        // Invalid moves revert; the invariant must hold either way.
      }
      let expected = await f.vault.feesAccrued(f.token.address);
      for (const id of ids) {
        const p = await f.vault.positionOf(id);
        expected = expected.add(p.balance);
        for (const who of payees) expected = expected.add(await f.vault.owed(id, who));
      }
      assert.equal((await f.token.balanceOf(f.vault.address)).toString(), expected.toString(), `step ${step}: accounting drift`);
    }
  }).timeout(900000);
});

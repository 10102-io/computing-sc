import { strict as assert } from "node:assert";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { increase } from "./utils/time";

// Branch coverage for ShieldVault (docs/security/tooling-report.md). The
// 2026-09-29 coverage run of ShieldVault.spec.ts left these paths dark:
// every guard that only a malformed call reaches, the reentrancy branch of
// each `nonReentrant` function, `domainSeparator`, and the `_isHeld` miss.
// Each block here lights one of them and pins what the guard protects.

const DAY = 86400;
const NO_VETO = ethers.constants.MaxUint256;
const SCHEME_HASH_PREIMAGE = 5;
const E18 = ethers.constants.WeiPerEther;
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

const CLAIM_TYPES = {
  ClaimOwed: [
    { name: "id", type: "uint256" },
    { name: "beneficiary", type: "address" },
    { name: "to", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

describe("ShieldVault: branch coverage", function () {
  this.timeout(180000);

  async function deployFixture() {
    const [admin, owner, alice, bob, thief, relayer, recovery, carol, treasury] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("QuantumRecoveryRegistry")).deploy();
    const token = await (await ethers.getContractFactory("MockAwkwardERC20")).deploy();
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
    const vetoDigest = (owner: string, secret: string, to: string) =>
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", "uint256", "address", "address", "bytes32", "address"],
          [ethers.utils.id("10102.ShieldVault.veto.v2"), chainId, vault.address, owner, secret, to]
        )
      );
    const domain = { name: "10102 ShieldVault", version: "2", chainId, verifyingContract: vault.address };
    return { admin, owner, alice, bob, thief, relayer, recovery, carol, treasury, registry, token, vault, vetoDigest, domain, chainId };
  }

  const deadlineIn = async (seconds: number) => (await ethers.provider.getBlock("latest")).timestamp + seconds;

  async function openWithVeto(f: any, amount = E18.mul(10)) {
    const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const index = (await f.registry.commitmentCount(f.owner.address)).toNumber();
    await f.registry.connect(f.owner).register(f.vetoDigest(f.owner.address, secret, f.recovery.address), SCHEME_HASH_PREIMAGE, f.vault.address);
    await f.vault.connect(f.owner).open(f.token.address, amount, config(30, 365, [f.alice.address, f.bob.address], [6000, 4000]), index, MAX_FEE);
    return { id: (await f.vault.positionCount()).toNumber(), secret };
  }

  // ───────────── constructor and admin setters ─────────────

  it("the constructor refuses a zero registry and the setters refuse zero or self addresses", async () => {
    const f = await loadFixture(deployFixture);
    const Vault = await ethers.getContractFactory("ShieldVault");
    await expectRevert(
      Vault.deploy(ethers.constants.AddressZero, f.admin.address, [f.token.address], f.treasury.address, 0),
      "InvalidAddress()",
      "zero registry:"
    );
    await expectRevert(
      Vault.deploy(f.registry.address, f.admin.address, [ethers.constants.AddressZero], f.treasury.address, 0),
      "InvalidAddress()",
      "zero token in the initial list:"
    );
    await expectRevert(
      Vault.deploy(f.registry.address, f.admin.address, [f.token.address], ethers.constants.AddressZero, 0),
      "InvalidAddress()",
      "zero fee recipient:"
    );
    await expectRevert(
      Vault.deploy(f.registry.address, f.admin.address, [f.token.address], f.treasury.address, 51),
      "FeeTooHigh()",
      "fee above the cap at construction:"
    );
    // The vault's own address is known before deployment (CREATE is deterministic), so the
    // constructor's self check is reachable: a deployer naming the vault as its fee recipient.
    const nonce = await ethers.provider.getTransactionCount(f.admin.address);
    const predicted = ethers.utils.getContractAddress({ from: f.admin.address, nonce });
    await expectRevert(
      Vault.connect(f.admin).deploy(f.registry.address, f.admin.address, [f.token.address], predicted, 0),
      "InvalidAddress()",
      "vault as its own fee recipient:"
    );

    await expectRevert(f.vault.connect(f.admin).setTokenSupported(ethers.constants.AddressZero, true), "InvalidAddress()");
    await expectRevert(f.vault.connect(f.admin).setFeeRecipient(ethers.constants.AddressZero), "InvalidAddress()");
    await expectRevert(f.vault.connect(f.admin).setFeeRecipient(f.vault.address), "InvalidAddress()", "fees must leave the vault:");
    assert.equal(await f.vault.feeRecipient(), f.treasury.address, "a refused setter changes nothing");
  });

  it("domainSeparator is the EIP-712 domain of the deployed vault on this chain", async () => {
    const f = await loadFixture(deployFixture);
    assert.equal(await f.vault.domainSeparator(), ethers.utils._TypedDataEncoder.hashDomain(f.domain));
  });

  // ───────────── guards only a malformed call reaches ─────────────

  it("unknown ids revert everywhere, including the view", async () => {
    const f = await loadFixture(deployFixture);
    await expectRevert(f.vault.positionOf(1), "UnknownPosition()", "view:");
    await expectRevert(f.vault.connect(f.owner).deposit(1, E18), "UnknownPosition()", "deposit:");
    await expectRevert(f.vault.connect(f.owner).checkIn(1), "UnknownPosition()", "checkIn:");
    await expectRevert(f.vault.executePending(1), "UnknownPosition()", "executePending:");
    await expectRevert(f.vault.veto(1, ethers.constants.HashZero, f.recovery.address), "UnknownPosition()", "veto:");
    await expectRevert(f.vault.executeFallback(1), "UnknownPosition()", "executeFallback:");
    assert.equal((await f.vault.fallbackAvailableAt(1)).toNumber(), 0, "the availability view is the one lenient read");
  });

  it("zero amounts are refused at open, deposit and request; a transfer that delivers nothing is refused too", async () => {
    const f = await loadFixture(deployFixture);
    await expectRevert(f.vault.connect(f.owner).open(f.token.address, 0, config(7), NO_VETO, MAX_FEE), "ZeroAmount()", "open:");
    const { id } = await openWithVeto(f);
    await expectRevert(f.vault.connect(f.owner).deposit(id, 0), "ZeroAmount()", "deposit:");
    await expectRevert(f.vault.connect(f.owner).requestWithdraw(id, 0, f.owner.address), "ZeroAmount()", "request:");
    // A token that burns the whole transfer: the vault credits only what arrived, which is nothing.
    await f.token.setFeeBps(10_000);
    await expectRevert(f.vault.connect(f.owner).deposit(id, E18), "NothingReceived()");
    await f.token.setFeeBps(0);
    assert.equal((await f.vault.positionOf(id)).balance.toString(), E18.mul(10).toString(), "nothing credited");
  });

  it("a direct cancel with nothing pending reverts and is not activity", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await openWithVeto(f);
    await expectRevert(f.vault.connect(f.owner).cancelPending(id), "NothingPending()");
    const before = (await f.vault.positionOf(id)).lastActivity;
    await increase(1);
    await expectRevert(f.vault.connect(f.owner).cancelPending(id), "NothingPending()");
    assert.equal((await f.vault.positionOf(id)).lastActivity.toString(), before.toString(), "a refused cancel is not activity");
  });

  it("a config whose beneficiary and share lists differ in length is refused", async () => {
    const f = await loadFixture(deployFixture);
    await expectRevert(
      f.vault.connect(f.owner).open(f.token.address, E18, config(7, 365, [f.alice.address, f.bob.address], [10000]), NO_VETO, MAX_FEE),
      "InvalidBeneficiaries()",
      "more people than shares:"
    );
    await expectRevert(
      f.vault.connect(f.owner).open(f.token.address, E18, config(7, 365, [f.alice.address], [5000, 5000]), NO_VETO, MAX_FEE),
      "InvalidBeneficiaries()",
      "more shares than people:"
    );
    await expectRevert(
      f.vault.connect(f.owner).open(f.token.address, E18, config(7, 0, [], [10000]), NO_VETO, MAX_FEE),
      "InvalidBeneficiaries()",
      "shares without people and without a fallback:"
    );
  });

  it("the veto refuses the vault as the recovery wallet before it looks at the secret", async () => {
    const f = await loadFixture(deployFixture);
    const { id, secret } = await openWithVeto(f);
    await expectRevert(f.vault.veto(id, secret, f.vault.address), "InvalidAddress()");
    assert.equal((await f.vault.positionOf(id)).closed, false, "the position is untouched");
  });

  it("a signed claim refuses the zero address and the vault as destination before consuming the nonce", async () => {
    const f = await loadFixture(deployFixture);
    const paper = ethers.Wallet.createRandom();
    await f.vault
      .connect(f.owner)
      .open(f.token.address, E18.mul(10), config(30, 365, [f.alice.address, paper.address], [5000, 5000], 2), NO_VETO, MAX_FEE);
    await increase(366 * DAY);
    await f.vault.executeFallback(1);
    const deadline = await deadlineIn(3600);
    const sign = (to: string) =>
      paper._signTypedData(f.domain, CLAIM_TYPES, { id: 1, beneficiary: paper.address, to, nonce: 0, deadline });
    await expectRevert(
      f.vault.claimOwedWithSig(1, paper.address, ethers.constants.AddressZero, deadline, await sign(ethers.constants.AddressZero)),
      "InvalidAddress()",
      "zero destination:"
    );
    await expectRevert(
      f.vault.claimOwedWithSig(1, paper.address, f.vault.address, deadline, await sign(f.vault.address)),
      "InvalidAddress()",
      "vault as destination:"
    );
    assert.equal((await f.vault.nonces(paper.address, 2)).toNumber(), 0, "nonce untouched by a refused destination");
    assert.equal((await f.vault.owed(1, paper.address)).toString(), E18.mul(5).toString());
  });

  // ───────────── _isHeld: a payee that is owed but not a held beneficiary ─────────────

  it("the hold gate applies to held beneficiaries only: a position with a hold mask still lets anyone pay an owed outsider", async () => {
    const f = await loadFixture(deployFixture);
    const paper = ethers.Wallet.createRandom();
    // bob is held (bit 1); carol is nobody's beneficiary but will be owed a failed withdrawal.
    await f.vault
      .connect(f.owner)
      .open(f.token.address, E18.mul(10), config(7, 365, [f.alice.address, paper.address], [5000, 5000], 2), NO_VETO, MAX_FEE);
    await f.vault.connect(f.owner).requestWithdraw(1, E18.mul(2), f.carol.address);
    await f.token.setBlocked(f.carol.address, true);
    await increase(7 * DAY);
    await f.vault.executePending(1);
    assert.equal((await f.vault.owed(1, f.carol.address)).toString(), E18.mul(2).toString());
    await f.token.setBlocked(f.carol.address, false);
    // The relayer pays carol: she is owed, has no code, and the mask does not name her.
    await f.vault.connect(f.relayer).claimOwed(1, f.carol.address);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(2).toString());
    // alice (bit 0 clear) is also pushable by anyone after a failed release...
    await f.token.setBlocked(f.alice.address, true);
    await increase(366 * DAY);
    await f.vault.executeFallback(1);
    await f.token.setBlocked(f.alice.address, false);
    await f.vault.connect(f.relayer).claimOwed(1, f.alice.address);
    // ...while the paper key's share waits for the paper key.
    await expectRevert(f.vault.connect(f.relayer).claimOwed(1, paper.address), "ShareIsHeld()");
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), E18.mul(4).toString());
  });

  // ───────────── reentrancy: a token with callbacks cannot re-enter a guarded function ─────────────

  it("a token with transfer hooks cannot re-enter any guarded function, and the vault credits only what arrived", async () => {
    const [admin, owner, alice, treasury, recovery] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("QuantumRecoveryRegistry")).deploy();
    const token = await (await ethers.getContractFactory("MockReentrantShieldToken")).deploy();
    const vault = await (await ethers.getContractFactory("ShieldVault")).deploy(registry.address, admin.address, [token.address], treasury.address, 25);
    await token.mint(owner.address, E18.mul(1000));
    await token.connect(owner).approve(vault.address, ethers.constants.MaxUint256);
    await vault.connect(owner).open(token.address, E18.mul(10), config(7, 365, [alice.address], [10000]), NO_VETO, MAX_FEE);
    await vault.connect(owner).requestWithdraw(1, E18, owner.address);
    await increase(7 * DAY);

    const iface = vault.interface;
    const attempts: Array<[string, string]> = [
      ["open", iface.encodeFunctionData("open", [token.address, 1, config(7), NO_VETO, MAX_FEE])],
      ["deposit", iface.encodeFunctionData("deposit", [1, 1])],
      ["executePending", iface.encodeFunctionData("executePending", [1])],
      ["veto", iface.encodeFunctionData("veto", [1, ethers.constants.HashZero, recovery.address])],
      ["executeFallback", iface.encodeFunctionData("executeFallback", [1])],
      ["claimOwed", iface.encodeFunctionData("claimOwed", [1, alice.address])],
      ["claimOwedWithSig", iface.encodeFunctionData("claimOwedWithSig", [1, alice.address, alice.address, 0, "0x"])],
      ["collectFees", iface.encodeFunctionData("collectFees", [token.address])],
    ];
    const guardSelector = ethers.utils.id("ReentrancyGuardReentrantCall()").slice(0, 10);
    for (const [name, data] of attempts) {
      await token.armOnce(vault.address, data);
      // The hook fires inside `_pull` of this deposit, while the guard is held.
      await vault.connect(owner).deposit(1, E18);
      assert.equal((await token.reentrySucceeded()).toNumber(), 0, `${name} re-entered`);
      assert.equal((await token.lastRevertData()).slice(0, 10), guardSelector, `${name}: refused by the guard, not by a later check`);
    }
    assert.equal((await token.attempts()).toNumber(), attempts.length);
    const p = await vault.positionOf(1);
    assert.equal(p.balance.toString(), E18.mul(10 + attempts.length).toString(), "every deposit credited exactly once");
    assert.equal(p.pending.kind, 1, "the pending withdrawal survived every attempt");
    assert.equal((await token.balanceOf(vault.address)).toString(), p.balance.toString());

    // A hook that pays a legitimate, unguarded call does nothing worse: the owner-only functions reject the token.
    await token.armOnce(vault.address, iface.encodeFunctionData("checkIn", [1]));
    const before = (await vault.positionOf(1)).lastActivity;
    await increase(1);
    await token.mint(alice.address, E18);
    await token.connect(alice).approve(vault.address, E18);
    await vault.connect(alice).deposit(1, E18);
    assert.equal((await token.reentrySucceeded()).toNumber(), 0, "the token is not the owner");
    assert.equal((await vault.positionOf(1)).lastActivity.toString(), before.toString(), "a stranger's hooked deposit is not activity");

    // The outgoing path: a hook on the payout transfer cannot re-enter either, and the payout still lands.
    await token.armOnce(vault.address, iface.encodeFunctionData("executePending", [1]));
    await vault.executePending(1);
    assert.equal((await token.reentrySucceeded()).toNumber(), 0);
    assert.equal((await token.lastRevertData()).slice(0, 10), guardSelector);
    assert.equal((await vault.positionOf(1)).pending.kind, 0);
    assert.equal((await vault.feesAccrued(token.address)).toString(), E18.mul(25).div(10000).toString());
  });
});

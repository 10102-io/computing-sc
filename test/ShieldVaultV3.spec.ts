import { strict as assert } from "node:assert";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { increase } from "./utils/time";

// ShieldVault v3 (docs/plans/shield-vault.md "v3"): what it does differently
// from v2. The shared behaviour runs against both versions in
// ShieldVault.spec.ts and ShieldVault.branches.spec.ts.

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

/** Names of the events a transaction emitted from `vault`. */
async function eventsOf(tx: any, vault: any): Promise<string[]> {
  const receipt = await tx.wait();
  return receipt.logs
    .filter((l: any) => l.address === vault.address)
    .map((l: any) => vault.interface.parseLog(l).name);
}

describe("ShieldVaultV3: fee on releases only, truthful payouts, token refused as payee", function () {
  this.timeout(180000);

  async function deploy(contract: "ShieldVault" | "ShieldVaultV3", tokenName: "MockAwkwardERC20" | "MockLyingERC20" | "MockWeirdERC20", feeBps: number) {
    const [admin, owner, alice, bob, thief, relayer, recovery, carol, treasury] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("QuantumRecoveryRegistry")).deploy();
    const token = await (await ethers.getContractFactory(tokenName)).deploy();
    const vault = await (await ethers.getContractFactory(contract)).deploy(registry.address, admin.address, [token.address], treasury.address, feeBps);
    for (const s of [owner, alice, bob, thief]) {
      await token.mint(s.address, E18.mul(1000));
      await token.connect(s).approve(vault.address, ethers.constants.MaxUint256);
    }
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const vetoDigest = (o: string, secret: string, to: string) =>
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", "uint256", "address", "address", "bytes32", "address"],
          [ethers.utils.id("10102.ShieldVault.veto.v2"), chainId, vault.address, o, secret, to]
        )
      );
    const domain = { name: "10102 ShieldVault", version: "2", chainId, verifyingContract: vault.address };
    const commit = async (signer: any, secret: string, to: string) => {
      const index = (await registry.commitmentCount(signer.address)).toNumber();
      await registry.connect(signer).register(vetoDigest(signer.address, secret, to), SCHEME_HASH_PREIMAGE, vault.address);
      return index;
    };
    return { admin, owner, alice, bob, thief, relayer, recovery, carol, treasury, registry, token, vault, domain, commit };
  }

  const v3Awkward = () => deploy("ShieldVaultV3", "MockAwkwardERC20", 50);
  const v3Lying = () => deploy("ShieldVaultV3", "MockLyingERC20", 25);
  const v2Lying = () => deploy("ShieldVault", "MockLyingERC20", 25);
  const v3Weird = () => deploy("ShieldVaultV3", "MockWeirdERC20", 50);

  const deadlineIn = async (seconds: number) => (await ethers.provider.getBlock("latest")).timestamp + seconds;
  const lastId = async (f: any) => (await f.vault.positionCount()).toNumber();

  // ───────────── 1. the fee ─────────────

  it("the owner's own exits are free: withdrawal, ALL, change, cancel and veto charge nothing", async () => {
    const f = await loadFixture(v3Awkward);
    const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const index = await f.commit(f.owner, secret, f.recovery.address);
    await f.vault.connect(f.owner).open(f.token.address, E18.mul(10), config(30, 365, [f.alice.address], [10000]), index, MAX_FEE);
    const id = await lastId(f);
    assert.equal((await f.vault.positionOf(id)).feeBps, 50);

    await f.vault.connect(f.owner).requestWithdraw(id, E18.mul(3), f.carol.address);
    await increase(30 * DAY);
    const w = await f.vault.connect(f.relayer).executePending(id);
    assert.deepEqual(await eventsOf(w, f.vault), ["Withdrawn"], "no FeeCharged on a withdrawal");
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(3).toString(), "the payee receives the whole amount");

    await f.vault.connect(f.owner).requestChange(id, config(7, 180, [f.bob.address], [10000]), index);
    await increase(30 * DAY);
    await f.vault.executePending(id);
    await f.vault.connect(f.owner).requestWithdraw(id, E18, f.carol.address);
    await f.vault.connect(f.owner).cancelPending(id);
    assert.equal((await f.vault.feesAccrued(f.token.address)).toString(), "0", "a change or a cancel costs nothing");

    // A stranger's dust is part of an ALL withdrawal, free as well.
    await f.vault.connect(f.thief).deposit(id, 1);
    await f.vault.connect(f.owner).requestWithdraw(id, await f.vault.ALL(), f.carol.address);
    await increase(7 * DAY);
    await f.vault.executePending(id);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(10).add(1).toString());
    assert.equal((await f.vault.positionOf(id)).closed, true);

    const s2 = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    await f.vault.connect(f.owner).open(f.token.address, E18.mul(5), config(7), await f.commit(f.owner, s2, f.recovery.address), MAX_FEE);
    const veto = await f.vault.veto(await lastId(f), s2, f.recovery.address);
    assert.deepEqual(await eventsOf(veto, f.vault), ["Vetoed"]);
    assert.equal((await f.token.balanceOf(f.recovery.address)).toString(), E18.mul(5).toString());
    assert.equal((await f.vault.feesAccrued(f.token.address)).toString(), "0");
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), "0", "nothing kept back");
  });

  it("the release to the named people pays the fee once; held and failed shares are claimed net, never charged again", async () => {
    const f = await loadFixture(v3Awkward);
    const paper = ethers.Wallet.createRandom();
    await f.vault
      .connect(f.owner)
      .open(f.token.address, E18.mul(8), config(7, 180, [f.alice.address, paper.address, f.bob.address], [4000, 3000, 3000], 2), NO_VETO, MAX_FEE);
    const id = await lastId(f);
    await f.vault.connect(f.admin).setFee(0); // a later rate never reaches the position
    await f.token.setBlocked(f.bob.address, true);
    await increase(181 * DAY);
    const tx = await f.vault.connect(f.relayer).executeFallback(id);
    const names = await eventsOf(tx, f.vault);
    assert.equal(names.filter((n) => n === "FeeCharged").length, 1, "one fee per release");
    const fee = E18.mul(8).mul(50).div(10000);
    const net = E18.mul(8).sub(fee);
    assert.equal((await f.vault.feesAccrued(f.token.address)).toString(), fee.toString());
    assert.equal((await f.token.balanceOf(f.alice.address)).sub(E18.mul(1000)).toString(), net.mul(4000).div(10000).toString());
    const held = await f.vault.owed(id, paper.address);
    const failed = await f.vault.owed(id, f.bob.address);
    assert.equal(held.toString(), net.mul(3000).div(10000).toString());
    assert.equal(failed.toString(), net.sub(net.mul(4000).div(10000)).sub(held).toString(), "the last share takes the remainder");

    const deadline = await deadlineIn(3600);
    const sig = await paper._signTypedData(f.domain, CLAIM_TYPES, { id, beneficiary: paper.address, to: f.carol.address, nonce: 0, deadline });
    const c1 = await f.vault.connect(f.relayer).claimOwedWithSig(id, paper.address, f.carol.address, deadline, sig);
    assert.deepEqual(await eventsOf(c1, f.vault), ["OwedClaimed"]);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), held.toString(), "the held share arrives whole");
    await f.token.setBlocked(f.bob.address, false);
    const c2 = await f.vault.claimOwed(id, f.bob.address);
    assert.deepEqual(await eventsOf(c2, f.vault), ["OwedClaimed"]);
    assert.equal((await f.token.balanceOf(f.bob.address)).sub(E18.mul(1000)).toString(), failed.toString());

    assert.equal((await f.vault.feesAccrued(f.token.address)).toString(), fee.toString(), "claims took nothing");
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), fee.toString(), "the vault keeps exactly the release fee");
    await f.vault.collectFees(f.token.address);
    assert.equal((await f.token.balanceOf(f.treasury.address)).toString(), fee.toString());
  });

  // ───────────── 2. a token that reports failure after moving funds (SV-L1) ─────────────

  it("a token that moves the funds and returns false is paid once, on every exit", async () => {
    const f = await loadFixture(v3Lying);
    const open = async (cfg: any, index = NO_VETO) => {
      await f.vault.connect(f.owner).open(f.token.address, E18.mul(10), cfg, index, MAX_FEE);
      return lastId(f);
    };
    const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const a = await open(config(7));
    const b = await open(config(7, 180, [f.alice.address, f.bob.address], [5000, 5000]));
    const c = await open(config(7), await f.commit(f.owner, secret, f.recovery.address));
    await f.vault.connect(f.owner).requestWithdraw(a, await f.vault.ALL(), f.carol.address);
    await increase(181 * DAY);
    await f.token.setLie(true, 10_000);

    const w = await f.vault.executePending(a);
    assert.deepEqual(await eventsOf(w, f.vault), ["Withdrawn"], "nothing recorded as owed");
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(10).toString());
    await f.vault.executeFallback(b);
    await f.vault.veto(c, secret, f.recovery.address);
    const fee = E18.mul(10).mul(25).div(10000);
    assert.equal((await f.token.balanceOf(f.alice.address)).sub(E18.mul(1000)).toString(), E18.mul(10).sub(fee).div(2).toString());
    assert.equal((await f.token.balanceOf(f.recovery.address)).toString(), E18.mul(10).toString());
    for (const [id, who] of [[a, f.carol], [b, f.alice], [b, f.bob], [c, f.recovery]] as const) {
      assert.equal((await f.vault.owed(id, who.address)).toString(), "0", `owed ${id}`);
    }
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), fee.toString(), "solvent: only the release fee is left");
  });

  it("a partial move leaves owed exactly what stayed in the vault; a move of nothing owes it all", async () => {
    const f = await loadFixture(v3Lying);
    const withdrawAll = async (moveBps: number) => {
      await f.vault.connect(f.owner).open(f.token.address, E18.mul(10), config(7), NO_VETO, MAX_FEE);
      const id = await lastId(f);
      await f.vault.connect(f.owner).requestWithdraw(id, await f.vault.ALL(), f.carol.address);
      await increase(7 * DAY);
      await f.token.setLie(true, moveBps);
      await f.vault.executePending(id);
      await f.token.setLie(false, 0);
      return id;
    };
    const partial = await withdrawAll(4000);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(4).toString());
    assert.equal((await f.vault.owed(partial, f.carol.address)).toString(), E18.mul(6).toString());
    const none = await withdrawAll(0);
    assert.equal((await f.vault.owed(none, f.carol.address)).toString(), E18.mul(10).toString());
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), E18.mul(16).toString(), "owed is backed exactly");
    await f.vault.claimOwed(partial, f.carol.address);
    await f.vault.claimOwed(none, f.carol.address);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(20).toString(), "each holding paid once, whole");
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), "0");
  });

  it("v2, for comparison: the same token is paid twice through owed, out of another holding", async () => {
    const f = await loadFixture(v2Lying);
    await f.vault.connect(f.owner).open(f.token.address, E18.mul(10), config(7), NO_VETO, MAX_FEE);
    await f.vault.connect(f.alice).open(f.token.address, E18.mul(10), config(7), NO_VETO, MAX_FEE);
    await f.vault.connect(f.owner).requestWithdraw(1, await f.vault.ALL(), f.carol.address);
    await increase(7 * DAY);
    await f.token.setLie(true, 10_000);
    await f.vault.executePending(1);
    await f.token.setLie(false, 0);
    const net = E18.mul(10).sub(E18.mul(10).mul(25).div(10000));
    assert.equal((await f.vault.owed(1, f.carol.address)).toString(), net.toString(), "v2 records a payout that left as owed");
    await f.vault.claimOwed(1, f.carol.address);
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), net.mul(2).toString(), "paid twice");
    const obligations = (await f.vault.positionOf(2)).balance.add(await f.vault.feesAccrued(f.token.address));
    assert((await f.token.balanceOf(f.vault.address)).lt(obligations), "the other holding is short");
  });

  // ───────────── 3. the token's own contract is not a payee ─────────────

  it("refuses the token contract as withdrawal address, beneficiary or claim destination", async () => {
    const f = await loadFixture(v3Awkward);
    const tok = f.token.address;
    await expectRevert(
      f.vault.connect(f.owner).open(tok, E18, config(7, 365, [f.alice.address, tok], [5000, 5000]), NO_VETO, MAX_FEE),
      "InvalidBeneficiaries()",
      "open:"
    );
    const paper = ethers.Wallet.createRandom();
    await f.vault.connect(f.owner).open(tok, E18.mul(10), config(7, 180, [paper.address], [10000], 1), NO_VETO, MAX_FEE);
    await expectRevert(f.vault.connect(f.owner).requestWithdraw(1, E18, tok), "InvalidAddress()", "withdraw:");
    await expectRevert(f.vault.connect(f.owner).requestChange(1, config(7, 180, [tok], [10000]), NO_VETO), "InvalidBeneficiaries()", "change:");
    const p = await f.vault.positionOf(1);
    assert.equal(p.pending.kind, 0, "nothing started");

    await increase(181 * DAY);
    await f.vault.executeFallback(1);
    const deadline = await deadlineIn(3600);
    const sig = await paper._signTypedData(f.domain, CLAIM_TYPES, { id: 1, beneficiary: paper.address, to: tok, nonce: 0, deadline });
    await expectRevert(f.vault.claimOwedWithSig(1, paper.address, tok, deadline, sig), "InvalidAddress()", "claim destination:");
    assert.equal((await f.vault.nonces(paper.address, 2)).toNumber(), 0, "nonce untouched");
    assert((await f.vault.owed(1, paper.address)).gt(0));
  });

  it("the veto is not checked against the token: a sheet committed to it still stops the holding", async () => {
    const f = await loadFixture(v3Awkward);
    const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const index = await f.commit(f.owner, secret, f.token.address);
    await f.vault.connect(f.owner).open(f.token.address, E18.mul(2), config(7), index, MAX_FEE);
    await f.vault.connect(f.owner).requestWithdraw(1, await f.vault.ALL(), f.thief.address);
    await f.vault.veto(1, secret, f.token.address);
    assert.equal((await f.vault.positionOf(1)).closed, true, "the stop never fails");
    assert.equal((await f.token.balanceOf(f.token.address)).toString(), E18.mul(2).toString());
  });

  // ───────────── 4. the app keeps one ABI and one signing domain ─────────────

  it("v3's ABI is v2's, so the app's generated ABI reads both; the signing domain is v2's", async () => {
    const v2 = await ethers.getContractFactory("ShieldVault");
    const v3 = await ethers.getContractFactory("ShieldVaultV3");
    const full = (i: any) => i.fragments.map((x: any) => x.format(ethers.utils.FormatTypes.full)).sort();
    assert.deepEqual(full(v3.interface), full(v2.interface));

    const f = await loadFixture(v3Awkward);
    const d = await f.vault.eip712Domain();
    assert.equal(d.name, "10102 ShieldVault");
    assert.equal(d.version, "2");
    assert.equal(d.verifyingContract, f.vault.address);

    const old = await v2.deploy(f.registry.address, f.admin.address, [f.token.address], f.treasury.address, 25);
    await f.token.connect(f.owner).approve(old.address, ethers.constants.MaxUint256);
    await old.connect(f.owner).open(f.token.address, E18, config(30), NO_VETO, MAX_FEE);
    const asV3 = new ethers.Contract(old.address, v3.interface, f.owner);
    const p = await asV3.positionOf(1);
    assert.equal(p.owner, f.owner.address);
    assert.equal(p.feeBps, 25);
  });

  // ───────────── 5. findings of the cross-model reviews (2026-11-09) ─────────────

  async function reverts(p: Promise<unknown>): Promise<boolean> {
    try {
      await p;
      return false;
    } catch {
      return true;
    }
  }

  it("collectFees refuses a fee recipient that is the token's own contract; the fees wait for a new recipient (review I-1)", async () => {
    const f = await loadFixture(v3Awkward);
    await f.vault.connect(f.owner).open(f.token.address, E18.mul(4), config(7, 180, [f.alice.address], [10000]), NO_VETO, MAX_FEE);
    await increase(181 * DAY);
    await f.vault.executeFallback(1);
    const fee = await f.vault.feesAccrued(f.token.address);
    assert(fee.gt(0));
    await f.vault.connect(f.admin).setFeeRecipient(f.token.address);
    await expectRevert(f.vault.collectFees(f.token.address), "InvalidAddress()");
    assert.equal((await f.vault.feesAccrued(f.token.address)).toString(), fee.toString(), "nothing moved");
    assert.equal((await f.token.balanceOf(f.token.address)).toString(), "0");
    await f.vault.connect(f.admin).setFeeRecipient(f.treasury.address);
    await f.vault.collectFees(f.token.address);
    assert.equal((await f.token.balanceOf(f.treasury.address)).toString(), fee.toString());
  });

  it("a token that debits more than the amount and returns false is not owed again; the extra debit is a shortfall the vault cannot see", async () => {
    const f = await loadFixture(v3Weird);
    await f.vault.connect(f.owner).open(f.token.address, E18.mul(10), config(7), NO_VETO, MAX_FEE);
    await f.vault.connect(f.alice).open(f.token.address, E18.mul(10), config(7), NO_VETO, MAX_FEE);
    await f.vault.connect(f.owner).requestWithdraw(1, await f.vault.ALL(), f.carol.address);
    await increase(7 * DAY);
    await f.token.setLie(true, 10_000, 1_000); // moves it all, takes 10% more from the vault, returns false
    const tx = await f.vault.executePending(1);
    assert.deepEqual(await eventsOf(tx, f.vault), ["Withdrawn"], "nothing recorded as owed");
    assert.equal((await f.vault.owed(1, f.carol.address)).toString(), "0", "not paid a second time");
    assert.equal((await f.token.balanceOf(f.carol.address)).toString(), E18.mul(10).toString());
    // As with such a token returning true: 11 left for a 10 payout, so the
    // other holding's 10 is backed by 9. The listing rule admits no such token.
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), E18.mul(9).toString());
    assert.equal((await f.vault.positionOf(2)).balance.toString(), E18.mul(10).toString());
  });

  it("a signature or a veto sheet made for v2 does not work on v3, and the reverse", async () => {
    const f = await loadFixture(v3Awkward);
    const v2 = await (await ethers.getContractFactory("ShieldVault")).deploy(f.registry.address, f.admin.address, [f.token.address], f.treasury.address, 25);
    await f.token.connect(f.owner).approve(v2.address, ethers.constants.MaxUint256);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const vaults: Record<string, any> = { v2, v3: f.vault };
    const domainOf = (v: any) => ({ name: "10102 ShieldVault", version: "2", chainId, verifyingContract: v.address });
    const CHECK_IN = { CheckIn: [{ name: "id", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
    const CANCEL = {
      CancelPending: [
        { name: "id", type: "uint256" },
        { name: "readyAt", type: "uint64" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const digestFor = (v: any, secret: string, to: string) =>
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", "uint256", "address", "address", "bytes32", "address"],
          [ethers.utils.id("10102.ShieldVault.veto.v2"), chainId, v.address, f.owner.address, secret, to]
        )
      );

    for (const [from, to] of [["v2", "v3"], ["v3", "v2"]]) {
      const target = vaults[to];
      const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
      // A sheet committed for the other vault, pinned on this one.
      const index = (await f.registry.commitmentCount(f.owner.address)).toNumber();
      await f.registry.connect(f.owner).register(digestFor(vaults[from], secret, f.recovery.address), SCHEME_HASH_PREIMAGE, vaults[from].address);
      await target.connect(f.owner).open(f.token.address, E18, config(7, 365, [f.alice.address], [10000]), index, MAX_FEE);
      const id = (await target.positionCount()).toNumber();
      const deadline = await deadlineIn(3600);
      const nonce = (p: number) => target.nonces(f.owner.address, p);

      const checkIn = await f.owner._signTypedData(domainOf(vaults[from]), CHECK_IN, { id, nonce: await nonce(0), deadline });
      await expectRevert(target.checkInWithSig(id, deadline, checkIn), "InvalidSignature()", `${from} check-in on ${to}:`);
      await target.connect(f.owner).requestWithdraw(id, E18, f.carol.address);
      const readyAt = (await target.positionOf(id)).pending.readyAt;
      const cancel = await f.owner._signTypedData(domainOf(vaults[from]), CANCEL, { id, readyAt, nonce: await nonce(1), deadline });
      await expectRevert(target.cancelPendingWithSig(id, deadline, cancel), "InvalidSignature()", `${from} cancel on ${to}:`);
      await expectRevert(target.veto(id, secret, f.recovery.address), "WrongSecret()", `${from} sheet on ${to}:`);
      assert.equal((await nonce(0)).toNumber() + (await nonce(1)).toNumber(), 0, "no nonce spent");
      assert.equal((await target.positionOf(id)).pending.kind, 1, "the withdrawal is still pending");

      // The same signatures made for this vault work.
      const own = await f.owner._signTypedData(domainOf(target), CANCEL, { id, readyAt, nonce: 0, deadline });
      await target.cancelPendingWithSig(id, deadline, own);
      assert.equal((await target.positionOf(id)).pending.kind, 0);
    }
  });

  it("a token that burns the gas of one payout leaves that share owed and pays the others; fees to such a recipient wait", async () => {
    const f = await loadFixture(v3Weird);
    await f.vault.connect(f.owner).open(f.token.address, E18.mul(10), config(7, 180, [f.alice.address, f.bob.address], [5000, 5000]), NO_VETO, MAX_FEE);
    await f.token.setGasBurner(f.bob.address);
    await increase(181 * DAY);
    const rc = await (await f.vault.executeFallback(1, { gasLimit: 10_000_000 })).wait();
    assert(rc.gasUsed.gt(9_000_000), `the payout burned its share of the gas (${rc.gasUsed})`);
    const net = E18.mul(10).sub(E18.mul(10).mul(50).div(10000));
    assert.equal((await f.token.balanceOf(f.alice.address)).sub(E18.mul(1000)).toString(), net.div(2).toString());
    assert.equal((await f.vault.owed(1, f.bob.address)).toString(), net.sub(net.div(2)).toString(), "bob's share is owed");

    await f.token.setGasBurner(f.treasury.address);
    const fee = await f.vault.feesAccrued(f.token.address);
    assert(await reverts(f.vault.collectFees(f.token.address, { gasLimit: 10_000_000 })), "the collection reverts");
    assert.equal((await f.vault.feesAccrued(f.token.address)).toString(), fee.toString(), "the fees wait");
    await f.token.setGasBurner(ethers.constants.AddressZero);
    await f.vault.claimOwed(1, f.bob.address);
    await f.vault.collectFees(f.token.address);
    assert.equal((await f.token.balanceOf(f.bob.address)).sub(E18.mul(1000)).toString(), net.sub(net.div(2)).toString());
    assert.equal((await f.token.balanceOf(f.vault.address)).toString(), "0");
  });
});

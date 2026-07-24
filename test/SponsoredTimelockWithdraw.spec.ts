import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { deployProxy } from "./utils/proxy";

// Create-flow v2 — gas-sponsored timelock withdrawal (create-flow-v2.md §12a,
// timelock leg). The recipient signs an EIP-712 WithdrawAuth off-chain; any
// relayer submits withdrawFor and pays the gas. Funds only ever go to the
// recovered signer (the timelock contracts enforce caller == lock.recipient),
// so the mechanism is permissionless. Mirrors SponsoredEOAClaims.spec.ts.

const NO_SWAP = { storageToken: ethers.constants.AddressZero, amountOutMin: 0, deadline: 0 };

const WITHDRAW_AUTH_TYPES = {
  WithdrawAuth: [
    { name: "recipient", type: "address" },
    { name: "timelockId", type: "uint256" },
    { name: "skipSwap", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

function revertedWith(err: any, signature: string): boolean {
  const selector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(signature)).slice(0, 10).toLowerCase();
  const blob = ((err?.message ?? "") + " " + JSON.stringify(err ?? "") + " " + (err?.data ?? "") + " " + (err?.error?.message ?? "")).toLowerCase();
  return blob.includes(signature.toLowerCase()) || blob.includes(selector);
}

describe("TimeLockRouter — sponsored withdraw (withdrawFor)", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [admin, user, recipient, relayer, attacker] = await ethers.getSigners();

    const router = await deployProxy("TimeLockRouter", [admin.address], "initialize", admin);
    const tlERC20 = await deployProxy("TimelockERC20", [admin.address, router.address], "initialize", admin);
    const tlERC721 = await deployProxy("TimelockERC721", [admin.address, router.address], "initialize", admin);
    const tlERC1155 = await deployProxy("TimelockERC1155", [admin.address, router.address], "initialize", admin);
    await router.connect(admin).setTimelock(tlERC20.address, tlERC721.address, tlERC1155.address);

    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    await usdt.mint(user.address, 1_000_000_000);
    await usdt.connect(user).approve(router.address, ethers.constants.MaxUint256);

    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "10102 Timelock Sponsored",
      version: "1",
      chainId: network.chainId,
      verifyingContract: router.address,
    };

    return { admin, user, recipient, relayer, attacker, router, tlERC20, usdt, domain };
  }

  function gift(erc20: { tokenAddress: string; amount: number }[], duration: number, recipient: string) {
    return {
      timelockETHSwap: NO_SWAP,
      timelockERC20: erc20,
      timelockERC721: [],
      timelockERC1155: [],
      duration,
      recipient,
      name: "tl",
      giftName: "for you",
    };
  }

  async function signWithdrawAuth(signer: any, domain: any, id: number, skipSwap: boolean, opts: any = {}) {
    const now = await currentTime();
    const auth = {
      recipient: opts.recipient ?? signer.address,
      timelockId: id,
      skipSwap,
      nonce: opts.nonce ?? 0,
      deadline: opts.deadline ?? now + 3600,
    };
    const signature = await (opts.signWith ?? signer)._signTypedData(domain, WITHDRAW_AUTH_TYPES, auth);
    return { recipient: auth.recipient, nonce: auth.nonce, deadline: auth.deadline, signature };
  }

  it("ERC-5267 eip712Domain matches the domain used off-chain", async function () {
    const { router, domain } = await loadFixture(deployFixture);
    const d = await router.eip712Domain();
    assert.equal(d.fields, "0x0f");
    assert.equal(d.name, domain.name);
    assert.equal(d.version, domain.version);
    assert.equal(d.chainId.toNumber(), domain.chainId);
    assert.equal(d.verifyingContract, router.address);
    assert.equal(
      await router.sponsoredDomainSeparator(),
      ethers.utils._TypedDataEncoder.hashDomain(domain)
    );
  });

  it("gift recipient withdraws gaslessly via a relayer; funds go to the recipient", async function () {
    const { user, recipient, relayer, router, usdt, domain } = await loadFixture(deployFixture);

    await router
      .connect(user)
      .createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 100_000_000 }], 86400, recipient.address));
    await increase(86400 + 1);

    const auth = await signWithdrawAuth(recipient, domain, 1, true);
    const tx = await router.connect(relayer).withdrawFor(1, true, auth);

    assert.equal((await usdt.balanceOf(recipient.address)).toString(), "100000000");
    assert.equal((await usdt.balanceOf(relayer.address)).toString(), "0");
    assert.equal((await router.sponsorNonce(recipient.address)).toNumber(), 1);

    const receipt = await tx.wait();
    const ev = receipt.events?.find((e: any) => e.event === "TimelockWithdrawnFor");
    assert(ev, "TimelockWithdrawnFor not emitted");
    assert.equal(ev.args.recipient, recipient.address);
    assert.equal(ev.args.relayer, relayer.address);
  });

  it("rejects a signature from someone other than the recipient", async function () {
    const { user, recipient, relayer, attacker, router, usdt, domain } = await loadFixture(deployFixture);

    await router
      .connect(user)
      .createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 1_000_000 }], 86400, recipient.address));
    await increase(86400 + 1);

    const auth = await signWithdrawAuth(recipient, domain, 1, true, { signWith: attacker });
    let caught: any;
    try {
      await router.connect(relayer).withdrawFor(1, true, auth);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected revert");
    assert(revertedWith(caught, "InvalidSponsorSignature()"), `got: ${caught?.message}`);
  });

  it("rejects relayer tampering with id / skipSwap; enforces deadline and nonce", async function () {
    const { user, recipient, relayer, router, usdt, domain } = await loadFixture(deployFixture);

    await router
      .connect(user)
      .createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 1_000_000 }], 86400, recipient.address));
    await increase(86400 + 1);

    // Signed for id 1 / skipSwap=true; relayer flips skipSwap.
    const auth = await signWithdrawAuth(recipient, domain, 1, true);
    let caught: any;
    try {
      await router.connect(relayer).withdrawFor(1, false, auth);
    } catch (e) {
      caught = e;
    }
    assert(caught && revertedWith(caught, "InvalidSponsorSignature()"), `tamper: ${caught?.message}`);

    // Expired deadline.
    const now = await currentTime();
    const expired = await signWithdrawAuth(recipient, domain, 1, true, { deadline: now - 1 });
    caught = undefined;
    try {
      await router.connect(relayer).withdrawFor(1, true, expired);
    } catch (e) {
      caught = e;
    }
    assert(caught && revertedWith(caught, "SponsorshipExpired()"), `deadline: ${caught?.message}`);

    // Wrong nonce.
    const wrongNonce = await signWithdrawAuth(recipient, domain, 1, true, { nonce: 5 });
    caught = undefined;
    try {
      await router.connect(relayer).withdrawFor(1, true, wrongNonce);
    } catch (e) {
      caught = e;
    }
    assert(caught && revertedWith(caught, "InvalidSponsorNonce()"), `nonce: ${caught?.message}`);
  });

  it("invalidateSponsorNonce kills an outstanding authorization", async function () {
    const { user, recipient, relayer, router, usdt, domain } = await loadFixture(deployFixture);

    await router
      .connect(user)
      .createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 1_000_000 }], 86400, recipient.address));
    await increase(86400 + 1);

    const auth = await signWithdrawAuth(recipient, domain, 1, true);
    await router.connect(recipient).invalidateSponsorNonce();

    let caught: any;
    try {
      await router.connect(relayer).withdrawFor(1, true, auth);
    } catch (e) {
      caught = e;
    }
    assert(caught && revertedWith(caught, "InvalidSponsorNonce()"), `got: ${caught?.message}`);

    // Re-sign with the advanced nonce — still works.
    const fresh = await signWithdrawAuth(recipient, domain, 1, true, { nonce: 1 });
    await router.connect(relayer).withdrawFor(1, true, fresh);
    assert.equal((await usdt.balanceOf(recipient.address)).toString(), "1000000");
  });

  it("a consumed authorization cannot be replayed", async function () {
    const { user, recipient, relayer, router, usdt, domain } = await loadFixture(deployFixture);

    // Two gifts to the same recipient (ids 1 and 2).
    await router
      .connect(user)
      .createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 1_000_000 }], 86400, recipient.address));
    await router
      .connect(user)
      .createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 2_000_000 }], 86400, recipient.address));
    await increase(86400 + 1);

    const auth = await signWithdrawAuth(recipient, domain, 1, true);
    await router.connect(relayer).withdrawFor(1, true, auth);

    let caught: any;
    try {
      await router.connect(relayer).withdrawFor(1, true, auth);
    } catch (e) {
      caught = e;
    }
    assert(caught && revertedWith(caught, "InvalidSponsorNonce()"), `got: ${caught?.message}`);
  });

  it("ERC-1271 smart-wallet recipient withdraws gaslessly (owner-key signature)", async function () {
    const { user, recipient, relayer, router, usdt, domain } = await loadFixture(deployFixture);

    const Wallet = await ethers.getContractFactory("MockERC1271Wallet");
    const scw = await Wallet.deploy(recipient.address);

    await router
      .connect(user)
      .createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 3_000_000 }], 86400, scw.address));
    await increase(86400 + 1);

    // The smart wallet is the recipient; its owner key signs the digest.
    const auth = await signWithdrawAuth(recipient, domain, 1, true, { recipient: scw.address });
    await router.connect(relayer).withdrawFor(1, true, auth);
    assert.equal((await usdt.balanceOf(scw.address)).toString(), "3000000");
  });

  it("rejects an ERC-1271 signature from a non-owner key", async function () {
    const { user, recipient, relayer, attacker, router, usdt, domain } = await loadFixture(deployFixture);

    const Wallet = await ethers.getContractFactory("MockERC1271Wallet");
    const scw = await Wallet.deploy(recipient.address);

    await router
      .connect(user)
      .createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 3_000_000 }], 86400, scw.address));
    await increase(86400 + 1);

    const auth = await signWithdrawAuth(attacker, domain, 1, true, { recipient: scw.address });
    let caught: any;
    try {
      await router.connect(relayer).withdrawFor(1, true, auth);
    } catch (e) {
      caught = e;
    }
    assert(caught && revertedWith(caught, "InvalidSponsorSignature()"), `got: ${caught?.message}`);
  });

  it("regular (non-gift) owner can also use withdrawFor; direct withdraw path unchanged", async function () {
    const { user, relayer, router, usdt, domain } = await loadFixture(deployFixture);

    await router.connect(user).createTimelock({
      timelockETHSwap: NO_SWAP,
      timelockERC20: [{ tokenAddress: usdt.address, amount: 10_000_000 }],
      timelockERC721: [],
      timelockERC1155: [],
      duration: 86400,
      name: "self-lock",
    });
    await increase(86400 + 1);

    const before = await usdt.balanceOf(user.address);
    const auth = await signWithdrawAuth(user, domain, 1, true);
    await router.connect(relayer).withdrawFor(1, true, auth);
    assert.equal((await usdt.balanceOf(user.address)).sub(before).toString(), "10000000");
  });
});

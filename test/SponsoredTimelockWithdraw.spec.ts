import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { deployProxy } from "./utils/proxy";

// Create-flow v2 — gas-sponsored timelock withdrawal (create-flow-v2.md §12a,
// timelock leg), domain version "2" (docs/plans/round-2026-09.md B1). The
// recipient signs an EIP-712 WithdrawAuth off-chain; any relayer submits
// withdrawFor and pays the gas. The vaults authorise on caller ==
// lock.recipient; since version "2" the signature may also name `payTo`, the
// wallet that receives the funds, applied only through the vaults'
// router-only `withdrawTo`. Mirrors SponsoredEOAClaims.spec.ts.

const ZERO = ethers.constants.AddressZero;
const NO_SWAP = { storageToken: ZERO, amountOutMin: 0, deadline: 0 };
const ONE_ETH = ethers.utils.parseEther("1");

const WITHDRAW_AUTH_TYPES = {
  WithdrawAuth: [
    { name: "recipient", type: "address" },
    { name: "payTo", type: "address" },
    { name: "timelockId", type: "uint256" },
    { name: "skipSwap", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

// The version-"1" struct, kept only to prove old signatures fail loudly.
const LEGACY_WITHDRAW_AUTH_TYPES = {
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

describe("TimeLockRouter — sponsored withdraw (withdrawFor, domain v2 with payTo)", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [admin, user, recipient, relayer, attacker, destination] = await ethers.getSigners();

    const router = await deployProxy("TimeLockRouter", [admin.address], "initialize", admin);
    const tlERC20 = await deployProxy("TimelockERC20", [admin.address, router.address], "initialize", admin);
    const tlERC721 = await deployProxy("TimelockERC721", [admin.address, router.address], "initialize", admin);
    const tlERC1155 = await deployProxy("TimelockERC1155", [admin.address, router.address], "initialize", admin);
    await router.connect(admin).setTimelock(tlERC20.address, tlERC721.address, tlERC1155.address);

    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    await usdt.mint(user.address, 1_000_000_000);
    await usdt.connect(user).approve(router.address, ethers.constants.MaxUint256);

    // A real WETH (deposit/withdraw) so the ETH-gift path runs end to end,
    // and a storage token that is NOT WETH so the swap path runs too.
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const storage = await ERC20.deploy("Staked", "STK", 18);
    const dex = await (await ethers.getContractFactory("MockUniswapV2Router")).deploy(weth.address);
    await storage.mint(dex.address, ONE_ETH.mul(1000)); // dex inventory for ETH→STK
    await admin.sendTransaction({ to: dex.address, value: ONE_ETH.mul(10) }); // dex inventory for STK→ETH
    await router.connect(admin).setUniswapRouter(dex.address);
    await tlERC20.connect(admin).setUniswapRouter(dex.address);

    const nft721 = await (await ethers.getContractFactory("MockERC721")).deploy();
    const nft1155 = await (await ethers.getContractFactory("MockERC1155")).deploy();
    await nft721.mint(user.address, 2); // ids 0, 1
    await nft1155.mint(user.address, 5); // id 0 x5
    await nft721.connect(user).setApprovalForAll(router.address, true);
    await nft1155.connect(user).setApprovalForAll(router.address, true);

    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "10102 Timelock Sponsored",
      version: "2",
      chainId: network.chainId,
      verifyingContract: router.address,
    };

    return {
      admin, user, recipient, relayer, attacker, destination,
      router, tlERC20, tlERC721, tlERC1155, usdt, weth, storage, dex, nft721, nft1155, domain,
    };
  }

  function gift(erc20: { tokenAddress: string; amount: any }[], duration: number, recipient: string, extra: any = {}) {
    return {
      timelockETHSwap: NO_SWAP,
      timelockERC20: erc20,
      timelockERC721: [],
      timelockERC1155: [],
      duration,
      recipient,
      name: "tl",
      giftName: "for you",
      ...extra,
    };
  }

  async function signWithdrawAuth(signer: any, domain: any, id: number, skipSwap: boolean, opts: any = {}) {
    const now = await currentTime();
    const auth = {
      recipient: opts.recipient ?? signer.address,
      payTo: opts.payTo ?? ZERO,
      timelockId: id,
      skipSwap,
      nonce: opts.nonce ?? 0,
      deadline: opts.deadline ?? now + 3600,
    };
    const signature = await (opts.signWith ?? signer)._signTypedData(domain, WITHDRAW_AUTH_TYPES, auth);
    return { recipient: auth.recipient, payTo: auth.payTo, nonce: auth.nonce, deadline: auth.deadline, signature };
  }

  async function sealUsdtGift(f: any, amount: number, to: string) {
    await f.router.connect(f.user).createTimelockedGift(gift([{ tokenAddress: f.usdt.address, amount }], 86400, to));
    await increase(86400 + 1);
  }

  // ───────────── domain ─────────────

  it("ERC-5267 eip712Domain advertises version 2 and matches the domain used off-chain", async function () {
    const { router, domain } = await loadFixture(deployFixture);
    const d = await router.eip712Domain();
    assert.equal(d.fields, "0x0f");
    assert.equal(d.name, domain.name);
    assert.equal(d.version, "2");
    assert.equal(d.chainId.toNumber(), domain.chainId);
    assert.equal(d.verifyingContract, router.address);
    assert.equal(await router.sponsoredDomainSeparator(), ethers.utils._TypedDataEncoder.hashDomain(domain));
  });

  // ───────────── payTo == 0: today's behaviour ─────────────

  it("payTo = 0: gift recipient withdraws gaslessly via a relayer; funds go to the recipient", async function () {
    const f = await loadFixture(deployFixture);
    const { recipient, relayer, router, usdt, domain } = f;
    await sealUsdtGift(f, 100_000_000, recipient.address);

    const auth = await signWithdrawAuth(recipient, domain, 1, true);
    const tx = await router.connect(relayer).withdrawFor(1, true, auth);

    assert.equal((await usdt.balanceOf(recipient.address)).toString(), "100000000");
    assert.equal((await usdt.balanceOf(relayer.address)).toString(), "0");
    assert.equal((await router.sponsorNonce(recipient.address)).toNumber(), 1);

    const receipt = await tx.wait();
    const evFor = receipt.events?.find((e: any) => e.event === "TimelockWithdrawnFor");
    assert(evFor, "TimelockWithdrawnFor not emitted");
    assert.equal(evFor.args.recipient, recipient.address);
    assert.equal(evFor.args.relayer, relayer.address);
    const evTo = receipt.events?.find((e: any) => e.event === "TimelockWithdrawnTo");
    assert(evTo, "TimelockWithdrawnTo not emitted");
    assert.equal(evTo.args.payTo, recipient.address, "payTo resolves to the recipient when unset");
    // No redirect event on the vault when the payee is the recipient.
    const vaultLogs = receipt.logs.filter((l: any) => l.address === f.tlERC20.address);
    const redirected = vaultLogs.find((l: any) => l.topics[0] === f.tlERC20.interface.getEventTopic("FundsRedirected"));
    assert(!redirected, "FundsRedirected must not fire when payee == recipient");
  });

  // ───────────── payTo set: every asset path ─────────────

  it("payTo set: USDC-style gift pays the destination, never the recipient or the relayer", async function () {
    const f = await loadFixture(deployFixture);
    const { recipient, relayer, destination, router, usdt, tlERC20, domain } = f;
    await sealUsdtGift(f, 50_000_000, recipient.address);

    const auth = await signWithdrawAuth(recipient, domain, 1, true, { payTo: destination.address });
    const tx = await router.connect(relayer).withdrawFor(1, true, auth);
    const receipt = await tx.wait();

    assert.equal((await usdt.balanceOf(destination.address)).toString(), "50000000");
    assert.equal((await usdt.balanceOf(recipient.address)).toString(), "0");
    assert.equal((await usdt.balanceOf(relayer.address)).toString(), "0");

    const evTo = receipt.events?.find((e: any) => e.event === "TimelockWithdrawnTo");
    assert.equal(evTo.args.recipient, recipient.address);
    assert.equal(evTo.args.payTo, destination.address);
    const redirected = receipt.logs.find(
      (l: any) => l.address === tlERC20.address && l.topics[0] === tlERC20.interface.getEventTopic("FundsRedirected")
    );
    assert(redirected, "FundsRedirected expected on the vault");
    const parsed = tlERC20.interface.parseLog(redirected);
    assert.equal(parsed.args.recipient, recipient.address);
    assert.equal(parsed.args.payTo, destination.address);
    // The vault's historical event keeps naming the recipient (subgraph shape).
    const fw = receipt.logs.find(
      (l: any) => l.address === tlERC20.address && l.topics[0] === tlERC20.interface.getEventTopic("FundsWithdrawn")
    );
    assert.equal(tlERC20.interface.parseLog(fw).args.recipient, recipient.address);
  });

  it("payTo set: ETH gift stored as WETH is unwrapped to the destination", async function () {
    const f = await loadFixture(deployFixture);
    const { user, recipient, relayer, destination, router, weth, domain } = f;
    const now = await currentTime();
    await router.connect(user).createTimelockedGift(
      gift([], 86400, recipient.address, {
        timelockETHSwap: { storageToken: weth.address, amountOutMin: 0, deadline: now + 3600 },
      }),
      { value: ONE_ETH }
    );
    await increase(86400 + 1);

    const before = await ethers.provider.getBalance(destination.address);
    const auth = await signWithdrawAuth(recipient, domain, 1, false, { payTo: destination.address });
    await router.connect(relayer).withdrawFor(1, false, auth);
    const after = await ethers.provider.getBalance(destination.address);

    assert.equal(after.sub(before).toString(), ONE_ETH.toString(), "destination receives the unwrapped ETH");
    assert.equal((await weth.balanceOf(recipient.address)).toString(), "0");
    assert.equal((await weth.balanceOf(destination.address)).toString(), "0");
  });

  it("payTo set: ETH gift stored as WETH with skipSwap hands the destination WETH", async function () {
    const f = await loadFixture(deployFixture);
    const { user, recipient, relayer, destination, router, weth, domain } = f;
    const now = await currentTime();
    await router.connect(user).createTimelockedGift(
      gift([], 86400, recipient.address, {
        timelockETHSwap: { storageToken: weth.address, amountOutMin: 0, deadline: now + 3600 },
      }),
      { value: ONE_ETH }
    );
    await increase(86400 + 1);

    const auth = await signWithdrawAuth(recipient, domain, 1, true, { payTo: destination.address });
    await router.connect(relayer).withdrawFor(1, true, auth);
    assert.equal((await weth.balanceOf(destination.address)).toString(), ONE_ETH.toString());
  });

  it("payTo set: swap path (storage token → ETH) pays the destination", async function () {
    const f = await loadFixture(deployFixture);
    const { user, recipient, relayer, destination, router, storage, domain } = f;
    const now = await currentTime();
    await router.connect(user).createTimelockedGift(
      gift([], 86400, recipient.address, {
        timelockETHSwap: { storageToken: storage.address, amountOutMin: 0, deadline: now + 3600 },
      }),
      { value: ONE_ETH }
    );
    await increase(86400 + 1);

    const before = await ethers.provider.getBalance(destination.address);
    const auth = await signWithdrawAuth(recipient, domain, 1, false, { payTo: destination.address });
    await router.connect(relayer).withdrawFor(1, false, auth);
    const after = await ethers.provider.getBalance(destination.address);

    assert(after.gt(before), "destination received ETH from the swap");
    assert.equal((await storage.balanceOf(destination.address)).toString(), "0");
    assert.equal((await storage.balanceOf(recipient.address)).toString(), "0");
  });

  it("payTo set: ERC-721 and ERC-1155 gifts are delivered to the destination", async function () {
    const f = await loadFixture(deployFixture);
    const { user, recipient, relayer, destination, router, nft721, nft1155, tlERC721, tlERC1155, domain } = f;
    await router.connect(user).createTimelockedGift(
      gift([], 86400, recipient.address, {
        timelockERC721: [{ tokenAddress: nft721.address, id: 0 }],
        timelockERC1155: [{ tokenAddress: nft1155.address, id: 0, amount: 3 }],
      })
    );
    await increase(86400 + 1);

    const auth = await signWithdrawAuth(recipient, domain, 1, true, { payTo: destination.address });
    const receipt = await (await router.connect(relayer).withdrawFor(1, true, auth)).wait();

    assert.equal(await nft721.ownerOf(0), destination.address);
    assert.equal((await nft1155.balanceOf(destination.address, 0)).toNumber(), 3);
    assert.equal((await nft1155.balanceOf(recipient.address, 0)).toNumber(), 0);

    const r721 = receipt.logs.find(
      (l: any) => l.address === tlERC721.address && l.topics[0] === tlERC721.interface.getEventTopic("TokensRedirected")
    );
    const r1155 = receipt.logs.find(
      (l: any) => l.address === tlERC1155.address && l.topics[0] === tlERC1155.interface.getEventTopic("FundsRedirected")
    );
    assert(r721 && r1155, "both NFT vaults emit their redirect event");
  });

  it("payTo set: soft lock, unlocked by its owner, pays the destination after the wait", async function () {
    const f = await loadFixture(deployFixture);
    const { user, relayer, destination, router, usdt, domain } = f;
    await router.connect(user).createSoftTimelock({
      timelockETHSwap: NO_SWAP,
      timelockERC20: [{ tokenAddress: usdt.address, amount: 7_000_000 }],
      timelockERC721: [],
      timelockERC1155: [],
      bufferTime: 3600,
      name: "soft",
    });
    await router.connect(user).unlockSoftTimelock(1);
    await increase(3600 + 1);

    const auth = await signWithdrawAuth(user, domain, 1, true, { payTo: destination.address });
    await router.connect(relayer).withdrawFor(1, true, auth);
    assert.equal((await usdt.balanceOf(destination.address)).toString(), "7000000");
  });

  // ───────────── binding and rejection ─────────────

  it("a signature over the version-1 struct (no payTo) is rejected", async function () {
    const f = await loadFixture(deployFixture);
    const { recipient, relayer, router, domain } = f;
    await sealUsdtGift(f, 1_000_000, recipient.address);

    const now = await currentTime();
    const legacyValue = { recipient: recipient.address, timelockId: 1, skipSwap: true, nonce: 0, deadline: now + 3600 };
    for (const version of ["1", "2"]) {
      const sig = await recipient._signTypedData({ ...domain, version }, LEGACY_WITHDRAW_AUTH_TYPES, legacyValue);
      await expectRevert(
        router.connect(relayer).withdrawFor(1, true, {
          recipient: recipient.address, payTo: ZERO, nonce: 0, deadline: legacyValue.deadline, signature: sig,
        }),
        "InvalidSponsorSignature()",
        `legacy struct under domain version ${version}:`
      );
    }
  });

  it("the relayer cannot swap in a different payTo; the signed one is bound", async function () {
    const f = await loadFixture(deployFixture);
    const { recipient, relayer, attacker, destination, router, usdt, domain } = f;
    await sealUsdtGift(f, 1_000_000, recipient.address);

    const auth = await signWithdrawAuth(recipient, domain, 1, true, { payTo: destination.address });
    await expectRevert(
      router.connect(relayer).withdrawFor(1, true, { ...auth, payTo: attacker.address }),
      "InvalidSponsorSignature()",
      "payTo tamper:"
    );
    // Signed for the recipient itself, relayer inserts a destination.
    const plain = await signWithdrawAuth(recipient, domain, 1, true);
    await expectRevert(
      router.connect(relayer).withdrawFor(1, true, { ...plain, payTo: attacker.address }),
      "InvalidSponsorSignature()",
      "payTo insertion:"
    );
    assert.equal((await usdt.balanceOf(attacker.address)).toString(), "0");
  });

  it("nonce is consumed once; replay with a different payTo fails", async function () {
    const f = await loadFixture(deployFixture);
    const { user, recipient, relayer, destination, attacker, router, usdt, domain } = f;
    await router.connect(user).createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 1_000_000 }], 86400, recipient.address));
    await router.connect(user).createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 2_000_000 }], 86400, recipient.address));
    await increase(86400 + 1);

    const auth = await signWithdrawAuth(recipient, domain, 1, true, { payTo: destination.address });
    await router.connect(relayer).withdrawFor(1, true, auth);
    assert.equal((await router.sponsorNonce(recipient.address)).toNumber(), 1);

    await expectRevert(router.connect(relayer).withdrawFor(1, true, auth), "InvalidSponsorNonce()", "same auth replay:");
    const secondSameNonce = await signWithdrawAuth(recipient, domain, 2, true, { payTo: attacker.address, nonce: 0 });
    await expectRevert(router.connect(relayer).withdrawFor(2, true, secondSameNonce), "InvalidSponsorNonce()", "stale nonce:");
  });

  it("payTo may not be the router or a vault", async function () {
    const f = await loadFixture(deployFixture);
    const { recipient, relayer, router, tlERC20, tlERC721, tlERC1155, domain } = f;
    await sealUsdtGift(f, 1_000_000, recipient.address);

    for (const bad of [router.address, tlERC20.address, tlERC721.address, tlERC1155.address]) {
      const auth = await signWithdrawAuth(recipient, domain, 1, true, { payTo: bad });
      await expectRevert(router.connect(relayer).withdrawFor(1, true, auth), "InvalidPayee()", `payTo=${bad}:`);
    }
    // Nonce untouched by the rejected attempts.
    assert.equal((await router.sponsorNonce(recipient.address)).toNumber(), 0);
  });

  it("the vaults' withdrawTo is router-only; withdraw stays open and pays the recipient", async function () {
    const f = await loadFixture(deployFixture);
    const { recipient, attacker, destination, router, tlERC20, tlERC721, tlERC1155, usdt } = f;
    await sealUsdtGift(f, 1_000_000, recipient.address);

    await expectRevert(
      tlERC20.connect(attacker).withdrawTo(1, recipient.address, destination.address, true),
      "NotAuthorized()",
      "erc20 withdrawTo from non-router:"
    );
    await expectRevert(
      tlERC721.connect(attacker).withdrawTo(1, recipient.address, destination.address),
      "NotAuthorized()",
      "erc721 withdrawTo from non-router:"
    );
    await expectRevert(
      tlERC1155.connect(attacker).withdrawTo(1, recipient.address, destination.address),
      "NotAuthorized()",
      "erc1155 withdrawTo from non-router:"
    );
    // Even the recipient cannot redirect through the vault directly.
    await expectRevert(
      tlERC20.connect(recipient).withdrawTo(1, recipient.address, destination.address, true),
      "NotAuthorized()",
      "erc20 withdrawTo from recipient:"
    );

    // The router's direct path is unchanged: the recipient pays its own
    // gas and is paid (the open vault path is covered in its own test).
    await router.connect(recipient)["withdraw(uint256,bool)"](1, true);
    assert.equal((await usdt.balanceOf(recipient.address)).toString(), "1000000");
    assert.equal((await usdt.balanceOf(destination.address)).toString(), "0");
  });

  it("rejects a signature from someone other than the recipient (with and without payTo)", async function () {
    const f = await loadFixture(deployFixture);
    const { recipient, relayer, attacker, router, domain } = f;
    await sealUsdtGift(f, 1_000_000, recipient.address);

    const forged = await signWithdrawAuth(recipient, domain, 1, true, { signWith: attacker, payTo: attacker.address });
    await expectRevert(router.connect(relayer).withdrawFor(1, true, forged), "InvalidSponsorSignature()", "forged with payTo:");
    const forgedPlain = await signWithdrawAuth(recipient, domain, 1, true, { signWith: attacker });
    await expectRevert(router.connect(relayer).withdrawFor(1, true, forgedPlain), "InvalidSponsorSignature()", "forged plain:");
  });

  it("rejects relayer tampering with id / skipSwap; enforces deadline, TTL cap and nonce", async function () {
    const f = await loadFixture(deployFixture);
    const { user, recipient, relayer, router, usdt, domain } = f;
    await router.connect(user).createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 1_000_000 }], 86400, recipient.address));
    await router.connect(user).createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 2_000_000 }], 86400, recipient.address));
    await increase(86400 + 1);

    const auth = await signWithdrawAuth(recipient, domain, 1, true);
    await expectRevert(router.connect(relayer).withdrawFor(1, false, auth), "InvalidSponsorSignature()", "skipSwap tamper:");
    // Signed for id 1; relayer points it at id 2 (same recipient).
    await expectRevert(router.connect(relayer).withdrawFor(2, true, auth), "InvalidSponsorSignature()", "id tamper:");

    const now = await currentTime();
    const expired = await signWithdrawAuth(recipient, domain, 1, true, { deadline: now - 1 });
    await expectRevert(router.connect(relayer).withdrawFor(1, true, expired), "SponsorshipExpired()", "deadline:");

    // A signature collected far ahead of time is refused at submission: the
    // deadline may not sit more than 7 days out (MAX_SPONSOR_AUTH_TTL).
    const farFuture = await signWithdrawAuth(recipient, domain, 1, true, { deadline: now + 7 * 86400 + 60 });
    await expectRevert(router.connect(relayer).withdrawFor(1, true, farFuture), "SponsorshipExpired()", "ttl cap:");
    const withinCap = await signWithdrawAuth(recipient, domain, 1, true, { deadline: now + 7 * 86400 - 60 });
    await router.connect(relayer).withdrawFor(1, true, withinCap);

    const wrongNonce = await signWithdrawAuth(recipient, domain, 2, true, { nonce: 5 });
    await expectRevert(router.connect(relayer).withdrawFor(2, true, wrongNonce), "InvalidSponsorNonce()", "nonce:");
  });

  it("payTo explicitly equal to the recipient behaves as no destination (no redirect event)", async function () {
    const f = await loadFixture(deployFixture);
    const { recipient, relayer, router, usdt, tlERC20, domain } = f;
    await sealUsdtGift(f, 1_000_000, recipient.address);

    const auth = await signWithdrawAuth(recipient, domain, 1, true, { payTo: recipient.address });
    const receipt = await (await router.connect(relayer).withdrawFor(1, true, auth)).wait();
    assert.equal((await usdt.balanceOf(recipient.address)).toString(), "1000000");
    const redirected = receipt.logs.find(
      (l: any) => l.address === tlERC20.address && l.topics[0] === tlERC20.interface.getEventTopic("FundsRedirected")
    );
    assert(!redirected, "no FundsRedirected when payTo == recipient");
    const evTo = receipt.events?.find((e: any) => e.event === "TimelockWithdrawnTo");
    assert.equal(evTo.args.payTo, recipient.address);
  });

  it("an id that exists in no vault reverts before the nonce is consumed", async function () {
    const f = await loadFixture(deployFixture);
    const { recipient, relayer, destination, router, domain } = f;
    await sealUsdtGift(f, 1_000_000, recipient.address);

    const phantom = await signWithdrawAuth(recipient, domain, 424242, true, { payTo: destination.address });
    await expectRevert(router.connect(relayer).withdrawFor(424242, true, phantom), "TimelockNotLive()", "phantom id:");
    assert.equal((await router.sponsorNonce(recipient.address)).toNumber(), 0, "nonce untouched");
  });

  it("direct vault withdraw: anyone may trigger it, only the recipient is ever paid", async function () {
    const f = await loadFixture(deployFixture);
    const { recipient, attacker, tlERC20, usdt } = f;
    await sealUsdtGift(f, 1_000_000, recipient.address);

    // Naming another payee on the open path is not a redirect: `caller`
    // must equal the recipient, and the recipient is who gets paid.
    await expectRevert(
      tlERC20.connect(attacker).withdraw(1, attacker.address, true),
      "NotAuthorized()",
      "attacker as caller:"
    );
    await tlERC20.connect(attacker).withdraw(1, recipient.address, true);
    assert.equal((await usdt.balanceOf(recipient.address)).toString(), "1000000");
    assert.equal((await usdt.balanceOf(attacker.address)).toString(), "0");
  });

  it("the vaults refuse a zero or self payee on withdrawTo even from the router", async function () {
    const f = await loadFixture(deployFixture);
    const { recipient, router, tlERC20 } = f;
    await sealUsdtGift(f, 1_000_000, recipient.address);

    // Impersonate the router: the only caller that can reach withdrawTo.
    await ethers.provider.send("hardhat_impersonateAccount", [router.address]);
    await ethers.provider.send("hardhat_setBalance", [router.address, "0x1000000000000000000"]);
    const asRouter = await ethers.getSigner(router.address);
    await expectRevert(tlERC20.connect(asRouter).withdrawTo(1, recipient.address, ZERO, true), "InvalidPayee()", "zero payee:");
    await expectRevert(tlERC20.connect(asRouter).withdrawTo(1, recipient.address, tlERC20.address, true), "InvalidPayee()", "self payee:");
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [router.address]);
  });

  it("a payee that rejects the transfer reverts the whole claim, nonce intact; re-signing to another wallet works", async function () {
    const f = await loadFixture(deployFixture);
    const { user, recipient, relayer, destination, router, weth, nft721, domain } = f;
    const hostile = await (await ethers.getContractFactory("MockHostilePayee")).deploy();
    await hostile.setRejectAll(true);

    const now = await currentTime();
    await router.connect(user).createTimelockedGift(
      gift([], 86400, recipient.address, {
        timelockETHSwap: { storageToken: weth.address, amountOutMin: 0, deadline: now + 3600 },
      }),
      { value: ONE_ETH }
    );
    await router.connect(user).createTimelockedGift(
      gift([], 86400, recipient.address, { timelockERC721: [{ tokenAddress: nft721.address, id: 0 }] })
    );
    await increase(86400 + 1);

    // ETH unwrap to a payee that rejects ETH.
    const ethAuth = await signWithdrawAuth(recipient, domain, 1, false, { payTo: hostile.address });
    await expectRevert(router.connect(relayer).withdrawFor(1, false, ethAuth), "NativeTokenTransferFailed()", "reject eth:");
    // NFT to a payee whose hook reverts.
    const nftAuth = await signWithdrawAuth(recipient, domain, 2, true, { payTo: hostile.address });
    let caught: any;
    try {
      await router.connect(relayer).withdrawFor(2, true, nftAuth);
    } catch (e) {
      caught = e;
    }
    assert(caught, "nft to rejecting payee must revert");
    assert.equal((await router.sponsorNonce(recipient.address)).toNumber(), 0, "nonce intact after both reverts");

    // The recipient simply signs again for a wallet that accepts.
    const before = await ethers.provider.getBalance(destination.address);
    await router.connect(relayer).withdrawFor(1, false, await signWithdrawAuth(recipient, domain, 1, false, { payTo: destination.address }));
    assert.equal((await ethers.provider.getBalance(destination.address)).sub(before).toString(), ONE_ETH.toString());
    await router.connect(relayer).withdrawFor(2, true, await signWithdrawAuth(recipient, domain, 2, true, { payTo: destination.address, nonce: 1 }));
    assert.equal(await nft721.ownerOf(0), destination.address);
  });

  it("a payee that re-enters from its receive hooks is stopped by the vault guards; each gift pays once", async function () {
    const f = await loadFixture(deployFixture);
    const { user, recipient, relayer, router, weth, nft721, nft1155, tlERC721, domain } = f;
    const hostile = await (await ethers.getContractFactory("MockHostilePayee")).deploy();

    const now = await currentTime();
    // id 1: ETH gift (unwrap pays ETH to the hostile payee → receive()).
    await router.connect(user).createTimelockedGift(
      gift([], 86400, recipient.address, {
        timelockETHSwap: { storageToken: weth.address, amountOutMin: 0, deadline: now + 3600 },
      }),
      { value: ONE_ETH }
    );
    // id 2: ERC-721 gift (onERC721Received). id 3: ERC-1155 gift (onERC1155Received).
    await router.connect(user).createTimelockedGift(gift([], 86400, recipient.address, { timelockERC721: [{ tokenAddress: nft721.address, id: 0 }] }));
    await router.connect(user).createTimelockedGift(gift([], 86400, recipient.address, { timelockERC1155: [{ tokenAddress: nft1155.address, id: 0, amount: 2 }] }));
    await increase(86400 + 1);

    // Vector A: during the ETH payout of id 1, re-enter the router with a
    // valid authorization for id 2 (nonce 1, the value after id 1's consume).
    const auth2 = await signWithdrawAuth(recipient, domain, 2, true, { payTo: hostile.address, nonce: 1 });
    await hostile.arm(router.address, router.interface.encodeFunctionData("withdrawFor", [2, true, auth2]));
    const auth1 = await signWithdrawAuth(recipient, domain, 1, false, { payTo: hostile.address });
    await router.connect(relayer).withdrawFor(1, false, auth1);
    assert.equal((await hostile.attempts()).toNumber(), 1, "hook fired once during the ETH payout");
    assert.equal((await hostile.reentrySucceeded()).toNumber(), 0, "re-entry into withdrawFor was blocked");
    assert.equal((await ethers.provider.getBalance(hostile.address)).toString(), ONE_ETH.toString());
    assert.equal(await nft721.ownerOf(0), tlERC721.address, "id 2 still escrowed after the blocked re-entry");

    // Vector B: during the ERC-721 delivery of id 2, call the vault's open
    // withdraw for id 3 directly (would pay the recipient, not the payee).
    await hostile.arm(tlERC721.address, tlERC721.interface.encodeFunctionData("withdraw", [3, recipient.address]));
    await router.connect(relayer).withdrawFor(2, true, auth2);
    assert.equal(await nft721.ownerOf(0), hostile.address);
    assert.equal((await hostile.reentrySucceeded()).toNumber(), 0, "vault-level re-entry blocked too");
    assert.equal((await nft1155.balanceOf(recipient.address, 0)).toNumber(), 0, "id 3 untouched");

    // Vector C: during the ERC-1155 delivery of id 3, re-enter withdrawFor
    // for id 3 itself (nonce 3 would be next); blocked, single delivery.
    const auth3 = await signWithdrawAuth(recipient, domain, 3, true, { payTo: hostile.address, nonce: 2 });
    const auth3again = await signWithdrawAuth(recipient, domain, 3, true, { payTo: hostile.address, nonce: 3 });
    await hostile.arm(router.address, router.interface.encodeFunctionData("withdrawFor", [3, true, auth3again]));
    await router.connect(relayer).withdrawFor(3, true, auth3);
    assert.equal((await nft1155.balanceOf(hostile.address, 0)).toNumber(), 2, "delivered exactly once");
    assert.equal((await hostile.reentrySucceeded()).toNumber(), 0);
    assert.equal((await router.sponsorNonce(recipient.address)).toNumber(), 3);
  });

  it("invalidateSponsorNonce kills an outstanding authorization", async function () {
    const f = await loadFixture(deployFixture);
    const { recipient, relayer, router, usdt, domain } = f;
    await sealUsdtGift(f, 1_000_000, recipient.address);

    const auth = await signWithdrawAuth(recipient, domain, 1, true);
    await router.connect(recipient).invalidateSponsorNonce();
    await expectRevert(router.connect(relayer).withdrawFor(1, true, auth), "InvalidSponsorNonce()");

    const fresh = await signWithdrawAuth(recipient, domain, 1, true, { nonce: 1 });
    await router.connect(relayer).withdrawFor(1, true, fresh);
    assert.equal((await usdt.balanceOf(recipient.address)).toString(), "1000000");
  });

  it("ERC-1271 smart-wallet recipient withdraws gaslessly, to itself or to a destination", async function () {
    const f = await loadFixture(deployFixture);
    const { user, recipient, relayer, destination, router, usdt, domain } = f;
    const Wallet = await ethers.getContractFactory("MockERC1271Wallet");
    const scw = await Wallet.deploy(recipient.address);

    await router.connect(user).createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 3_000_000 }], 86400, scw.address));
    await router.connect(user).createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 4_000_000 }], 86400, scw.address));
    await increase(86400 + 1);

    const toSelf = await signWithdrawAuth(recipient, domain, 1, true, { recipient: scw.address });
    await router.connect(relayer).withdrawFor(1, true, toSelf);
    assert.equal((await usdt.balanceOf(scw.address)).toString(), "3000000");

    const toDest = await signWithdrawAuth(recipient, domain, 2, true, { recipient: scw.address, payTo: destination.address, nonce: 1 });
    await router.connect(relayer).withdrawFor(2, true, toDest);
    assert.equal((await usdt.balanceOf(destination.address)).toString(), "4000000");
  });

  it("rejects an ERC-1271 signature from a non-owner key", async function () {
    const f = await loadFixture(deployFixture);
    const { user, recipient, relayer, attacker, router, usdt, domain } = f;
    const Wallet = await ethers.getContractFactory("MockERC1271Wallet");
    const scw = await Wallet.deploy(recipient.address);
    await router.connect(user).createTimelockedGift(gift([{ tokenAddress: usdt.address, amount: 3_000_000 }], 86400, scw.address));
    await increase(86400 + 1);

    const auth = await signWithdrawAuth(attacker, domain, 1, true, { recipient: scw.address });
    await expectRevert(router.connect(relayer).withdrawFor(1, true, auth), "InvalidSponsorSignature()");
  });

  it("regular (non-gift) owner can also use withdrawFor; direct withdraw path unchanged", async function () {
    const f = await loadFixture(deployFixture);
    const { user, relayer, router, usdt, domain } = f;
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

  // ───────────── property: funds move only when the signer is the recipient ─────────────

  it("property: over random (recipient, signer, payTo) triples, funds move iff signer == recipient", async function () {
    const f = await loadFixture(deployFixture);
    const { user, relayer, router, usdt, domain } = f;

    // Deterministic pseudo-random wallets: reproducible without a fuzzing
    // dependency (the repo has no Foundry / fast-check).
    const wallets = Array.from({ length: 6 }, (_, i) =>
      new ethers.Wallet(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`payTo-property-${i}`)), ethers.provider)
    );
    let seed = 0x5eed;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };

    const ROUNDS = 24;
    const amount = 1_000;
    for (let i = 0; i < ROUNDS; i++) {
      await router.connect(user).createTimelockedGift(gift([{ tokenAddress: usdt.address, amount }], 1, wallets[rnd(wallets.length)].address));
    }
    await increase(2);

    const paid = new Map<string, number>();
    for (let id = 1; id <= ROUNDS; id++) {
      const details = await f.tlERC20.getTimelockDetails(id);
      const recipientAddr: string = details.recipient;
      const signer = wallets[rnd(wallets.length)];
      const payToPick = rnd(3); // 0: none, 1: self, 2: random wallet
      const payTo = payToPick === 0 ? ZERO : payToPick === 1 ? recipientAddr : wallets[rnd(wallets.length)].address;
      const nonce = (await router.sponsorNonce(recipientAddr)).toNumber();
      const now = await currentTime();
      const value = { recipient: recipientAddr, payTo, timelockId: id, skipSwap: true, nonce, deadline: now + 3600 };
      const signature = await signer._signTypedData(domain, WITHDRAW_AUTH_TYPES, value);
      const auth = { recipient: recipientAddr, payTo, nonce, deadline: value.deadline, signature };

      const expectedPayee = payTo === ZERO ? recipientAddr : payTo;
      const before = await usdt.balanceOf(expectedPayee);
      let ok = true;
      try {
        await router.connect(relayer).withdrawFor(id, true, auth);
      } catch (e) {
        ok = false;
        assert(revertedWith(e, "InvalidSponsorSignature()"), `unexpected revert: ${(e as any)?.message}`);
      }
      const after = await usdt.balanceOf(expectedPayee);
      const shouldPass = signer.address.toLowerCase() === recipientAddr.toLowerCase();
      assert.equal(ok, shouldPass, `id ${id}: signer==recipient is ${shouldPass}, tx ok is ${ok}`);
      assert.equal(after.sub(before).toNumber(), shouldPass ? amount : 0, `id ${id}: payee balance delta`);
      if (shouldPass) paid.set(expectedPayee, (paid.get(expectedPayee) ?? 0) + amount);
    }
    // The relayer never ends up with anything.
    assert.equal((await usdt.balanceOf(relayer.address)).toString(), "0");
  });
});

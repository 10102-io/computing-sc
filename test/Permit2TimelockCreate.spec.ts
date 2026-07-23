import { ethers, artifacts } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { deployProxy } from "./utils/proxy";

// Create-flow v2 — Permit2 single-confirm timelock create (create-flow-v2.md §12 / §5.5).
// Unlike the legacy side (claim-time pulls), timelock escrow at create IS the
// product model, so the `…WithPermit2` variants register the creator's signed
// AllowanceTransfer batch (spender = the TimeLockRouter itself) and pull the
// ERC-20s through Permit2 in the same tx — one signature instead of N approve
// txs. Same MockPermit2-at-canonical-address trick as Permit2Create.spec.ts.

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const PERMIT_BATCH_TYPES = {
  PermitBatch: [
    { name: "details", type: "PermitDetails[]" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
};

const EMPTY_BUNDLE = {
  permitBatch: { details: [], spender: ethers.constants.AddressZero, sigDeadline: 0 },
  signature: "0x",
};

const NO_SWAP = { storageToken: ethers.constants.AddressZero, amountOutMin: 0, deadline: 0 };

function revertedWith(err: any, signature: string): boolean {
  const selector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(signature)).slice(0, 10).toLowerCase();
  const blob = ((err?.message ?? "") + " " + JSON.stringify(err ?? "") + " " + (err?.data ?? "") + " " + (err?.error?.message ?? "")).toLowerCase();
  return blob.includes(signature.toLowerCase()) || blob.includes(selector);
}

describe("TimeLockRouter — Permit2 single-confirm create variants", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [admin, user, recipient, attacker] = await ethers.getSigners();

    const mockArtifact = await artifacts.readArtifact("MockPermit2");
    await ethers.provider.send("hardhat_setCode", [PERMIT2_ADDRESS, mockArtifact.deployedBytecode]);
    const permit2 = await ethers.getContractAt("MockPermit2", PERMIT2_ADDRESS);

    const router = await deployProxy("TimeLockRouter", [admin.address], "initialize", admin);
    const tlERC20 = await deployProxy("TimelockERC20", [admin.address, router.address], "initialize", admin);
    const tlERC721 = await deployProxy("TimelockERC721", [admin.address, router.address], "initialize", admin);
    const tlERC1155 = await deployProxy("TimelockERC1155", [admin.address, router.address], "initialize", admin);
    await router.connect(admin).setTimelock(tlERC20.address, tlERC721.address, tlERC1155.address);

    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    const usdc = await ERC20.deploy("USDC", "USDC", 6);
    await usdt.mint(user.address, 1_000_000_000);
    await usdc.mint(user.address, 500_000_000);

    // One-time ecosystem-standard approve(Permit2, max) per token (§6.7).
    await usdt.connect(user).approve(PERMIT2_ADDRESS, ethers.constants.MaxUint256);
    await usdc.connect(user).approve(PERMIT2_ADDRESS, ethers.constants.MaxUint256);

    const network = await ethers.provider.getNetwork();
    const permit2Domain = { name: "Permit2", chainId: network.chainId, verifyingContract: PERMIT2_ADDRESS };

    return { admin, user, recipient, attacker, router, tlERC20, permit2, permit2Domain, usdt, usdc };
  }

  async function signPermitBatch(signer: any, domain: any, tokens: string[], spender: string, opts: any = {}) {
    const now = await currentTime();
    const details = tokens.map((t, i) => ({
      token: t,
      amount: opts.amount ?? ethers.BigNumber.from(2).pow(160).sub(1),
      expiration: opts.expiration ?? now + 10 * 365 * 86400,
      nonce: opts.nonce ?? 0,
    }));
    const permitBatch = { details, spender, sigDeadline: opts.sigDeadline ?? now + 1800 };
    const signature = await (opts.signWith ?? signer)._signTypedData(domain, PERMIT_BATCH_TYPES, permitBatch);
    return { permitBatch, signature };
  }

  function regular(erc20: { tokenAddress: string; amount: number }[], duration: number) {
    return { timelockETHSwap: NO_SWAP, timelockERC20: erc20, timelockERC721: [], timelockERC1155: [], duration, name: "tl" };
  }

  it("creates a regular timelock with zero approve txs; withdraw returns the tokens", async function () {
    const { user, router, tlERC20, permit2Domain, usdt, usdc } = await loadFixture(deployFixture);

    const bundle = await signPermitBatch(user, permit2Domain, [usdt.address, usdc.address], router.address);
    await router.connect(user).createTimelockWithPermit2(
      regular(
        [
          { tokenAddress: usdt.address, amount: 100_000_000 },
          { tokenAddress: usdc.address, amount: 50_000_000 },
        ],
        86400
      ),
      { permitBatch: bundle.permitBatch, signature: bundle.signature }
    );

    // Escrowed in the timelock asset contract; the router itself never had a
    // direct ERC-20 allowance from the user.
    assert.equal((await usdt.balanceOf(tlERC20.address)).toString(), "100000000");
    assert.equal((await usdc.balanceOf(tlERC20.address)).toString(), "50000000");
    assert.equal((await usdt.allowance(user.address, router.address)).toString(), "0");

    await increase(86400 + 1);
    await router.connect(user)["withdraw(uint256,bool)"](1, true);
    assert.equal((await usdt.balanceOf(user.address)).toString(), "1000000000");
    assert.equal((await usdc.balanceOf(user.address)).toString(), "500000000");
  });

  it("rejects a bundle whose spender is not the router", async function () {
    const { user, router, tlERC20, permit2Domain, usdt } = await loadFixture(deployFixture);

    const bundle = await signPermitBatch(user, permit2Domain, [usdt.address], tlERC20.address);
    let caught: any;
    try {
      await router
        .connect(user)
        .createTimelockWithPermit2(regular([{ tokenAddress: usdt.address, amount: 1_000_000 }], 86400), {
          permitBatch: bundle.permitBatch,
          signature: bundle.signature,
        });
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected revert");
    assert(revertedWith(caught, "Permit2SpenderMismatch()"), `got: ${caught?.message}`);
  });

  it("rejects a permit batch signed by someone other than the creator", async function () {
    const { user, attacker, router, permit2Domain, usdt } = await loadFixture(deployFixture);

    const bundle = await signPermitBatch(user, permit2Domain, [usdt.address], router.address, { signWith: attacker });
    let caught: any;
    try {
      await router
        .connect(user)
        .createTimelockWithPermit2(regular([{ tokenAddress: usdt.address, amount: 1_000_000 }], 86400), {
          permitBatch: bundle.permitBatch,
          signature: bundle.signature,
        });
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected revert");
    assert(revertedWith(caught, "InvalidSigner()"), `got: ${caught?.message}`);
  });

  it("empty bundle reuses a previously registered Permit2 allowance", async function () {
    const { user, router, tlERC20, permit2Domain, usdt } = await loadFixture(deployFixture);

    // First create registers a max allowance (spender = router)…
    const bundle = await signPermitBatch(user, permit2Domain, [usdt.address], router.address);
    await router.connect(user).createTimelockWithPermit2(regular([{ tokenAddress: usdt.address, amount: 100_000_000 }], 86400), {
      permitBatch: bundle.permitBatch,
      signature: bundle.signature,
    });

    // …second create rides the remaining allowance with NO fresh signature.
    await router
      .connect(user)
      .createTimelockWithPermit2(regular([{ tokenAddress: usdt.address, amount: 200_000_000 }], 86400), EMPTY_BUNDLE);

    assert.equal((await usdt.balanceOf(tlERC20.address)).toString(), "300000000");
  });

  it("classic createTimelock (direct approve) is untouched", async function () {
    const { user, router, tlERC20, usdt } = await loadFixture(deployFixture);

    await usdt.connect(user).approve(router.address, 100_000_000);
    await router.connect(user).createTimelock(regular([{ tokenAddress: usdt.address, amount: 100_000_000 }], 86400));
    assert.equal((await usdt.balanceOf(tlERC20.address)).toString(), "100000000");
  });

  it("classic create with no direct approval fails, same input via Permit2 succeeds (the UX win)", async function () {
    const { user, router, permit2Domain, usdt } = await loadFixture(deployFixture);

    let caught: any;
    try {
      await router.connect(user).createTimelock(regular([{ tokenAddress: usdt.address, amount: 100_000_000 }], 86400));
    } catch (e) {
      caught = e;
    }
    assert(caught, "classic path must fail without a direct approve");

    const bundle = await signPermitBatch(user, permit2Domain, [usdt.address], router.address);
    await router.connect(user).createTimelockWithPermit2(regular([{ tokenAddress: usdt.address, amount: 100_000_000 }], 86400), {
      permitBatch: bundle.permitBatch,
      signature: bundle.signature,
    });
  });

  it("soft timelock via Permit2: create, unlock, buffered withdraw", async function () {
    const { user, router, tlERC20, permit2Domain, usdt } = await loadFixture(deployFixture);

    const bundle = await signPermitBatch(user, permit2Domain, [usdt.address], router.address);
    await router.connect(user).createSoftTimelockWithPermit2(
      {
        timelockETHSwap: NO_SWAP,
        timelockERC20: [{ tokenAddress: usdt.address, amount: 100_000_000 }],
        timelockERC721: [],
        timelockERC1155: [],
        bufferTime: 3600,
        name: "soft",
      },
      { permitBatch: bundle.permitBatch, signature: bundle.signature }
    );
    assert.equal((await usdt.balanceOf(tlERC20.address)).toString(), "100000000");

    await router.connect(user).unlockSoftTimelock(1);
    await increase(3600 + 1);
    await router.connect(user)["withdraw(uint256,bool)"](1, true);
    assert.equal((await usdt.balanceOf(user.address)).toString(), "1000000000");
  });

  it("gift via Permit2: creator funds, recipient withdraws after the lock", async function () {
    const { user, recipient, router, tlERC20, permit2Domain, usdc } = await loadFixture(deployFixture);

    const bundle = await signPermitBatch(user, permit2Domain, [usdc.address], router.address);
    await router.connect(user).createTimelockedGiftWithPermit2(
      {
        timelockETHSwap: NO_SWAP,
        timelockERC20: [{ tokenAddress: usdc.address, amount: 50_000_000 }],
        timelockERC721: [],
        timelockERC1155: [],
        duration: 86400,
        recipient: recipient.address,
        name: "gift",
        giftName: "for-you",
      },
      { permitBatch: bundle.permitBatch, signature: bundle.signature }
    );
    assert.equal((await usdc.balanceOf(tlERC20.address)).toString(), "50000000");

    await increase(86400 + 1);
    await router.connect(recipient)["withdraw(uint256,bool)"](1, true);
    assert.equal((await usdc.balanceOf(recipient.address)).toString(), "50000000");
  });
});

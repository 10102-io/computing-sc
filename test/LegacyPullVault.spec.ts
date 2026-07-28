import { ethers, artifacts } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { genMessage } from "../scripts/utils/genMsg";
import { deployProxy } from "./utils/proxy";
import { wireRouters } from "./fixtures/wiring";

// LegacyPullVault (docs/plans/legacy-pull-vault.md) — the single, permanent,
// admin-free Permit2 spender for EOA transfer legacies. Creators sign their
// AllowanceTransfer batch for the VAULT (a deployed, verifiable contract —
// no more "untrusted EOA spender" wallet interstitials), and the vault only
// honors pulls from the exact legacy clone bound to each owner.

const uniRouter = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
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

function revertedWith(err: any, signature: string): boolean {
  const selector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(signature)).slice(0, 10).toLowerCase();
  const blob = ((err?.message ?? "") + " " + JSON.stringify(err ?? "") + " " + (err?.data ?? "") + " " + (err?.error?.message ?? "")).toLowerCase();
  return blob.includes(signature.toLowerCase()) || blob.includes(selector);
}

describe("LegacyPullVault — verified singleton Permit2 spender", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [treasury, dev, user1, user2, owner, bene, bene2, attacker] = await ethers.getSigners();

    const mockArtifact = await artifacts.readArtifact("MockPermit2");
    await ethers.provider.send("hardhat_setCode", [PERMIT2_ADDRESS, mockArtifact.deployedBytecode]);
    const permit2 = await ethers.getContractAt("MockPermit2", PERMIT2_ADDRESS);

    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    const usdc = await ERC20.deploy("USDC", "USDC", 6);

    const premiumSetting = await deployProxy("PremiumSetting", [], "initialize", dev);
    const Payment = await ethers.getContractFactory("Payment");
    const payment = await Payment.deploy();

    const premiumRegistry = await deployProxy(
      "PremiumRegistry",
      [
        usdt.address,
        usdc.address,
        "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
        "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
        "0x694AA1769357215DE4FAC081bf1f309aDC325306",
        premiumSetting.address,
        payment.address,
      ],
      "initialize",
      dev
    );

    const verifierTerm = await deployProxy("EIP712LegacyVerifier", [dev.address]);
    const legacyDeployer = await deployProxy("LegacyDeployer");

    const transferEOALegacyRouter = await deployProxy("TransferEOALegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
      payment.address,
      uniRouter,
      weth,
    ]);
    await transferEOALegacyRouter.connect(dev).initializeV2(dev.address);

    const multisigLegacyRouter = await deployProxy("MultisigLegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
    ]);

    await wireRouters({
      admin: dev,
      legacyDeployerAdmin: treasury,
      premiumSetting,
      premiumRegistry,
      legacyDeployer,
      verifierTerm,
      transferEOALegacyRouter,
      multisigLegacyRouter,
    });

    const TransferEOALegacy = await ethers.getContractFactory("TransferEOALegacy");
    const legacyImpl = await TransferEOALegacy.deploy();
    await transferEOALegacyRouter.connect(dev).setLegacyImplementation(legacyImpl.address);

    // The vault: pinned to (router proxy, clone implementation) and wired in.
    const Vault = await ethers.getContractFactory("LegacyPullVault");
    const vault = await Vault.deploy(transferEOALegacyRouter.address, legacyImpl.address);
    await transferEOALegacyRouter.connect(dev).setPullVault(vault.address);

    await usdt.mint(owner.address, 1_000_000_000); // 1,000 USDT (6dp)
    await usdc.mint(owner.address, 500_000_000); // 500 USDC (6dp)
    await usdt.connect(owner).approve(PERMIT2_ADDRESS, ethers.constants.MaxUint256);
    await usdc.connect(owner).approve(PERMIT2_ADDRESS, ethers.constants.MaxUint256);

    const network = await ethers.provider.getNetwork();
    const permit2Domain = { name: "Permit2", chainId: network.chainId, verifyingContract: PERMIT2_ADDRESS };

    return {
      treasury, dev, owner, bene, bene2, attacker,
      transferEOALegacyRouter, legacyImpl, vault, permit2, permit2Domain, usdt, usdc,
    };
  }

  async function signPermitBatch(signer: any, domain: any, tokens: string[], spender: string, opts: any = {}) {
    const now = await currentTime();
    const details = tokens.map((t) => ({
      token: t,
      amount: opts.amount ?? ethers.BigNumber.from(2).pow(160).sub(1),
      expiration: opts.expiration ?? now + 10 * 365 * 86400,
      nonce: opts.nonce ?? 0,
    }));
    const permitBatch = { details, spender, sigDeadline: opts.sigDeadline ?? now + 1800 };
    const signature = await (opts.signWith ?? signer)._signTypedData(domain, PERMIT_BATCH_TYPES, permitBatch);
    return { permitBatch, signature };
  }

  async function createV2(router: any, ownerSigner: any, distributions: any[], bundle: any) {
    const extraConfig = { lackOfOutgoingTxRange: 86400, delayLayer2: 0, delayLayer3: 0 };
    const zero = { user: ethers.constants.AddressZero, percent: 0 };
    const predicted: string = await router.getNextLegacyAddress(ownerSigner.address);
    const ts = await currentTime();
    const sig = await ownerSigner.signMessage(await genMessage(ts));
    await router.connect(ownerSigner).createLegacyV2(distributions, extraConfig, zero, zero, bundle, ts, sig);
    const legacy = await ethers.getContractAt("TransferEOALegacy", predicted);
    const legacyId = (await legacy.getLegacyInfo())[0];
    return { legacy, legacyId, predicted };
  }

  async function impersonatedRouter(routerAddress: string) {
    await ethers.provider.send("hardhat_impersonateAccount", [routerAddress]);
    await ethers.provider.send("hardhat_setBalance", [routerAddress, "0x1000000000000000000"]);
    return ethers.getSigner(routerAddress);
  }

  it("create with the vault as spender: binds owner→legacy and the claim pulls through the vault", async function () {
    const { owner, bene, bene2, transferEOALegacyRouter, vault, permit2, permit2Domain, usdt, usdc } =
      await loadFixture(deployFixture);

    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address, usdc.address], vault.address);
    const distributions = [
      { user: bene.address, percent: 600000 }, // 60%
      { user: bene2.address, percent: 400000 }, // 40%
    ];
    const { legacy, legacyId } = await createV2(transferEOALegacyRouter, owner, distributions, bundle);

    // Binding registered; allowance names the VAULT (deployed, verifiable),
    // never the counterfactual clone.
    assert.equal(await vault.boundLegacy(owner.address), legacy.address);
    const [vaultAmount] = await permit2.allowance(owner.address, usdt.address, vault.address);
    assert(vaultAmount.gt(0), "Permit2 allowance should name the vault as spender");
    const [cloneAmount] = await permit2.allowance(owner.address, usdt.address, legacy.address);
    assert.equal(cloneAmount.toString(), "0", "no per-clone allowance should exist");

    await increase(86400 + 1);
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address, usdc.address], false);

    assert.equal((await usdt.balanceOf(bene.address)).toString(), "600000000");
    assert.equal((await usdt.balanceOf(bene2.address)).toString(), "400000000");
    assert.equal((await usdc.balanceOf(bene.address)).toString(), "300000000");
    assert.equal((await usdc.balanceOf(bene2.address)).toString(), "200000000");
    assert.equal((await usdt.balanceOf(owner.address)).toString(), "0");
  });

  it("pre-vault frontends: spender = the predicted clone still works end-to-end", async function () {
    const { owner, bene, transferEOALegacyRouter, permit2Domain, usdt } = await loadFixture(deployFixture);

    const predicted: string = await transferEOALegacyRouter.getNextLegacyAddress(owner.address);
    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address], predicted);
    const { legacyId } = await createV2(transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], bundle);

    await increase(86400 + 1);
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address], false);
    assert.equal((await usdt.balanceOf(bene.address)).toString(), "1000000000");
  });

  it("rejects a bundle whose spender is neither the vault nor the new legacy", async function () {
    const { owner, bene, attacker, transferEOALegacyRouter, permit2Domain, usdt } = await loadFixture(deployFixture);

    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address], attacker.address);
    let caught: any;
    try {
      await createV2(transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], bundle);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected spender mismatch to revert");
    assert(revertedWith(caught, "Permit2SpenderMismatch()"), `got: ${caught?.message}`);
  });

  it("bind is router-gated", async function () {
    const { attacker, owner, vault } = await loadFixture(deployFixture);
    let caught: any;
    try {
      await vault.connect(attacker).bind(owner.address, attacker.address);
    } catch (e) {
      caught = e;
    }
    assert(caught && revertedWith(caught, "OnlyRouter()"), `got: ${caught?.message}`);
  });

  it("bind rejects anything that is not a genuine clone of the pinned implementation", async function () {
    const { owner, attacker, transferEOALegacyRouter, legacyImpl, vault } = await loadFixture(deployFixture);
    const routerSigner = await impersonatedRouter(transferEOALegacyRouter.address);

    // An EOA (no code) — the exact shape a counterfactual/drainer target has.
    let caught: any;
    try {
      await vault.connect(routerSigner).bind(owner.address, attacker.address);
    } catch (e) {
      caught = e;
    }
    assert(caught && revertedWith(caught, "NotPinnedClone()"), `EOA: got ${caught?.message}`);

    // A full contract that isn't an EIP-1167 clone of the implementation.
    caught = undefined;
    try {
      await vault.connect(routerSigner).bind(owner.address, legacyImpl.address);
    } catch (e) {
      caught = e;
    }
    assert(caught && revertedWith(caught, "NotPinnedClone()"), `impl: got ${caught?.message}`);
  });

  it("bind verifies the clone's recorded owner and refuses to replace a live binding", async function () {
    const { owner, attacker, transferEOALegacyRouter, vault, permit2Domain, usdt } = await loadFixture(deployFixture);
    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address], vault.address);
    const { legacy } = await createV2(transferEOALegacyRouter, owner, [{ user: attacker.address, percent: 1000000 }], bundle);

    const routerSigner = await impersonatedRouter(transferEOALegacyRouter.address);

    // Genuine clone, wrong owner claim.
    let caught: any;
    try {
      await vault.connect(routerSigner).bind(attacker.address, legacy.address);
    } catch (e) {
      caught = e;
    }
    assert(caught && revertedWith(caught, "OwnerMismatch()"), `got: ${caught?.message}`);

    // Re-binding over a LIVE legacy must fail even for the router.
    caught = undefined;
    try {
      await vault.connect(routerSigner).bind(owner.address, legacy.address);
    } catch (e) {
      caught = e;
    }
    assert(caught && revertedWith(caught, "AlreadyBound()"), `got: ${caught?.message}`);
  });

  it("pull is bound-legacy-gated", async function () {
    const { owner, attacker, vault, usdt } = await loadFixture(deployFixture);
    let caught: any;
    try {
      await vault.connect(attacker).pull(owner.address, usdt.address, attacker.address, 1);
    } catch (e) {
      caught = e;
    }
    assert(caught && revertedWith(caught, "OnlyBoundLegacy()"), `got: ${caught?.message}`);
  });

  it("delete releases the binding and the owner can create + bind again", async function () {
    const { owner, bene, transferEOALegacyRouter, vault, permit2Domain, usdt } = await loadFixture(deployFixture);

    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address], vault.address);
    const { legacy, legacyId } = await createV2(transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], bundle);
    assert.equal(await vault.boundLegacy(owner.address), legacy.address);

    await transferEOALegacyRouter.connect(owner).deleteLegacy(legacyId);
    assert.equal(await vault.boundLegacy(owner.address), ethers.constants.AddressZero, "delete must release the binding");

    // Second create binds cleanly (nonce 1 for the same token in MockPermit2).
    const bundle2 = await signPermitBatch(owner, permit2Domain, [usdt.address], vault.address, { nonce: 1 });
    const { legacy: legacy2 } = await createV2(transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], bundle2);
    assert.equal(await vault.boundLegacy(owner.address), legacy2.address);
  });

  it("after a claim (tombstoned but never released) a new create replaces the binding", async function () {
    const { owner, bene, transferEOALegacyRouter, vault, permit2Domain, usdt, usdc } = await loadFixture(deployFixture);

    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address], vault.address);
    const { legacy, legacyId } = await createV2(transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], bundle);

    await increase(86400 + 1);
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address], false);
    // Claim released the router's create flag but the vault binding remains
    // (multi-tranche claims may still need it).
    assert.equal(await vault.boundLegacy(owner.address), legacy.address);

    const bundle2 = await signPermitBatch(owner, permit2Domain, [usdc.address], vault.address);
    const { legacy: legacy2 } = await createV2(transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], bundle2);
    assert.equal(await vault.boundLegacy(owner.address), legacy2.address, "non-live binding must be replaceable");
  });

  it("owner revokes via Permit2 lockdown on the vault — claim skips gracefully, custody preserved", async function () {
    const { owner, bene, transferEOALegacyRouter, vault, permit2, permit2Domain, usdt } = await loadFixture(deployFixture);

    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address], vault.address);
    const { legacyId } = await createV2(transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], bundle);

    await permit2.connect(owner).lockdown([{ token: usdt.address, spender: vault.address }]);

    await increase(86400 + 1);
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address], false);
    assert.equal((await usdt.balanceOf(bene.address)).toString(), "0", "revoked token must not move");
    assert.equal((await usdt.balanceOf(owner.address)).toString(), "1000000000", "owner keeps custody");
  });

  it("mixed rails: one token direct-approved to the clone, one signed for the vault — both distributed", async function () {
    const { owner, bene, transferEOALegacyRouter, vault, permit2Domain, usdt, usdc } = await loadFixture(deployFixture);

    const bundle = await signPermitBatch(owner, permit2Domain, [usdc.address], vault.address);
    const { legacy, legacyId } = await createV2(transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], bundle);
    await usdt.connect(owner).approve(legacy.address, ethers.constants.MaxUint256);

    await increase(86400 + 1);
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address, usdc.address], false);
    assert.equal((await usdt.balanceOf(bene.address)).toString(), "1000000000");
    assert.equal((await usdc.balanceOf(bene.address)).toString(), "500000000");
  });

  it("vault unset (address(0)): creates fall back to per-clone spender semantics", async function () {
    const { dev, owner, bene, transferEOALegacyRouter, permit2Domain, usdt } = await loadFixture(deployFixture);
    await transferEOALegacyRouter.connect(dev).setPullVault(ethers.constants.AddressZero);

    const predicted: string = await transferEOALegacyRouter.getNextLegacyAddress(owner.address);
    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address], predicted);
    const { legacyId } = await createV2(transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], bundle);

    await increase(86400 + 1);
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address], false);
    assert.equal((await usdt.balanceOf(bene.address)).toString(), "1000000000");
  });

  it("empty bundle + vault wired: still binds, and a later direct vault-spender approval is claimable", async function () {
    const { owner, bene, transferEOALegacyRouter, vault, permit2, permit2Domain, usdt } = await loadFixture(deployFixture);

    const { legacy, legacyId } = await createV2(
      transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], EMPTY_BUNDLE
    );
    assert.equal(await vault.boundLegacy(owner.address), legacy.address, "binding must not depend on the permit bundle");

    // Owner tops up coverage later with a plain Permit2 approve to the vault
    // (one tx, no signature dance) — exactly the future top-up UX.
    const now = await currentTime();
    await permit2.connect(owner).approve(usdt.address, vault.address, ethers.BigNumber.from(2).pow(160).sub(1), now + 10 * 365 * 86400);

    await increase(86400 + 1);
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address], false);
    assert.equal((await usdt.balanceOf(bene.address)).toString(), "1000000000");
  });
});

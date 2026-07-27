import { ethers, artifacts } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { genMessage } from "../scripts/utils/genMsg";
import { deployProxy } from "./utils/proxy";
import { wireRouters } from "./fixtures/wiring";

// Create-flow v2 — Permit2 single-confirm create (docs/plans/create-flow-v2.md §6.8).
// `createLegacyV2` registers the creator's signed AllowanceTransfer batch in
// Permit2 (one off-chain signature replaces N approve txs); at claim time the
// clone pulls tokens from the owner's wallet through Permit2 exactly like it
// pulls through direct ERC-20 allowances. Custody never moves before claim.
//
// The router/clone hardcode the canonical Permit2 address, so the fixture
// installs MockPermit2's runtime bytecode there via hardhat_setCode. The mock
// is EIP-712-faithful (same domain + typehashes as real Permit2), so the
// typed-data payloads signed below are exactly production-shaped.

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

describe("TransferEOALegacyRouter — createLegacyV2 (Permit2 single-confirm create)", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [treasury, dev, user1, user2, owner, bene, bene2, attacker] = await ethers.getSigners();

    // Canonical-address trick: put the mock's runtime bytecode where the
    // contracts' hardcoded PERMIT2 constant points.
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

    // Owner's claimable holdings — never approved to any dapp directly.
    await usdt.mint(owner.address, 1_000_000_000); // 1,000 USDT (6dp)
    await usdc.mint(owner.address, 500_000_000); // 500 USDC (6dp)

    // The one-time ecosystem-standard `approve(Permit2, max)` per token
    // (create-flow-v2.md §6.7) — amortized across every Permit2-using dapp;
    // per-legacy consent is the signed permit batch, not this approval.
    await usdt.connect(owner).approve(PERMIT2_ADDRESS, ethers.constants.MaxUint256);
    await usdc.connect(owner).approve(PERMIT2_ADDRESS, ethers.constants.MaxUint256);

    const network = await ethers.provider.getNetwork();
    // Real Permit2 domain: name only, NO version field.
    const permit2Domain = { name: "Permit2", chainId: network.chainId, verifyingContract: PERMIT2_ADDRESS };

    return { treasury, dev, owner, bene, bene2, attacker, transferEOALegacyRouter, permit2, permit2Domain, usdt, usdc };
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

  // Single-confirm create: TOS signature + Permit2 batch signature + one tx.
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

  it("creates with zero approve txs and the claim pulls tokens through Permit2", async function () {
    const { owner, bene, bene2, transferEOALegacyRouter, permit2, permit2Domain, usdt, usdc } =
      await loadFixture(deployFixture);

    const predicted: string = await transferEOALegacyRouter.getNextLegacyAddress(owner.address);
    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address, usdc.address], predicted);
    const distributions = [
      { user: bene.address, percent: 600000 }, // 60%
      { user: bene2.address, percent: 400000 }, // 40%
    ];
    const { legacy, legacyId } = await createV2(transferEOALegacyRouter, owner, distributions, {
      permitBatch: bundle.permitBatch,
      signature: bundle.signature,
    });

    // Allowances landed in Permit2 with the legacy as spender; no direct
    // ERC-20 approvals anywhere; PII-free (no name stored).
    const [amount] = await permit2.allowance(owner.address, usdt.address, legacy.address);
    assert(amount.gt(0), "Permit2 allowance should be registered for the legacy");
    assert.equal((await usdt.allowance(owner.address, legacy.address)).toString(), "0");
    assert.equal(await legacy.getLegacyName(), "", "v2 create must not store a legacy name");

    await increase(86400 + 1);
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address, usdc.address], false);

    // 60/40 split of 1,000 USDT + 500 USDC, straight from the owner's wallet.
    assert.equal((await usdt.balanceOf(bene.address)).toString(), "600000000");
    assert.equal((await usdt.balanceOf(bene2.address)).toString(), "400000000");
    assert.equal((await usdc.balanceOf(bene.address)).toString(), "300000000");
    assert.equal((await usdc.balanceOf(bene2.address)).toString(), "200000000");
    assert.equal((await usdt.balanceOf(owner.address)).toString(), "0");
  });

  it("rejects a bundle whose spender is not the new legacy", async function () {
    const { owner, bene, attacker, transferEOALegacyRouter, permit2Domain, usdt } = await loadFixture(deployFixture);

    // Signed for the attacker as spender — router must refuse to register it.
    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address], attacker.address);
    let caught: any;
    try {
      await createV2(transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], {
        permitBatch: bundle.permitBatch,
        signature: bundle.signature,
      });
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected spender mismatch to revert");
    assert(revertedWith(caught, "Permit2SpenderMismatch()"), `got: ${caught?.message}`);
  });

  it("rejects a permit batch signed by someone other than the creator", async function () {
    const { owner, bene, attacker, transferEOALegacyRouter, permit2Domain, usdt } = await loadFixture(deployFixture);

    const predicted: string = await transferEOALegacyRouter.getNextLegacyAddress(owner.address);
    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address], predicted, { signWith: attacker });
    let caught: any;
    try {
      await createV2(transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], {
        permitBatch: bundle.permitBatch,
        signature: bundle.signature,
      });
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected foreign signature to revert");
    assert(revertedWith(caught, "InvalidSigner()"), `got: ${caught?.message}`);
  });

  it("empty bundle opts out — direct ERC-20 approvals still work end-to-end", async function () {
    const { owner, bene, transferEOALegacyRouter, usdt } = await loadFixture(deployFixture);

    const { legacy, legacyId } = await createV2(
      transferEOALegacyRouter,
      owner,
      [{ user: bene.address, percent: 1000000 }],
      EMPTY_BUNDLE
    );
    await usdt.connect(owner).approve(legacy.address, ethers.constants.MaxUint256);

    await increase(86400 + 1);
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address], false);
    assert.equal((await usdt.balanceOf(bene.address)).toString(), "1000000000");
  });

  it("mixed authorization: one token direct-approved, one via Permit2 — both distributed", async function () {
    const { owner, bene, transferEOALegacyRouter, permit2Domain, usdt, usdc } = await loadFixture(deployFixture);

    const predicted: string = await transferEOALegacyRouter.getNextLegacyAddress(owner.address);
    const bundle = await signPermitBatch(owner, permit2Domain, [usdc.address], predicted);
    const { legacy, legacyId } = await createV2(
      transferEOALegacyRouter,
      owner,
      [{ user: bene.address, percent: 1000000 }],
      { permitBatch: bundle.permitBatch, signature: bundle.signature }
    );
    await usdt.connect(owner).approve(legacy.address, ethers.constants.MaxUint256);

    await increase(86400 + 1);
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address, usdc.address], false);
    assert.equal((await usdt.balanceOf(bene.address)).toString(), "1000000000");
    assert.equal((await usdc.balanceOf(bene.address)).toString(), "500000000");
  });

  it("owner can revoke via Permit2 lockdown — claim skips the token gracefully, custody preserved", async function () {
    const { owner, bene, transferEOALegacyRouter, permit2, permit2Domain, usdt } = await loadFixture(deployFixture);

    const predicted: string = await transferEOALegacyRouter.getNextLegacyAddress(owner.address);
    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address], predicted);
    const { legacy, legacyId } = await createV2(
      transferEOALegacyRouter,
      owner,
      [{ user: bene.address, percent: 1000000 }],
      { permitBatch: bundle.permitBatch, signature: bundle.signature }
    );

    // Owner changes their mind — Permit2's standard mass-revocation.
    await permit2.connect(owner).lockdown([{ token: usdt.address, spender: legacy.address }]);

    await increase(86400 + 1);
    // Claim must not revert; the token simply isn't pullable anymore.
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address], false);
    assert.equal((await usdt.balanceOf(bene.address)).toString(), "0", "revoked token must not move");
    assert.equal((await usdt.balanceOf(owner.address)).toString(), "1000000000", "owner keeps custody");
  });

  it("expired Permit2 allowance is skipped gracefully at claim", async function () {
    const { owner, bene, transferEOALegacyRouter, permit2Domain, usdt } = await loadFixture(deployFixture);

    const now = await currentTime();
    const predicted: string = await transferEOALegacyRouter.getNextLegacyAddress(owner.address);
    // Expires before the inactivity trigger can possibly fire.
    const bundle = await signPermitBatch(owner, permit2Domain, [usdt.address], predicted, {
      expiration: now + 3600,
    });
    const { legacyId } = await createV2(transferEOALegacyRouter, owner, [{ user: bene.address, percent: 1000000 }], {
      permitBatch: bundle.permitBatch,
      signature: bundle.signature,
    });

    await increase(86400 + 1);
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address], false);
    assert.equal((await usdt.balanceOf(bene.address)).toString(), "0", "expired allowance must not be usable");
    assert.equal((await usdt.balanceOf(owner.address)).toString(), "1000000000");
  });
});

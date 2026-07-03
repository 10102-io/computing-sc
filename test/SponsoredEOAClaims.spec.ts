import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { genMessage } from "../scripts/utils/genMsg";
import { deployProxy } from "./utils/proxy";
import { wireRouters } from "./fixtures/wiring";

// Create-flow v2 — sponsored ("…For") entrypoints (docs/plans/create-flow-v2.md §12a).
// A relayer pays gas to submit a beneficiary's signed claim / an owner's signed
// check-in; identity is the recovered EIP-712 signer, never msg.sender.

const uniRouter = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";

function revertedWith(err: any, signature: string): boolean {
  const selector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(signature)).slice(0, 10).toLowerCase();
  const blob = ((err?.message ?? "") + " " + JSON.stringify(err ?? "") + " " + (err?.data ?? "") + " " + (err?.error?.message ?? "")).toLowerCase();
  return blob.includes(signature.toLowerCase()) || blob.includes(selector);
}

const CLAIM_TYPES = {
  ClaimAuth: [
    { name: "beneficiary", type: "address" },
    { name: "legacyId", type: "uint256" },
    { name: "assetsHash", type: "bytes32" },
    { name: "isETH", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
const CHECKIN_TYPES = {
  CheckInAuth: [
    { name: "owner", type: "address" },
    { name: "legacyId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

describe("TransferEOALegacyRouter — sponsored (…For) entrypoints", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [treasury, dev, user1, user2, owner, bene, relayer, attacker, owner2] =
      await ethers.getSigners();

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

    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "10102 Legacy Sponsored",
      version: "1",
      chainId: network.chainId,
      verifyingContract: transferEOALegacyRouter.address,
    };

    return { treasury, dev, owner, bene, relayer, attacker, owner2, transferEOALegacyRouter, domain };
  }

  // Create a non-premium single-beneficiary EOA legacy owned by `ownerSigner`,
  // with `beneSigner` as the sole layer-1 beneficiary. Returns the legacy
  // address + numeric id.
  async function createNonPremiumLegacy(router_: any, ownerSigner: any, beneSigner: any) {
    const mainConfig = {
      name: "sponsored-legacy",
      note: "",
      nickNames: ["b"],
      distributions: [{ user: beneSigner.address, percent: 1000000 }],
    };
    const extraConfig = { lackOfOutgoingTxRange: 86400, delayLayer2: 0, delayLayer3: 0 };
    const zero = { user: ethers.constants.AddressZero, percent: 0 };

    const predicted: string = await router_.getNextLegacyAddress(ownerSigner.address);
    const ts = await currentTime();
    const sig = await ownerSigner.signMessage(await genMessage(ts));
    await router_
      .connect(ownerSigner)
      .createLegacy(mainConfig, extraConfig, zero, zero, "", "", ts, sig);

    const legacy = await ethers.getContractAt("TransferEOALegacy", predicted);
    const legacyId = (await legacy.getLegacyInfo())[0];
    return { legacy, legacyId, predicted };
  }

  it("relays a beneficiary's signed claim — funds go to the beneficiary, relayer pays gas", async function () {
    const { owner, bene, relayer, transferEOALegacyRouter, domain } = await loadFixture(deployFixture);
    const { legacyId, predicted } = await createNonPremiumLegacy(transferEOALegacyRouter, owner, bene);

    await owner.sendTransaction({ to: predicted, value: ethers.utils.parseEther("1") });
    await increase(86400 + 1);

    const assets: string[] = [];
    const assetsHash = ethers.utils.solidityKeccak256(["address[]"], [assets]);
    const deadline = (await currentTime()) + 3600;
    const value = {
      beneficiary: bene.address,
      legacyId,
      assetsHash,
      isETH: true,
      nonce: 0,
      deadline,
    };
    const signature = await bene._signTypedData(domain, CLAIM_TYPES, value);
    const auth = { beneficiary: bene.address, nonce: 0, deadline, signature };

    const beneBefore = await ethers.provider.getBalance(bene.address);
    const tx = await transferEOALegacyRouter.connect(relayer).activeLegacyFor(legacyId, assets, true, auth);
    await tx.wait();

    const beneAfter = await ethers.provider.getBalance(bene.address);
    // Beneficiary received ~1 ETH without sending any tx of their own.
    assert(beneAfter.sub(beneBefore).eq(ethers.utils.parseEther("1")), "beneficiary should receive the full balance");
    assert.equal((await ethers.provider.getBalance(predicted)).toString(), "0", "legacy should be drained");
    assert.equal((await transferEOALegacyRouter.sponsorNonce(bene.address)).toString(), "1", "nonce should advance");
  });

  it("relays an owner's signed check-in — resets the inactivity timer", async function () {
    const { owner, bene, relayer, transferEOALegacyRouter, domain } = await loadFixture(deployFixture);
    const { legacy, legacyId } = await createNonPremiumLegacy(transferEOALegacyRouter, owner, bene);

    const before = await legacy.getLastTimestamp();
    await increase(500);

    const deadline = (await currentTime()) + 3600;
    const value = { owner: owner.address, legacyId, nonce: 0, deadline };
    const signature = await owner._signTypedData(domain, CHECKIN_TYPES, value);
    const auth = { owner: owner.address, nonce: 0, deadline, signature };

    await transferEOALegacyRouter.connect(relayer).activeAliveFor(legacyId, auth);

    const after = await legacy.getLastTimestamp();
    assert(after.gt(before), "check-in should bump the activity timestamp");
    assert.equal((await transferEOALegacyRouter.sponsorNonce(owner.address)).toString(), "1");
  });

  it("rejects a replayed authorization (nonce already consumed)", async function () {
    const { owner, bene, relayer, transferEOALegacyRouter, domain } = await loadFixture(deployFixture);
    const { legacyId } = await createNonPremiumLegacy(transferEOALegacyRouter, owner, bene);

    const deadline = (await currentTime()) + 3600;
    const value = { owner: owner.address, legacyId, nonce: 0, deadline };
    const signature = await owner._signTypedData(domain, CHECKIN_TYPES, value);
    const auth = { owner: owner.address, nonce: 0, deadline, signature };

    await transferEOALegacyRouter.connect(relayer).activeAliveFor(legacyId, auth);

    let caught: any;
    try {
      await transferEOALegacyRouter.connect(relayer).activeAliveFor(legacyId, auth);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected replay revert");
    assert(revertedWith(caught, "InvalidSponsorNonce()"), `got: ${caught?.message}`);
  });

  it("rejects a signature from someone other than the asserted signer", async function () {
    const { owner, bene, relayer, attacker, transferEOALegacyRouter, domain } = await loadFixture(deployFixture);
    const { legacyId } = await createNonPremiumLegacy(transferEOALegacyRouter, owner, bene);

    const deadline = (await currentTime()) + 3600;
    const value = { owner: owner.address, legacyId, nonce: 0, deadline };
    // Attacker signs, but auth claims the owner is the signer.
    const signature = await attacker._signTypedData(domain, CHECKIN_TYPES, value);
    const auth = { owner: owner.address, nonce: 0, deadline, signature };

    let caught: any;
    try {
      await transferEOALegacyRouter.connect(relayer).activeAliveFor(legacyId, auth);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected signature-mismatch revert");
    assert(revertedWith(caught, "InvalidSponsorSignature()"), `got: ${caught?.message}`);
  });

  it("rejects an expired authorization", async function () {
    const { owner, bene, relayer, transferEOALegacyRouter, domain } = await loadFixture(deployFixture);
    const { legacyId } = await createNonPremiumLegacy(transferEOALegacyRouter, owner, bene);

    const deadline = (await currentTime()) - 1; // already in the past
    const value = { owner: owner.address, legacyId, nonce: 0, deadline };
    const signature = await owner._signTypedData(domain, CHECKIN_TYPES, value);
    const auth = { owner: owner.address, nonce: 0, deadline, signature };

    let caught: any;
    try {
      await transferEOALegacyRouter.connect(relayer).activeAliveFor(legacyId, auth);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected expiry revert");
    assert(revertedWith(caught, "SponsorshipExpired()"), `got: ${caught?.message}`);
  });

  it("on-chain domain separator matches the EIP-712 domain clients sign against", async function () {
    const { transferEOALegacyRouter, domain } = await loadFixture(deployFixture);
    const onchain: string = await transferEOALegacyRouter.sponsoredDomainSeparator();
    const expected = ethers.utils._TypedDataEncoder.hashDomain(domain);
    assert.equal(onchain.toLowerCase(), expected.toLowerCase());
  });

  it("ERC-5267 eip712Domain() is consistent with the domain separator", async function () {
    const { transferEOALegacyRouter } = await loadFixture(deployFixture);
    const [fields, name, version, chainId, verifyingContract, salt, extensions] =
      await transferEOALegacyRouter.eip712Domain();

    assert.equal(fields, "0x0f", "fields should advertise name+version+chainId+verifyingContract");
    assert.equal(salt, ethers.constants.HashZero);
    assert.equal(extensions.length, 0);

    // Rebuilding the domain purely from the ERC-5267 answer must reproduce
    // the on-chain separator — this is exactly what generic tooling will do.
    const rebuilt = ethers.utils._TypedDataEncoder.hashDomain({
      name,
      version,
      chainId,
      verifyingContract,
    });
    const onchain: string = await transferEOALegacyRouter.sponsoredDomainSeparator();
    assert.equal(rebuilt.toLowerCase(), onchain.toLowerCase());
  });

  it("rejects a relayer that tampers with the signed asset list", async function () {
    const { owner, bene, relayer, transferEOALegacyRouter, domain } = await loadFixture(deployFixture);
    const { legacyId, predicted } = await createNonPremiumLegacy(transferEOALegacyRouter, owner, bene);

    await owner.sendTransaction({ to: predicted, value: ethers.utils.parseEther("1") });
    await increase(86400 + 1);

    // Beneficiary signs an ETH-only claim (empty asset list) ...
    const signedAssets: string[] = [];
    const assetsHash = ethers.utils.solidityKeccak256(["address[]"], [signedAssets]);
    const deadline = (await currentTime()) + 3600;
    const value = { beneficiary: bene.address, legacyId, assetsHash, isETH: true, nonce: 0, deadline };
    const signature = await bene._signTypedData(domain, CLAIM_TYPES, value);
    const auth = { beneficiary: bene.address, nonce: 0, deadline, signature };

    // ... but the relayer submits a different asset list. The struct hash is
    // recomputed on-chain from the calldata assets, so the signature no longer
    // recovers to the beneficiary.
    const tampered = ["0x000000000000000000000000000000000000dEaD"];
    let caught: any;
    try {
      await transferEOALegacyRouter.connect(relayer).activeLegacyFor(legacyId, tampered, true, auth);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected tampered asset list to be rejected");
    assert(revertedWith(caught, "InvalidSponsorSignature()"), `got: ${caught?.message}`);
  });

  // ─── Nonce invalidation (cancel an outstanding signed intent) ─────────────

  it("invalidateSponsorNonce cancels an outstanding authorization; a fresh nonce works", async function () {
    const { owner, bene, relayer, transferEOALegacyRouter, domain } = await loadFixture(deployFixture);
    const { legacy, legacyId } = await createNonPremiumLegacy(transferEOALegacyRouter, owner, bene);

    // Owner signs a check-in with a long deadline, then changes their mind.
    const deadline = (await currentTime()) + 30 * 86400;
    const value = { owner: owner.address, legacyId, nonce: 0, deadline };
    const signature = await owner._signTypedData(domain, CHECKIN_TYPES, value);
    const auth = { owner: owner.address, nonce: 0, deadline, signature };

    const tx = await transferEOALegacyRouter.connect(owner).invalidateSponsorNonce();
    const receipt = await tx.wait();
    const evt = receipt.events?.find((e: any) => e.event === "SponsorNonceInvalidated");
    assert(evt, "expected SponsorNonceInvalidated event");
    assert.equal(evt.args.signer, owner.address);
    assert.equal(evt.args.invalidated.toString(), "0");
    assert.equal((await transferEOALegacyRouter.sponsorNonce(owner.address)).toString(), "1");

    // The cancelled intent is now permanently unusable.
    let caught: any;
    try {
      await transferEOALegacyRouter.connect(relayer).activeAliveFor(legacyId, auth);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected cancelled intent to be rejected");
    assert(revertedWith(caught, "InvalidSponsorNonce()"), `got: ${caught?.message}`);

    // A re-signed intent at the advanced nonce goes through.
    const before = await legacy.getLastTimestamp();
    await increase(500);
    const deadline2 = (await currentTime()) + 3600;
    const value2 = { owner: owner.address, legacyId, nonce: 1, deadline: deadline2 };
    const signature2 = await owner._signTypedData(domain, CHECKIN_TYPES, value2);
    await transferEOALegacyRouter
      .connect(relayer)
      .activeAliveFor(legacyId, { owner: owner.address, nonce: 1, deadline: deadline2, signature: signature2 });
    assert((await legacy.getLastTimestamp()).gt(before), "re-signed check-in should land");
  });

  // ─── Owner opt-out for sponsored claims (§12a "Founder review") ───────────

  // Build a valid layer-1 ETH claim authorization for `bene` on `legacyId`.
  async function buildClaimAuth(domain: any, bene: any, legacyId: any) {
    const assets: string[] = [];
    const assetsHash = ethers.utils.solidityKeccak256(["address[]"], [assets]);
    const deadline = (await currentTime()) + 3600;
    const value = { beneficiary: bene.address, legacyId, assetsHash, isETH: true, nonce: 0, deadline };
    const signature = await bene._signTypedData(domain, CLAIM_TYPES, value);
    return { assets, auth: { beneficiary: bene.address, nonce: 0, deadline, signature } };
  }

  it("owner can disable sponsored claims — relayed path reverts, direct claim still works", async function () {
    const { owner, bene, relayer, transferEOALegacyRouter, domain } = await loadFixture(deployFixture);
    const { legacyId, predicted } = await createNonPremiumLegacy(transferEOALegacyRouter, owner, bene);

    await owner.sendTransaction({ to: predicted, value: ethers.utils.parseEther("1") });
    await increase(86400 + 1);

    // Owner forbids third-party relaying.
    await transferEOALegacyRouter.connect(owner).setSponsoredClaimsEnabled(legacyId, false);
    assert.equal(await transferEOALegacyRouter.sponsoredClaimsDisabled(legacyId), true);

    const { assets, auth } = await buildClaimAuth(domain, bene, legacyId);
    let caught: any;
    try {
      await transferEOALegacyRouter.connect(relayer).activeLegacyFor(legacyId, assets, true, auth);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected sponsored claim to be rejected when disabled");
    assert(revertedWith(caught, "SponsoredClaimsDisabled()"), `got: ${caught?.message}`);

    // The always-available direct path is unaffected — the beneficiary self-claims.
    const beneBefore = await ethers.provider.getBalance(bene.address);
    const tx = await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, assets, true);
    await tx.wait();
    const beneAfter = await ethers.provider.getBalance(bene.address);
    assert(beneAfter.gt(beneBefore), "direct claim should still deliver funds to the beneficiary");
    assert.equal((await ethers.provider.getBalance(predicted)).toString(), "0", "legacy should be drained");
  });

  it("re-enabling sponsored claims restores the relayed path", async function () {
    const { owner, bene, relayer, transferEOALegacyRouter, domain } = await loadFixture(deployFixture);
    const { legacyId, predicted } = await createNonPremiumLegacy(transferEOALegacyRouter, owner, bene);

    await owner.sendTransaction({ to: predicted, value: ethers.utils.parseEther("1") });
    await increase(86400 + 1);

    await transferEOALegacyRouter.connect(owner).setSponsoredClaimsEnabled(legacyId, false);
    await transferEOALegacyRouter.connect(owner).setSponsoredClaimsEnabled(legacyId, true);
    assert.equal(await transferEOALegacyRouter.sponsoredClaimsDisabled(legacyId), false);

    const { assets, auth } = await buildClaimAuth(domain, bene, legacyId);
    await transferEOALegacyRouter.connect(relayer).activeLegacyFor(legacyId, assets, true, auth);
    assert.equal((await ethers.provider.getBalance(predicted)).toString(), "0", "legacy should be drained via relay");
  });

  it("only the legacy owner can toggle sponsored claims", async function () {
    const { owner, bene, attacker, transferEOALegacyRouter } = await loadFixture(deployFixture);
    const { legacyId } = await createNonPremiumLegacy(transferEOALegacyRouter, owner, bene);

    let caught: any;
    try {
      await transferEOALegacyRouter.connect(attacker).setSponsoredClaimsEnabled(legacyId, false);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected non-owner toggle to revert");
    assert(revertedWith(caught, "OnlyOwner()"), `got: ${caught?.message}`);
  });
});

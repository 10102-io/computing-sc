import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime } from "./utils/time";
import { genMessage } from "../scripts/utils/genMsg";
import { deployProxy } from "./utils/proxy";

// Versioned terms acceptance (deferred item `legacy-tos-version`).
// The verifier now binds each consent record to the exact ToS document in
// force at signing: the owner publishes {version tag, keccak256(document)},
// the user signs a message embedding the tag, and the contract snapshots the
// document hash per record. Old-format signatures keep working (dual-accept)
// and record a zero hash.

const TAG_V1 = "v2026-07";
const TAG_V2 = "v2026-12";
const HASH_V1 = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("full ToS document text v2026-07"));
const HASH_V2 = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("full ToS document text v2026-12"));
const ZERO32 = ethers.constants.HashZero;

function versionedMessage(tag: string, ts: number): string {
  return `By proceeding with creating a new contract, I agree to 10102's Terms of Service (version ${tag}) at timestamp ${ts}.`;
}

function revertedWith(err: any, signature: string): boolean {
  const selector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(signature)).slice(0, 10).toLowerCase();
  const blob = ((err?.message ?? "") + " " + JSON.stringify(err ?? "") + " " + (err?.data ?? "") + " " + (err?.error?.message ?? "")).toLowerCase();
  return blob.includes(signature.toLowerCase()) || blob.includes(selector);
}

describe("EIP712LegacyVerifier — versioned terms acceptance", function () {
  this.timeout(150000);

  async function fixture() {
    const [owner, router, user, mallory] = await ethers.getSigners();
    const verifier = await deployProxy("EIP712LegacyVerifier", [owner.address], "initialize", owner);
    // The onlyRouter gate just checks msg.sender against three stored
    // addresses — pointing one at an EOA lets us exercise the verifier in
    // isolation (router wiring itself is covered by the create-flow specs).
    await verifier.connect(owner).setRouterAddresses(router.address, router.address, router.address);
    const legacyAddress = ethers.Wallet.createRandom().address;
    return { verifier, owner, router, user, mallory, legacyAddress };
  }

  describe("setActiveTerms", () => {
    it("owner publishes terms; tag and hash readable, event fires", async () => {
      const { verifier, owner } = await loadFixture(fixture);
      const receipt = await (await verifier.connect(owner).setActiveTerms(TAG_V1, HASH_V1)).wait();
      const evt = receipt.events?.find((e: any) => e.event === "ActiveTermsUpdated");
      assert(evt, "expected ActiveTermsUpdated event");
      assert.equal(evt.args.termsVersion, TAG_V1);
      assert.equal(evt.args.termsHash, HASH_V1);
      assert.equal(await verifier.activeTermsVersion(), TAG_V1);
      assert.equal(await verifier.activeTermsHash(), HASH_V1);
      assert.equal(await verifier.termsVersionOf(HASH_V1), TAG_V1);
    });

    it("rejects non-owner", async () => {
      const { verifier, mallory } = await loadFixture(fixture);
      let caught: any = null;
      try {
        await verifier.connect(mallory).setActiveTerms(TAG_V1, HASH_V1);
      } catch (e) {
        caught = e;
      }
      assert(caught, "expected onlyOwner revert");
    });

    it("rejects a tag without a hash and a hash without a tag", async () => {
      const { verifier, owner } = await loadFixture(fixture);
      for (const [tag, hash] of [[TAG_V1, ZERO32], ["", HASH_V1]] as const) {
        let caught: any = null;
        try {
          await verifier.connect(owner).setActiveTerms(tag, hash);
        } catch (e) {
          caught = e;
        }
        assert(caught, "expected InvalidTerms revert");
        assert(revertedWith(caught, "InvalidTerms()"), `got: ${caught?.message}`);
      }
    });

    it("empty tag + zero hash disables versioning", async () => {
      const { verifier, owner } = await loadFixture(fixture);
      await verifier.connect(owner).setActiveTerms(TAG_V1, HASH_V1);
      await verifier.connect(owner).setActiveTerms("", ZERO32);
      assert.equal(await verifier.activeTermsHash(), ZERO32);
      const ts = await currentTime();
      assert.equal(await verifier.generateVersionedMessage(ts), await genMessage(ts));
    });
  });

  describe("storeLegacyAgreement — no active terms (pre-upgrade behavior)", () => {
    it("accepts the legacy message format and records a zero terms hash", async () => {
      const { verifier, router, user, legacyAddress } = await loadFixture(fixture);
      const ts = await currentTime();
      const sig = await user.signMessage(await genMessage(ts));
      const receipt = await (
        await verifier.connect(router).storeLegacyAgreement(user.address, legacyAddress, ts, sig)
      ).wait();
      assert(receipt.events?.some((e: any) => e.event === "LegacySigned"), "expected LegacySigned");
      assert(
        !receipt.events?.some((e: any) => e.event === "LegacySignedVersioned"),
        "should NOT emit LegacySignedVersioned without active terms"
      );
      assert.equal((await verifier.getUserLegacyCount(user.address)).toString(), "1");
      assert.equal(await verifier.getUserLegacyTermsHash(user.address, 0), ZERO32);
    });

    it("rejects a signature from a different wallet", async () => {
      const { verifier, router, user, mallory, legacyAddress } = await loadFixture(fixture);
      const ts = await currentTime();
      const sig = await mallory.signMessage(await genMessage(ts));
      let caught: any = null;
      try {
        await verifier.connect(router).storeLegacyAgreement(user.address, legacyAddress, ts, sig);
      } catch (e) {
        caught = e;
      }
      assert(caught, "expected signature-mismatch revert");
      assert(revertedWith(caught, "InvalidSignature()"), `got: ${caught?.message}`);
    });
  });

  describe("storeLegacyAgreement — versioned terms active", () => {
    it("accepts the versioned message, snapshots the document hash, emits both events", async () => {
      const { verifier, owner, router, user, legacyAddress } = await loadFixture(fixture);
      await verifier.connect(owner).setActiveTerms(TAG_V1, HASH_V1);
      const ts = await currentTime();
      const message = await verifier.generateVersionedMessage(ts);
      assert.equal(message, versionedMessage(TAG_V1, ts));
      const sig = await user.signMessage(message);
      const receipt = await (
        await verifier.connect(router).storeLegacyAgreement(user.address, legacyAddress, ts, sig)
      ).wait();
      assert(receipt.events?.some((e: any) => e.event === "LegacySigned"), "expected LegacySigned");
      const evt = receipt.events?.find((e: any) => e.event === "LegacySignedVersioned");
      assert(evt, "expected LegacySignedVersioned event");
      assert.equal(evt.args.user, user.address);
      assert.equal(evt.args.termsVersion, TAG_V1);
      assert.equal(evt.args.termsHash, HASH_V1);
      assert.equal(await verifier.getUserLegacyTermsHash(user.address, 0), HASH_V1);
      assert.equal(await verifier.signatureTermsHash(sig), HASH_V1);
    });

    it("still accepts the legacy message format (old frontends / stashed signatures), recorded unversioned", async () => {
      const { verifier, owner, router, user, legacyAddress } = await loadFixture(fixture);
      await verifier.connect(owner).setActiveTerms(TAG_V1, HASH_V1);
      const ts = await currentTime();
      const sig = await user.signMessage(await genMessage(ts));
      await verifier.connect(router).storeLegacyAgreement(user.address, legacyAddress, ts, sig);
      assert.equal((await verifier.getUserLegacyCount(user.address)).toString(), "1");
      assert.equal(await verifier.getUserLegacyTermsHash(user.address, 0), ZERO32);
    });

    it("rejects a versioned signature from a different wallet", async () => {
      const { verifier, owner, router, user, mallory, legacyAddress } = await loadFixture(fixture);
      await verifier.connect(owner).setActiveTerms(TAG_V1, HASH_V1);
      const ts = await currentTime();
      const sig = await mallory.signMessage(versionedMessage(TAG_V1, ts));
      let caught: any = null;
      try {
        await verifier.connect(router).storeLegacyAgreement(user.address, legacyAddress, ts, sig);
      } catch (e) {
        caught = e;
      }
      assert(caught, "expected signature-mismatch revert");
      assert(revertedWith(caught, "InvalidSignature()"), `got: ${caught?.message}`);
    });

    it("rejects signature replay", async () => {
      const { verifier, owner, router, user, legacyAddress } = await loadFixture(fixture);
      await verifier.connect(owner).setActiveTerms(TAG_V1, HASH_V1);
      const ts = await currentTime();
      const sig = await user.signMessage(versionedMessage(TAG_V1, ts));
      await verifier.connect(router).storeLegacyAgreement(user.address, legacyAddress, ts, sig);
      let caught: any = null;
      try {
        await verifier.connect(router).storeLegacyAgreement(user.address, legacyAddress, ts, sig);
      } catch (e) {
        caught = e;
      }
      assert(caught, "expected replay revert");
      assert(revertedWith(caught, "SignatureUsed()"), `got: ${caught?.message}`);
    });

    it("rejects a signature over a stale (rotated-out) version tag", async () => {
      const { verifier, owner, router, user, legacyAddress } = await loadFixture(fixture);
      await verifier.connect(owner).setActiveTerms(TAG_V1, HASH_V1);
      await verifier.connect(owner).setActiveTerms(TAG_V2, HASH_V2);
      const ts = await currentTime();
      const sig = await user.signMessage(versionedMessage(TAG_V1, ts));
      let caught: any = null;
      try {
        await verifier.connect(router).storeLegacyAgreement(user.address, legacyAddress, ts, sig);
      } catch (e) {
        caught = e;
      }
      assert(caught, "expected stale-version revert");
      assert(revertedWith(caught, "InvalidSignature()"), `got: ${caught?.message}`);
    });
  });

  describe("historical reconstruction across rotations", () => {
    it("getUserLegacy returns the exact historical message after terms rotate", async () => {
      const { verifier, owner, router, user, legacyAddress } = await loadFixture(fixture);
      await verifier.connect(owner).setActiveTerms(TAG_V1, HASH_V1);
      const ts1 = await currentTime();
      const sig1 = await user.signMessage(versionedMessage(TAG_V1, ts1));
      await verifier.connect(router).storeLegacyAgreement(user.address, legacyAddress, ts1, sig1);

      await verifier.connect(owner).setActiveTerms(TAG_V2, HASH_V2);
      const ts2 = await currentTime();
      const sig2 = await user.signMessage(versionedMessage(TAG_V2, ts2));
      await verifier.connect(router).storeLegacyAgreement(user.address, legacyAddress, ts2, sig2);

      const rec1 = await verifier.getUserLegacy(user.address, 0);
      const rec2 = await verifier.getUserLegacy(user.address, 1);
      assert.equal(rec1.message, versionedMessage(TAG_V1, ts1));
      assert.equal(rec2.message, versionedMessage(TAG_V2, ts2));
      // The returned message must actually verify against the stored signature.
      assert.equal(ethers.utils.verifyMessage(rec1.message, rec1.signature), user.address);
      assert.equal(ethers.utils.verifyMessage(rec2.message, rec2.signature), user.address);
      assert.equal(await verifier.getUserLegacyTermsHash(user.address, 0), HASH_V1);
      assert.equal(await verifier.getUserLegacyTermsHash(user.address, 1), HASH_V2);
    });

    it("getUserLegacy reconstructs unversioned records with the record's own timestamp (regression)", async () => {
      const { verifier, router, user, legacyAddress } = await loadFixture(fixture);
      const ts = await currentTime();
      const sig = await user.signMessage(await genMessage(ts));
      await verifier.connect(router).storeLegacyAgreement(user.address, legacyAddress, ts, sig);
      const rec = await verifier.getUserLegacy(user.address, 0);
      assert.equal(rec.message, await genMessage(ts));
      assert.equal(ethers.utils.verifyMessage(rec.message, rec.signature), user.address);
    });
  });
});

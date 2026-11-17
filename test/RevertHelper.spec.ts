import { ethers } from "hardhat";
import { strict as assert } from "node:assert";

import { revertedWith } from "./utils/revert";

// `revertedWith` is what every spec's revert-reason check rests on. Until
// 2026-11-16 the specs searched the whole error as JSON, and Hardhat's
// stack-trace frames carry the source text of each contract on the way, so a
// check passed for any error that source declares. These cases hold the helper
// to the revert that happened.

const selector = (signature: string) => ethers.utils.id(signature).slice(0, 10);

/** An error shaped like the one Hardhat's in-process network throws for a failed transaction. */
function hardhatError(signature: string, source: string) {
  return {
    message: `VM Exception while processing transaction: reverted with custom error '${signature}'`,
    data: selector(signature),
    transactionHash: ethers.constants.HashZero,
    stackTrace: [{ sourceReference: { sourceContent: source } }],
  };
}

describe("Test helper: revertedWith", function () {
  const SOURCE = "error OnlyBeneficaries(); error LayerInvalid(); error SenderIsCreatedLegacy(address); require(ok, 'blocked');";

  it("matches the custom error that was raised, and no other one the source declares", function () {
    const err = hardhatError("LayerInvalid()", SOURCE);
    assert.equal(revertedWith(err, "LayerInvalid()"), true);
    assert.equal(revertedWith(err, "OnlyBeneficaries()"), false);
    assert.equal(revertedWith(err, "SenderIsCreatedLegacy(address)"), false);
    assert.equal(revertedWith(err, "blocked"), false);
  });

  it("matches an error with arguments by its selector, wherever the return data sits", function () {
    const data = selector("SenderIsCreatedLegacy(address)") + "00".repeat(32);
    for (const err of [{ data }, { data: { data } }, { error: { data } }, { error: { data: { data } } }]) {
      assert.equal(revertedWith(err, "SenderIsCreatedLegacy(address)"), true);
      assert.equal(revertedWith(err, "SenderIsCreatedLegacy(uint256)"), false);
    }
  });

  it("falls back to the message when the error carries no return data", function () {
    const err = { message: "execution reverted: custom error 'LayerInvalid()'" };
    assert.equal(revertedWith(err, "LayerInvalid()"), true);
    assert.equal(revertedWith(err, "OnlyBeneficaries()"), false);
    assert.equal(revertedWith({ message: "reverted", data: "0x" }, "LayerInvalid()"), false);
  });

  it("matches a reason string by the message, never by the source", function () {
    const err = {
      message: "VM Exception while processing transaction: reverted with reason string 'blocked'",
      data: "0x08c379a0",
      stackTrace: [{ sourceReference: { sourceContent: "require(ok, 'not this one');" } }],
    };
    assert.equal(revertedWith(err, "blocked"), true);
    assert.equal(revertedWith(err, "not this one"), false);
  });

  it("holds against a real revert", async function () {
    const registry = await (await ethers.getContractFactory("QuantumRecoveryRegistry")).deploy();
    let caught: any;
    try {
      await registry.register(ethers.constants.HashZero, 0, ethers.constants.AddressZero);
    } catch (e) {
      caught = e;
    }
    assert(caught, "an empty digest is refused");
    assert.equal(revertedWith(caught, "EmptyDigest()"), true);
    // Named in the registry's source and in the error's stack trace, and not the revert.
    assert.equal(JSON.stringify(caught).includes("Registered"), true);
    assert.equal(revertedWith(caught, "Registered"), false);
    assert.equal(revertedWith(caught, "Registered()"), false);
  });
});

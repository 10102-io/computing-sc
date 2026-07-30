/**
 * Live-network smoke test for the LegacyPullVault + EOA auto-renew train.
 * Uses a FRESH throwaway owner wallet (funded from the deployer, refunded at
 * the end) so it never collides with the deployer's own one-legacy-per-owner
 * flag, and the REAL canonical Permit2 — no mocks.
 *
 * Flow:
 *   1. create fresh owner, fund it, mint public-mint R2USD, approve Permit2
 *   2. createLegacyV2 with the Permit2 batch naming the VAULT as spender
 *   3. assert: clone deployed at the predicted address, vault binding set,
 *      clone pinned the vault
 *   4. premium-subscribe the owner (admin path), owner opts into auto-renew
 *   5. attestor recordActivity → timer reset; replay + non-attestor rejected
 *   6. owner lowers the trigger to 60s, wait, beneficiary claims → tokens
 *      arrive through the VAULT rail on real Permit2
 *   7. refund leftover ETH
 *
 *   npx hardhat run scripts/smoke-vault-autorenew.ts --network sepolia
 */
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";
import { genMessage } from "./utils/genMsg";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MAX_UINT160 = ethers.BigNumber.from(2).pow(160).sub(1);
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
const PERMIT2_ABI = [
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ok(cond: boolean, label: string) {
  if (!cond) throw new Error(`SMOKE FAIL: ${label}`);
  console.log(`  OK: ${label}`);
}

async function expectRevert(promise: Promise<any>, selectorSig: string, label: string) {
  const selector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(selectorSig)).slice(0, 10).toLowerCase();
  try {
    await promise;
    throw new Error(`SMOKE FAIL: ${label} — did not revert`);
  } catch (e: any) {
    const blob = ((e?.message ?? "") + JSON.stringify(e?.error ?? "") + (e?.data ?? "")).toLowerCase();
    if (blob.includes(selectorSig.toLowerCase()) || blob.includes(selector)) {
      console.log(`  OK: ${label} (reverted with ${selectorSig})`);
    } else {
      throw new Error(`SMOKE FAIL: ${label} — reverted with the WRONG error: ${(e?.message ?? "").slice(0, 200)}`);
    }
  }
}

async function main() {
  const network = hre.network.name;
  const chainId = hre.network.config.chainId!;
  const [deployer] = await ethers.getSigners();
  const contracts = getContracts()[network];
  console.log(`Network: ${network} | Deployer/attestor: ${deployer.address}`);

  const router = await ethers.getContractAt("TransferEOALegacyRouter", contracts["TransferEOALegacyRouter"].address);
  const vaultAddr: string = await router.pullVault();
  ok(vaultAddr !== ethers.constants.AddressZero, `router.pullVault() wired: ${vaultAddr}`);
  const vault = await ethers.getContractAt("LegacyPullVault", vaultAddr);
  const attestor: string = await router.activityAttestor();
  ok(attestor.toLowerCase() === deployer.address.toLowerCase(), `deployer is the attestor`);

  const token = await ethers.getContractAt("LegacyToken", contracts["ERC20Token_R2USD"].address);
  const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, ethers.provider);

  // ── 1. Fresh owner + beneficiary ─────────────────────────────────────────
  const owner = ethers.Wallet.createRandom().connect(ethers.provider);
  const bene = ethers.Wallet.createRandom().connect(ethers.provider);
  // Persist throwaway keys (gitignored output/) so a mid-run failure never
  // strands funds or a live test legacy behind lost keys.
  const fs = await import("fs");
  fs.mkdirSync("output", { recursive: true });
  fs.writeFileSync(
    "output/smoke-vault-wallets.json",
    JSON.stringify({ owner: owner.privateKey, bene: bene.privateKey, at: new Date().toISOString() }, null, 2)
  );
  console.log(`\nFresh owner: ${owner.address}\nFresh beneficiary: ${bene.address}`);
  await (await deployer.sendTransaction({ to: owner.address, value: ethers.utils.parseEther("0.02") })).wait();
  await (await deployer.sendTransaction({ to: bene.address, value: ethers.utils.parseEther("0.005") })).wait();

  const unit = ethers.BigNumber.from(10).pow(await token.decimals());
  await (await token.connect(owner).mint(owner.address, unit.mul(100))).wait();
  await (await token.connect(owner).approve(PERMIT2, ethers.constants.MaxUint256)).wait();
  console.log("Owner funded, 100 R2USD minted, Permit2 base approval set.");

  // ── 2. createLegacyV2, spender = VAULT ───────────────────────────────────
  const predicted: string = await router.getNextLegacyAddress(owner.address);
  const now = Math.floor(Date.now() / 1000);
  const [, , nonce] = await permit2.allowance(owner.address, token.address, vaultAddr);
  const permitBatch = {
    details: [{ token: token.address, amount: MAX_UINT160, expiration: now + 100 * 365 * 86400, nonce }],
    spender: vaultAddr,
    sigDeadline: now + 1800,
  };
  const batchSig = await owner._signTypedData(
    { name: "Permit2", chainId, verifyingContract: PERMIT2 },
    PERMIT_BATCH_TYPES,
    permitBatch
  );
  const tosSig = await owner.signMessage(await genMessage(now));

  console.log("\ncreateLegacyV2 (vault as Permit2 spender)…");
  const txC = await router.connect(owner).createLegacyV2(
    [{ user: bene.address, percent: 1_000_000 }],
    { lackOfOutgoingTxRange: 3600, delayLayer2: 0, delayLayer3: 0 },
    { user: ethers.constants.AddressZero, percent: 0 },
    { user: ethers.constants.AddressZero, percent: 0 },
    { permitBatch, signature: batchSig },
    now,
    tosSig
  );
  console.log(`  tx: ${txC.hash}`);
  const rc = await txC.wait();
  const v2Topic = router.interface.getEventTopic("TransferEOALegacyCreatedV2");
  const v2Log = rc.logs.find((l: any) => l.topics[0] === v2Topic);
  if (!v2Log) throw new Error("TransferEOALegacyCreatedV2 not emitted");
  const created = router.interface.parseLog(v2Log);
  const legacyAddr: string = created.args.legacyAddress ?? created.args[1];
  const legacyId = created.args.legacyId ?? created.args[0];
  console.log(`  legacy #${legacyId.toString()} at ${legacyAddr}`);

  // ── 3. Vault wiring assertions ───────────────────────────────────────────
  ok(legacyAddr.toLowerCase() === predicted.toLowerCase(), "clone landed at the predicted address");
  ok((await vault.boundLegacy(owner.address)).toLowerCase() === legacyAddr.toLowerCase(), "vault binding registered");
  const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddr);
  ok((await legacy.pullVault()).toLowerCase() === vaultAddr.toLowerCase(), "clone pinned the vault");
  const [vAmt] = await permit2.allowance(owner.address, token.address, vaultAddr);
  ok(vAmt.gt(0), "Permit2 allowance registered for the vault");

  // ── 4. Premium + auto-renew opt-in ───────────────────────────────────────
  console.log("\nPremium + auto-renew…");
  const registry = await ethers.getContractAt("PremiumRegistry", contracts["PremiumRegistry"].address);
  const setting = await ethers.getContractAt("PremiumSetting", contracts["PremiumSetting"].address);
  if (!(await setting.isPremium(owner.address))) {
    const nextPlan = (await registry.getNextPlanId()).toNumber();
    let planId = -1;
    for (let p = 0; p < nextPlan; p++) {
      try {
        await registry.getPlanDuration(p);
        planId = p;
        break;
      } catch { /* inactive plan */ }
    }
    if (planId < 0) throw new Error("No active premium plan on this network — create one first");
    await (await registry.subrcribeByAdmin(owner.address, planId, "vault-rehearsal")).wait();
    ok(await setting.isPremium(owner.address), `owner premium via plan ${planId}`);
  } else {
    console.log("  owner already premium");
  }

  // Explicit gas limits with margin on the small writes: public-RPC
  // estimateGas has proven to under-quote by a few % (OOG at 98% used).
  await (await router.connect(owner).setAutoRenew(legacyId, true, { gasLimit: 150_000 })).wait();
  const st = await router.autoRenewState(legacyId);
  ok(st.enabled === true, "auto-renew enabled by owner");

  // ── 5. Attestation + bounds ──────────────────────────────────────────────
  const tsBefore = await legacy.getLastTimestamp();
  await (await router.connect(deployer).recordActivity(legacyId, 1, { gasLimit: 200_000 })).wait();
  const tsAfter = await legacy.getLastTimestamp();
  ok(tsAfter.gt(tsBefore), "recordActivity reset the inactivity timer");
  await expectRevert(router.connect(deployer).callStatic.recordActivity(legacyId, 1), "StaleActivityNonce()", "nonce replay rejected");
  await expectRevert(router.connect(owner).callStatic.recordActivity(legacyId, 2), "NotActivityAttestor()", "non-attestor rejected");

  // ── 6. Claim through the vault rail ──────────────────────────────────────
  console.log("\nLowering trigger to 60s and claiming through the vault…");
  await (await router.connect(owner).setActivationTrigger(legacyId, 60, { gasLimit: 150_000 })).wait();
  console.log("  waiting 75s for the trigger…");
  await sleep(75_000);
  const beneBefore = await token.balanceOf(bene.address);
  const txClaim = await router.connect(bene).activeLegacy(legacyId, [token.address], false, { gasLimit: 600_000 });
  console.log(`  claim tx: ${txClaim.hash}`);
  await txClaim.wait();
  const beneAfter = await token.balanceOf(bene.address);
  ok(
    beneAfter.sub(beneBefore).gte(unit.mul(99)),
    `beneficiary received ${ethers.utils.formatUnits(beneAfter.sub(beneBefore), await token.decimals())} R2USD via the vault rail`
  );

  // ── 7. Refund leftovers ──────────────────────────────────────────────────
  // value = balance − maxFeePerGas·21000 with the SAME fee caps as the tx,
  // so the node's "gas·price + value ≤ balance" check can never overshoot.
  for (const w of [owner, bene]) {
    const bal = await w.getBalance();
    const feeData = await ethers.provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? (await ethers.provider.getGasPrice()).mul(2);
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.utils.parseUnits("1.5", "gwei");
    const maxCost = maxFeePerGas.mul(21000);
    if (bal.gt(maxCost)) {
      await (
        await w.sendTransaction({
          to: deployer.address,
          value: bal.sub(maxCost),
          gasLimit: 21000,
          maxFeePerGas,
          maxPriorityFeePerGas,
        })
      ).wait();
    }
  }
  console.log("\nSMOKE PASSED — vault create, binding, auto-renew bounds, and vault-rail claim all verified on live network.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

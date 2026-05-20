/**
 * MAINNET-ONLY — atomic upgrade + rotation of TransferEOALegacyRouter.
 *
 * Why this is its own script (not hardhat-deploy):
 *   On mainnet, the router proxy's `_initialized` counter is already at 3 due
 *   to a prior reinitialization cycle. The previous `_codeAdmin` was set to
 *   a wallet we do NOT control. Calling `initializeV2` again is impossible
 *   (reinitializer(3) is exhausted), so we added `initializeV3` (reinitializer(4))
 *   as an escape hatch.
 *
 *   We cannot do a plain upgrade-then-call-initializeV3 because anyone
 *   watching the mempool could front-run the `initializeV3` call after
 *   observing the upgrade, hijacking the `_codeAdmin` slot. The fix is to
 *   bundle both steps in one transaction via `DefaultProxyAdmin.upgradeAndCall`.
 *
 * Sequence:
 *   1. Deploy new TransferEOALegacyRouter implementation
 *   2. Encode `initializeV3(deployer)` calldata
 *   3. Call `admin.upgradeAndCall(proxy, newImpl, calldata)` — single atomic tx
 *   4. Verify post-conditions: _initialized == 4, _codeAdmin == deployer
 *   5. Update contract-addresses.json + deployments/*_Implementation.json
 *   6. Verify the new impl on Etherscan
 *
 * Pre-requisites:
 *   - `DefaultProxyAdmin.owner()` must be the deployer (audited: ✓ on mainnet)
 *   - Router proxy must currently be on OptimizedTransparentProxy managed by
 *     DefaultProxyAdmin (audited: ✓ on mainnet)
 *   - Router proxy's `_initialized` must be < 4 (audited: = 3 on mainnet)
 *
 * Dry-run support:
 *   Set DRY_RUN=1 to simulate everything up to (but not including) the
 *   upgradeAndCall tx. Useful for pre-flight against live RPC.
 *
 * Usage:
 *   npx hardhat run scripts/mainnet-upgrade-eoa-router.ts --network mainnet
 */
import { ethers, network, run, deployments } from "hardhat";
import * as dotenv from "dotenv";
import { saveContract, shouldVerify, sleep } from "./utils";

dotenv.config();

const INITIALIZABLE_STORAGE_SLOT =
  "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

async function readInitializedVersion(proxyAddr: string): Promise<number> {
  const packed = await ethers.provider.getStorageAt(proxyAddr, INITIALIZABLE_STORAGE_SLOT);
  return Number(BigInt("0x" + packed.slice(-16)));
}

async function main() {
  const isDryRun = process.env.DRY_RUN === "1";
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();

  console.log(`Network:  ${network.name} (chainId=${network.config.chainId})`);
  console.log(`Deployer: ${deployerAddr}`);
  console.log(`Dry run:  ${isDryRun ? "YES (no tx will be sent)" : "no"}`);

  if (network.name !== "mainnet" && !isDryRun) {
    console.log(
      `\n⚠ This script is intended for mainnet. If you're running on ${network.name} ` +
        `intentionally (e.g. to re-rotate Sepolia), set DRY_RUN=1 to confirm state first.`
    );
  }

  const routerAddr = (await deployments.get("TransferEOALegacyRouter")).address;
  const adminAddr = (await deployments.get("DefaultProxyAdmin")).address;

  // ---- Pre-flight checks ------------------------------------------------
  console.log(`\n=== Pre-flight ===`);
  console.log(`Router proxy:      ${routerAddr}`);
  console.log(`DefaultProxyAdmin: ${adminAddr}`);

  const adminAbi = [
    "function upgrade(address proxy, address implementation) external",
    "function upgradeAndCall(address proxy, address implementation, bytes data) external payable",
    "function getProxyImplementation(address proxy) view returns (address)",
    "function getProxyAdmin(address proxy) view returns (address)",
    "function owner() view returns (address)",
  ];
  const admin = new ethers.Contract(adminAddr, adminAbi, deployer as any);

  const adminOwner: string = await admin.owner();
  console.log(`Admin owner:       ${adminOwner}`);
  if (adminOwner.toLowerCase() !== deployerAddr.toLowerCase()) {
    throw new Error(
      `Abort: DefaultProxyAdmin.owner() (${adminOwner}) is not the deployer (${deployerAddr}). ` +
        `Only the admin owner can issue upgradeAndCall.`
    );
  }

  const proxyOfAdmin: string = await admin.getProxyAdmin(routerAddr);
  if (proxyOfAdmin.toLowerCase() !== adminAddr.toLowerCase()) {
    throw new Error(
      `Abort: router's admin (${proxyOfAdmin}) does not match DefaultProxyAdmin (${adminAddr}). ` +
        `Something is off with the proxy setup — investigate before proceeding.`
    );
  }

  const currentImpl: string = await admin.getProxyImplementation(routerAddr);
  console.log(`Current router impl: ${currentImpl}`);

  const initVersion = await readInitializedVersion(routerAddr);
  console.log(`Current _initialized: ${initVersion}`);
  if (initVersion >= 4) {
    throw new Error(
      `Abort: _initialized = ${initVersion}. initializeV3 (reinitializer(4)) cannot be called. ` +
        `A fresh escape hatch would need to be added to the contract code.`
    );
  }
  console.log(`✓ initializeV3 is callable (requires _initialized < 4)`);

  // ---- Deploy new impl --------------------------------------------------
  console.log(`\n=== Deploy new implementation ===`);
  const Factory = await ethers.getContractFactory("TransferEOALegacyRouter", deployer as any);

  // Encode initializeV3(deployer) calldata — used by upgradeAndCall below
  const initV3Calldata = Factory.interface.encodeFunctionData("initializeV3", [deployerAddr]);
  console.log(`initializeV3 calldata: ${initV3Calldata}`);

  if (isDryRun) {
    console.log(`\n=== DRY RUN complete — no tx sent ===`);
    console.log(`Would deploy new TransferEOALegacyRouter impl, then call:`);
    console.log(`  admin.upgradeAndCall(${routerAddr}, <newImpl>, ${initV3Calldata})`);
    return;
  }

  const newImpl = await Factory.deploy();
  console.log(`Deploying… tx: ${newImpl.deployTransaction.hash}`);
  await newImpl.deployed();
  console.log(`New impl deployed: ${newImpl.address}`);

  const code = await ethers.provider.getCode(newImpl.address);
  if (code === "0x") throw new Error(`Impl at ${newImpl.address} has no code yet`);

  // ---- Atomic upgrade + rotate -----------------------------------------
  console.log(`\n=== Atomic upgrade + rotate (upgradeAndCall) ===`);
  console.log(`  proxy:  ${routerAddr}`);
  console.log(`  impl:   ${newImpl.address}`);
  console.log(`  init:   initializeV3(${deployerAddr})`);

  const tx = await admin.upgradeAndCall(routerAddr, newImpl.address, initV3Calldata);
  console.log(`  tx:     ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  block:  ${rc.blockNumber}`);
  console.log(`  gas:    ${rc.gasUsed.toString()}`);

  // ---- Post-conditions --------------------------------------------------
  console.log(`\n=== Post-conditions ===`);
  const finalImpl: string = await admin.getProxyImplementation(routerAddr);
  if (finalImpl.toLowerCase() !== newImpl.address.toLowerCase()) {
    throw new Error(`Impl mismatch after upgrade: chain=${finalImpl} expected=${newImpl.address}`);
  }
  console.log(`✓ proxy now points at new impl`);

  const finalVersion = await readInitializedVersion(routerAddr);
  if (finalVersion !== 4) {
    throw new Error(`_initialized should be 4 after initializeV3, got ${finalVersion}`);
  }
  console.log(`✓ _initialized = 4 (initializeV3 ran atomically)`);

  // Sanity: confirm deployer is _codeAdmin by reading from the router itself.
  // The contract has a private _codeAdmin but we can confirm via any
  // onlyCodeAdmin probe. setLegacyImplementation(address(0)) is idempotent
  // (no-op: just sets the slot to zero, which also happens to disable the
  // clone path — but we're about to set it to a real impl in the next
  // script, so this is safe). We DON'T call that here to avoid a spurious
  // extra tx; instead we rely on the fact that initializeV3 reverted on zero,
  // so reaching this point with _initialized=4 proves _codeAdmin was set.

  console.log(`✓ _codeAdmin rotated to deployer (${deployerAddr}) — inferred from successful initializeV3`);

  // ---- Persist ----------------------------------------------------------
  saveContract(network.name, "TransferEOALegacyRouter", routerAddr, newImpl.address);
  try {
    // Update the hardhat-deploy implementation artifact so future deploys see
    // the right starting state.
    await deployments.save("TransferEOALegacyRouter_Implementation", {
      address: newImpl.address,
      abi: Factory.interface.fragments.map((f) => JSON.parse(f.format("json"))),
      transactionHash: newImpl.deployTransaction.hash,
      bytecode: Factory.bytecode,
    });
    console.log(`✓ deployments/${network.name}/TransferEOALegacyRouter_Implementation.json updated`);
  } catch (e: any) {
    console.warn(`  (could not save hardhat-deploy artifact: ${e?.message ?? e})`);
  }

  // ---- Verify on Etherscan ---------------------------------------------
  if (shouldVerify(network.name)) {
    console.log(`\n=== Etherscan verification ===`);
    await sleep(20_000);
    try {
      await run("verify:verify", {
        address: newImpl.address,
        constructorArguments: [],
      });
      console.log(`✓ verified on Etherscan`);
    } catch (e: any) {
      const msg = (e?.message ?? "").toLowerCase();
      if (msg.includes("already verified")) {
        console.log(`✓ already verified (bytecode match with a prior submission)`);
      } else {
        console.warn(`  verification failed (non-fatal): ${e?.message ?? e}`);
      }
    }
  }

  console.log(`\n-----------------------------------------------------------------`);
  console.log(`SUMMARY`);
  console.log(`-----------------------------------------------------------------`);
  console.log(`TransferEOALegacyRouter proxy:          ${routerAddr}`);
  console.log(`TransferEOALegacyRouter new impl:       ${newImpl.address}`);
  console.log(`_codeAdmin now:                         ${deployerAddr}`);
  console.log(`_initialized now:                       4`);
  console.log(``);
  console.log(`NEXT STEPS on ${network.name}:`);
  console.log(`  1. npx hardhat deploy --network ${network.name} --tags LegacyDeployer`);
  console.log(`     (upgrades LegacyDeployer to expose cloneLegacy / getNextCloneAddress)`);
  console.log(`  2. npx hardhat run scripts/deploy-eoa-clone-impl.ts --network ${network.name}`);
  console.log(`     (deploys TransferEOALegacy impl + setLegacyImplementation)`);
  console.log(`  3. npx hardhat run scripts/verify-mainnet-clone-deploy.ts --network ${network.name}`);
  console.log(`     (post-deploy sanity check — requires a legacy creation first)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

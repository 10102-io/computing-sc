/**
 * Mainnet equivalent of scripts/verify-sepolia-clone-deploy.ts.
 *
 * Confirms a recent EOA legacy creation on mainnet went through the EIP-1167
 * clone path instead of the full-bytecode Create2 path. Reads the router's
 * `_legacyId` counter, fetches the latest-created legacy, confirms its
 * bytecode is a 45-byte minimal proxy, and pulls the deployment tx from
 * Etherscan to report gas used.
 *
 * Run this AFTER creating a legacy through the UI so there's something to
 * inspect. Safe to run before as well — it will just report the current
 * state (which will show the last legacy pre-upgrade was NOT a clone).
 *
 * Usage:
 *   npx hardhat run scripts/verify-mainnet-clone-deploy.ts --network mainnet
 */
import { ethers, deployments, network } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const apiKey = process.env.API_KEY_ETHERSCAN;
  if (!apiKey) throw new Error("Set API_KEY_ETHERSCAN");
  const chainId = network.config.chainId ?? 1;

  const routerAddr = (await deployments.get("TransferEOALegacyRouter")).address;
  const router = await ethers.getContractAt("TransferEOALegacyRouter", routerAddr);

  const impl: string = await router.legacyImplementation();
  const legacyIdBN = await router._legacyId();
  const legacyId = Number(legacyIdBN.toString());

  console.log(`Network:              ${network.name} (chainId=${chainId})`);
  console.log(`Router:               ${routerAddr}`);
  console.log(`legacyImplementation: ${impl}`);
  console.log(`_legacyId (counter):  ${legacyId}`);
  console.log();

  if (legacyId === 0) {
    console.log("No legacies have ever been created through this router.");
    return;
  }

  const scanStart = Math.max(1, legacyId - 6);
  console.log(`Scanning legacyAddresses[${scanStart}..${legacyId}]:\n`);

  let latestClone: { id: number; addr: string } | null = null;
  let latestFull: { id: number; addr: string } | null = null;

  for (let i = legacyId; i >= scanStart; i--) {
    const addr: string = await router.legacyAddresses(i);
    if (addr === ethers.constants.AddressZero) {
      console.log(`  #${i}  (deleted / zero-address)`);
      continue;
    }
    const code = await ethers.provider.getCode(addr);
    const bytes = (code.length - 2) / 2;
    const kind =
      bytes === 45
        ? "CLONE (45B EIP-1167)"
        : bytes === 0
          ? "no code (self-destructed)"
          : `full bytecode (${bytes}B)`;
    console.log(`  #${i}  ${addr}  → ${kind}`);
    if (bytes === 45 && !latestClone) latestClone = { id: i, addr };
    if (bytes > 1000 && !latestFull) latestFull = { id: i, addr };
  }

  if (!latestClone) {
    console.log(`\nNo clone-path legacies found in the last ${legacyId - scanStart + 1} entries.`);
    if (impl === ethers.constants.AddressZero) {
      console.log(`  legacyImplementation is still zero — setLegacyImplementation has not been called yet.`);
    } else {
      console.log(
        `  legacyImplementation IS set (${impl}) but no one has created a legacy since. ` +
          `Create one through the UI and re-run.`
      );
    }
    return;
  }

  console.log(`\nMost recent CLONE legacy:`);
  console.log(`  id:      ${latestClone.id}`);
  console.log(`  address: ${latestClone.addr}`);
  console.log(`  etherscan: https://etherscan.io/address/${latestClone.addr}`);

  // Confirm the clone delegates to our impl
  const code = await ethers.provider.getCode(latestClone.addr);
  if (!code.toLowerCase().includes(impl.slice(2).toLowerCase())) {
    console.log(`  ⚠ Clone's runtime bytecode does NOT embed ${impl} — investigate`);
  } else {
    console.log(`  ✓ Clone delegates to legacyImplementation (${impl})`);
  }

  // Fetch creation tx
  console.log(`\nFetching creation tx from Etherscan…`);
  const ccUrl =
    `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getcontractcreation` +
    `&contractaddresses=${latestClone.addr}&apikey=${apiKey}`;
  const cc = (await (await fetch(ccUrl)).json()) as any;
  const ccRow = cc?.result?.[0];
  if (!ccRow) {
    console.log(`  Could not locate creation tx: ${JSON.stringify(cc)}`);
    return;
  }
  console.log(`  tx hash: ${ccRow.txHash}`);

  const rcUrl =
    `https://api.etherscan.io/v2/api?chainid=${chainId}&module=proxy&action=eth_getTransactionReceipt` +
    `&txhash=${ccRow.txHash}&apikey=${apiKey}`;
  const rc = (await (await fetch(rcUrl)).json()) as any;
  const gasUsedHex: string | undefined = rc?.result?.gasUsed;
  if (!gasUsedHex) {
    console.log(`  Could not fetch receipt: ${JSON.stringify(rc)}`);
    return;
  }
  const gasUsed = parseInt(gasUsedHex, 16);

  const txUrl =
    `https://api.etherscan.io/v2/api?chainid=${chainId}&module=proxy&action=eth_getTransactionByHash` +
    `&txhash=${ccRow.txHash}&apikey=${apiKey}`;
  const tx = (await (await fetch(txUrl)).json()) as any;
  const gasPriceHex: string | undefined = tx?.result?.gasPrice;
  const gasPriceGwei = gasPriceHex ? parseInt(gasPriceHex, 16) / 1e9 : null;

  console.log(`  gasUsed:  ${gasUsed.toLocaleString()}`);
  if (gasPriceGwei != null) {
    console.log(`  gasPrice: ${gasPriceGwei.toFixed(3)} gwei`);
    const ethCost = (gasUsed * gasPriceGwei) / 1e9;
    console.log(`  ETH cost: ${ethCost.toFixed(6)} ETH`);
  }

  console.log(`\nGas comparison:`);
  console.log(`  Observed:                    ${gasUsed.toLocaleString()}`);
  console.log(`  Full-bytecode path baseline: ~5,500,000 – 6,200,000`);
  console.log(`  EIP-1167 clone target:       ~1,100,000 – 1,500,000`);
  if (gasUsed < 2_000_000) {
    console.log(`  → Clone path confirmed live on mainnet. 🎯`);
  } else if (gasUsed > 4_000_000) {
    console.log(`  → This tx looks like the full-bytecode path — investigate.`);
  } else {
    console.log(`  → In-between; defer to bytecode size verdict above.`);
  }

  if (latestFull && latestFull.id > (latestClone?.id ?? 0)) {
    console.log(
      `\n⚠ Warning: legacy #${latestFull.id} (newer than the most recent clone #${latestClone?.id}) ` +
        `is a full-bytecode deploy. Someone may have called setLegacyImplementation(address(0)) ` +
        `between them, or a new legacy was created BEFORE the impl was wired.`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

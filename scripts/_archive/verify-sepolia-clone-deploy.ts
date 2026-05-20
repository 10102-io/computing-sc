/**
 * Verifies a recent EOA legacy creation on Sepolia used the EIP-1167 clone
 * path instead of the full-bytecode Create2 path.
 *
 * Reads the router's `_legacyId` counter + `legacyAddresses` + owner info to
 * find the most recent legacy, fetches its creation tx via Etherscan, reports
 * gas used, and confirms the deployed bytecode is a 45-byte EIP-1167 proxy.
 *
 * Env:
 *   USER (optional) wallet whose legacy to locate; if set, searches by owner
 *   API_KEY_ETHERSCAN (required)
 */
import { ethers, deployments, network } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const apiKey = process.env.API_KEY_ETHERSCAN;
  if (!apiKey) throw new Error("Set API_KEY_ETHERSCAN");
  const chainId = 11155111;

  const routerAddr = (await deployments.get("TransferEOALegacyRouter")).address;
  const router = await ethers.getContractAt("TransferEOALegacyRouter", routerAddr);

  const impl: string = await router.legacyImplementation();
  const legacyIdBN = await router._legacyId();
  const legacyId = Number(legacyIdBN.toString());

  console.log(`Network:              ${network.name}`);
  console.log(`Router:               ${routerAddr}`);
  console.log(`legacyImplementation: ${impl}`);
  console.log(`_legacyId (total):    ${legacyId}`);
  console.log();

  const userFilter = process.env.USER?.toLowerCase();

  const last = Math.max(1, legacyId - 5);
  console.log(`Scanning legacyAddresses[${last}..${legacyId}]:\n`);

  const legacyAbi = [
    "function owner() view returns (address)",
    "function getOwner() view returns (address)",
  ];

  const matches: Array<{ id: number; addr: string; owner: string | null; bytes: number }> = [];
  for (let i = legacyId; i >= last; i--) {
    const addr: string = await router.legacyAddresses(i);
    const code = await ethers.provider.getCode(addr);
    const bytes = (code.length - 2) / 2;

    let owner: string | null = null;
    const c = new ethers.Contract(addr, legacyAbi, ethers.provider);
    try { owner = await c.owner(); } catch {}
    if (!owner) { try { owner = await c.getOwner(); } catch {} }

    console.log(`  #${i}  ${addr}  bytecode=${bytes} bytes  owner=${owner ?? "?"}`);
    if (!userFilter || (owner && owner.toLowerCase() === userFilter)) {
      matches.push({ id: i, addr, owner, bytes });
    }
  }

  const target = userFilter
    ? matches.find(() => true)
    : { id: legacyId, addr: await router.legacyAddresses(legacyId), owner: null as string | null, bytes: 0 };

  if (!target) {
    console.log(`\nNo legacy found owned by ${userFilter}. It may be outside the scanned window.`);
    return;
  }

  if (target.bytes === 0) {
    const code = await ethers.provider.getCode(target.addr);
    target.bytes = (code.length - 2) / 2;
  }

  console.log(`\nTarget legacy:`);
  console.log(`  id:            ${target.id}`);
  console.log(`  address:       ${target.addr}`);
  console.log(`  owner:         ${target.owner ?? "(unreadable)"}`);
  console.log(`  bytecode size: ${target.bytes} bytes`);
  console.log(`  etherscan:     https://sepolia.etherscan.io/address/${target.addr}#code`);

  const code = await ethers.provider.getCode(target.addr);
  const isClone = target.bytes === 45 && code.toLowerCase().includes(impl.slice(2).toLowerCase());
  console.log(`\nBytecode verdict:`);
  if (isClone) {
    console.log(`  ✓ EIP-1167 minimal proxy (45 bytes), delegates to ${impl}`);
  } else if (target.bytes > 1000) {
    console.log(`  ✗ Full-bytecode deployment (${target.bytes} bytes) — NOT a clone`);
  } else {
    console.log(`  ? Unexpected size ${target.bytes}; manual inspection needed`);
  }

  // Fetch the creation tx for this legacy via Etherscan contract-creation API
  console.log(`\nFetching creation tx from Etherscan…`);
  const ccUrl =
    `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getcontractcreation` +
    `&contractaddresses=${target.addr}&apikey=${apiKey}`;
  const cc = await (await fetch(ccUrl)).json() as any;
  const ccRow = cc?.result?.[0];
  if (!ccRow) {
    console.log(`  Could not locate creation tx: ${JSON.stringify(cc)}`);
    return;
  }
  console.log(`  creator:  ${ccRow.contractCreator}`);
  console.log(`  tx hash:  ${ccRow.txHash}`);

  // Fetch tx receipt for gasUsed
  const rcUrl =
    `https://api.etherscan.io/v2/api?chainid=${chainId}&module=proxy&action=eth_getTransactionReceipt` +
    `&txhash=${ccRow.txHash}&apikey=${apiKey}`;
  const rc = await (await fetch(rcUrl)).json() as any;
  const gasUsedHex: string | undefined = rc?.result?.gasUsed;
  if (!gasUsedHex) {
    console.log(`  Could not fetch receipt: ${JSON.stringify(rc)}`);
    return;
  }
  const gasUsed = parseInt(gasUsedHex, 16);
  console.log(`  gasUsed:  ${gasUsed.toLocaleString()}`);

  // Root tx (the createLegacy call) — get that via eth_getTransactionByHash
  const txUrl =
    `https://api.etherscan.io/v2/api?chainid=${chainId}&module=proxy&action=eth_getTransactionByHash` +
    `&txhash=${ccRow.txHash}&apikey=${apiKey}`;
  const tx = await (await fetch(txUrl)).json() as any;
  const from = tx?.result?.from;
  const to = tx?.result?.to;
  const gasPrice = tx?.result?.gasPrice ? parseInt(tx.result.gasPrice, 16) : null;
  console.log(`  from:     ${from}  (tx sender)`);
  console.log(`  to:       ${to}    (router)`);
  if (gasPrice != null) {
    console.log(`  gasPrice: ${(gasPrice / 1e9).toFixed(4)} gwei`);
  }
  console.log(`  etherscan: https://sepolia.etherscan.io/tx/${ccRow.txHash}`);

  console.log(`\nGas comparison:`);
  console.log(`  Observed:                    ${gasUsed.toLocaleString()}`);
  console.log(`  Full-bytecode path baseline: ~5,500,000 – 6,200,000`);
  console.log(`  EIP-1167 clone target:       ~1,100,000 – 1,500,000`);
  if (gasUsed < 2_000_000) {
    console.log(`  → Clone path confirmed working on Sepolia. 🎯`);
  } else if (gasUsed > 4_000_000) {
    console.log(`  → Full-bytecode path — this tx predates setLegacyImplementation or went through a different flow.`);
  } else {
    console.log(`  → In-between; defer to bytecode size verdict above.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

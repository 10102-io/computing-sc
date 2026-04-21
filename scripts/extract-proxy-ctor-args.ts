import { ethers } from "hardhat";

// Extracts the ABI-encoded constructor arguments from a contract's creation
// transaction so we can re-run hardhat verify with the exact same values.
// Works for any contract; we use it here to recover args for
// PremiumRegistry_Proxy on Sepolia.

const PROXY = "0xC3c59ab1a146Da758fEf1f68Bd5F14189e5d0246";
const ETHERSCAN_API_KEY = process.env.API_KEY_ETHERSCAN;
const CHAIN_ID = 11155111;

async function main() {
  if (!ETHERSCAN_API_KEY) throw new Error("Set API_KEY_ETHERSCAN");

  // 1. Ask Etherscan for the creation tx hash.
  const metaUrl =
    `https://api.etherscan.io/v2/api?chainid=${CHAIN_ID}` +
    `&module=contract&action=getcontractcreation&contractaddresses=${PROXY}` +
    `&apikey=${ETHERSCAN_API_KEY}`;
  const metaRes = await fetch(metaUrl).then((r) => r.json() as any);
  const meta = metaRes?.result?.[0];
  if (!meta) throw new Error(`No creation meta: ${JSON.stringify(metaRes)}`);
  console.log("creator:", meta.contractCreator);
  console.log("tx:     ", meta.txHash);

  // 2. Pull the creation tx input.
  const tx = await ethers.provider.getTransaction(meta.txHash);
  if (!tx) throw new Error("tx not found");
  const input = tx.data; // creation tx has data == bytecode + encoded args

  // 3. OptimizedTransparentProxy constructor: (address logic, address admin, bytes data).
  //    Fetch artifact so we know creation bytecode length, then slice the tail.
  const artifact = await ethers.getContractFactory(
    "@openzeppelin/hardhat-upgrades/artifacts/@openzeppelin/contracts-v5/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy"
  ).catch(() => null);

  // Fallback: heuristic. For OptimizedTransparentProxy the constructor args are
  // the last (32 + 32 + 32 + N*32) bytes where the bytes param's ABI encoding
  // trailing. Simplest reliable approach: guess by scanning for our known impl
  // and admin addresses in the input.
  const impl = "0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b".toLowerCase().slice(2);
  const admin = "0x26e78E0A15ebBC48065Ed0527D74F28D1B53a1B6".toLowerCase().slice(2);

  const inputLower = input.toLowerCase();
  const implIdx = inputLower.indexOf(impl);
  const adminIdx = inputLower.indexOf(admin);
  console.log(`impl found at offset (hex chars): ${implIdx}`);
  console.log(`admin found at offset (hex chars): ${adminIdx}`);

  // The constructor args are ABI-encoded after the bytecode. For (address, address, bytes):
  //   word0 = impl (left-padded to 32 bytes)
  //   word1 = admin (left-padded to 32 bytes)
  //   word2 = offset to bytes (0x60 usually)
  //   word3 = length of bytes
  //   wordN = bytes data (padded)
  //
  // impl appears left-padded: "000000000000000000000000" + impl
  const paddedImpl = "0".repeat(24) + impl;
  const argStart = inputLower.indexOf(paddedImpl);
  if (argStart < 0) throw new Error("Could not locate constructor args in tx data");
  const args = "0x" + input.slice(argStart);
  console.log(`\n--- constructor args hex (starts ${argStart}) ---`);
  console.log(args);
  console.log(`\n--- length (bytes) = ${(args.length - 2) / 2}`);

  // Decode using ABI so we can also show the init data.
  const decoder = (ethers as any).utils.defaultAbiCoder;
  try {
    const [logic, adminOut, data] = decoder.decode(
      ["address", "address", "bytes"],
      args
    );
    console.log(`\nDecoded:`);
    console.log(`  logic: ${logic}`);
    console.log(`  admin: ${adminOut}`);
    console.log(`  data:  ${data}`);
  } catch (e) {
    console.log("(decode failed, raw hex above is still usable):", e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

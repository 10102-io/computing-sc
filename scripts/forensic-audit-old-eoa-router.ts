import { ethers, network } from "hardhat";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// Read-only forensic audit of the mainnet TransferEOALegacyRouter prior
// implementation (0x78698F78...), superseded by the 2026-04-14 EIP-1167
// upgrade. Goal: understand how _initialized advanced to 3 and who set
// _codeAdmin to 0x89F544A2..., neither of which has any trace in this repo.
//
// Pulls:
//   - Contract creation tx + creator for the old impl
//   - Every Upgraded / AdminChanged event on the router proxy since genesis
//   - Every Initialized event emitted FROM the router proxy
//   - Tries to trace which tx transitioned _codeAdmin to 0x89F544A2
//
// Run: npx hardhat run scripts/forensic-audit-old-eoa-router.ts --network mainnet

const ROUTER_PROXY = "0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b";
const OLD_IMPL = "0x78698F783C5C155c04D7C09c895183B5070929B4";
const MYSTERY_CODE_ADMIN = "0x89F544A2ecb12E37978F61aA47ACa64f81677944";

const UPGRADED_TOPIC = ethers.utils.id("Upgraded(address)");
const ADMIN_CHANGED_TOPIC = ethers.utils.id("AdminChanged(address,address)");
const INITIALIZED_TOPIC = ethers.utils.id("Initialized(uint8)");
// Newer OZ (non-upgradeable namespaced storage) emits Initialized(uint64):
const INITIALIZED_TOPIC_V5 = ethers.utils.id("Initialized(uint64)");

async function fetchContractCreation(address: string) {
  const apiKey =
    process.env.ETHERSCAN_API_KEY ||
    process.env.API_KEY_ETHERSCAN ||
    process.env.ETHERSCAN_KEY;
  if (!apiKey) throw new Error("ETHERSCAN_API_KEY / API_KEY_ETHERSCAN not set");
  const url = `https://api.etherscan.io/api?module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${apiKey}`;
  const res = await axios.get(url);
  if (res.data.status !== "1") return null;
  return res.data.result[0];
}

async function getReceipt(txHash: string) {
  return ethers.provider.getTransactionReceipt(txHash);
}

async function getTx(txHash: string) {
  return ethers.provider.getTransaction(txHash);
}

async function main() {
  if (network.name !== "mainnet") {
    throw new Error(`This script is mainnet-only. Got: ${network.name}`);
  }

  console.log("=== Forensic audit: prior TransferEOALegacyRouter implementation ===\n");
  console.log(`Router proxy:      ${ROUTER_PROXY}`);
  console.log(`Old impl:          ${OLD_IMPL}`);
  console.log(`Mystery _codeAdmin: ${MYSTERY_CODE_ADMIN}\n`);

  // 1. Creation of the old impl
  console.log("-- Old impl creation --");
  const creation = await fetchContractCreation(OLD_IMPL);
  if (!creation) {
    console.log("  (Etherscan returned no creation info)");
  } else {
    console.log(`  creator:   ${creation.contractCreator}`);
    console.log(`  tx:        ${creation.txHash}`);
    const cReceipt = await getReceipt(creation.txHash);
    if (cReceipt?.blockNumber) {
      const block = await ethers.provider.getBlock(cReceipt.blockNumber);
      const date = new Date(block.timestamp * 1000).toISOString();
      console.log(`  block:     ${cReceipt.blockNumber} (${date})`);
    }
  }

  // 2. Router-proxy creation
  console.log("\n-- Router proxy creation --");
  const proxyCreation = await fetchContractCreation(ROUTER_PROXY);
  let fromBlock = 0;
  if (proxyCreation) {
    console.log(`  creator:   ${proxyCreation.contractCreator}`);
    console.log(`  tx:        ${proxyCreation.txHash}`);
    const pReceipt = await getReceipt(proxyCreation.txHash);
    if (pReceipt?.blockNumber) {
      fromBlock = pReceipt.blockNumber;
      const block = await ethers.provider.getBlock(pReceipt.blockNumber);
      const date = new Date(block.timestamp * 1000).toISOString();
      console.log(`  block:     ${pReceipt.blockNumber} (${date})`);
    }
  }

  const latest = await ethers.provider.getBlockNumber();
  console.log(`  latest block: ${latest}`);

  // 3. Every Upgraded event on the proxy
  console.log("\n-- All Upgraded events on router proxy --");
  const upgradedLogs = await ethers.provider.getLogs({
    address: ROUTER_PROXY,
    topics: [UPGRADED_TOPIC],
    fromBlock,
    toBlock: latest,
  });
  for (const log of upgradedLogs) {
    const impl = ethers.utils.getAddress("0x" + log.topics[1].slice(-40));
    const block = await ethers.provider.getBlock(log.blockNumber);
    const date = new Date(block.timestamp * 1000).toISOString();
    const tx = await getTx(log.transactionHash);
    console.log(`  block ${log.blockNumber} (${date})  impl=${impl}  tx=${log.transactionHash}  from=${tx?.from}`);
  }

  // 4. Every AdminChanged event on the proxy
  console.log("\n-- All AdminChanged events on router proxy --");
  const adminChangedLogs = await ethers.provider.getLogs({
    address: ROUTER_PROXY,
    topics: [ADMIN_CHANGED_TOPIC],
    fromBlock,
    toBlock: latest,
  });
  for (const log of adminChangedLogs) {
    const prev = ethers.utils.getAddress("0x" + log.data.slice(2, 66).slice(-40));
    const curr = ethers.utils.getAddress("0x" + log.data.slice(66, 130).slice(-40));
    const block = await ethers.provider.getBlock(log.blockNumber);
    const date = new Date(block.timestamp * 1000).toISOString();
    console.log(`  block ${log.blockNumber} (${date})  ${prev} -> ${curr}  tx=${log.transactionHash}`);
  }

  // 5. Every Initialized event from the proxy (both v4 and v5 signatures)
  console.log("\n-- All Initialized events from router proxy --");
  for (const topic of [INITIALIZED_TOPIC, INITIALIZED_TOPIC_V5]) {
    const initLogs = await ethers.provider.getLogs({
      address: ROUTER_PROXY,
      topics: [topic],
      fromBlock,
      toBlock: latest,
    });
    for (const log of initLogs) {
      const version = ethers.BigNumber.from(log.data).toString();
      const block = await ethers.provider.getBlock(log.blockNumber);
      const date = new Date(block.timestamp * 1000).toISOString();
      const tx = await getTx(log.transactionHash);
      const sig = topic === INITIALIZED_TOPIC ? "Initialized(uint8)" : "Initialized(uint64)";
      console.log(`  block ${log.blockNumber} (${date})  version=${version}  sig=${sig}  tx=${log.transactionHash}  from=${tx?.from}`);
      // Decode calldata to see which function was called
      if (tx) {
        const sel = tx.data.slice(0, 10);
        console.log(`     tx selector=${sel}  to=${tx.to}`);
      }
    }
  }

  // 6. For each Upgraded event pointing at the old impl, dump the full tx
  //    trace hint (from, to, value, calldata selector)
  console.log("\n-- Txs that pointed the proxy at the old impl --");
  for (const log of upgradedLogs) {
    const impl = ethers.utils.getAddress("0x" + log.topics[1].slice(-40));
    if (impl.toLowerCase() !== OLD_IMPL.toLowerCase()) continue;
    const tx = await getTx(log.transactionHash);
    if (!tx) continue;
    console.log(`  tx:       ${log.transactionHash}`);
    console.log(`  from:     ${tx.from}`);
    console.log(`  to:       ${tx.to} (ProxyAdmin or self)`);
    console.log(`  value:    ${ethers.utils.formatEther(tx.value)} ETH`);
    console.log(`  input:    ${tx.data.slice(0, 260)}${tx.data.length > 260 ? "..." : ""}`);
    console.log(`  input sel: ${tx.data.slice(0, 10)}`);
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

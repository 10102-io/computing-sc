import { ethers, network } from "hardhat";

// Reconciles the mainnet TransferEOALegacyRouter._legacyId counter (23) with
// on-chain Created / Deleted / Activated events to explain the "22 pre-refactor
// mainnet legacies" surprise. Pure read-only.

const ROUTER = "0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b";

async function main() {
  if (network.name !== "mainnet") throw new Error("mainnet-only");

  const router = await ethers.getContractAt("TransferEOALegacyRouter", ROUTER);

  const legacyId: ethers.BigNumber = await router._legacyId();
  console.log(`Router:     ${ROUTER}`);
  console.log(`_legacyId:  ${legacyId.toString()}`);

  // Fetch all Created / Deleted / Activated event logs by topic since the
  // proxy's first deployment (March 5, 2026).
  const latest = await ethers.provider.getBlockNumber();
  const FROM_BLOCK = 24589554;

  const iface = router.interface;

  const createdTopic = iface.getEventTopic("TransferEOALegacyCreated");
  const deletedTopic = iface.getEventTopic("TransferEOALegacyDeleted");
  const activatedTopic = iface.getEventTopic("TransferEOALegacyActivated");
  const layer23CreatedTopic = iface.getEventTopic("TransferEOALegacyLayer23Created");

  async function scan(topic: string) {
    return ethers.provider.getLogs({
      address: ROUTER,
      topics: [topic],
      fromBlock: FROM_BLOCK,
      toBlock: latest,
    });
  }

  const [createdLogs, deletedLogs, activatedLogs, layer23CreatedLogs] = await Promise.all([
    scan(createdTopic),
    scan(deletedTopic),
    scan(activatedTopic),
    scan(layer23CreatedTopic),
  ]);

  console.log(`\nEvent counts since router deployment (block ${FROM_BLOCK}):`);
  console.log(`  Created:           ${createdLogs.length}`);
  console.log(`  Deleted:           ${deletedLogs.length}`);
  console.log(`  Activated:         ${activatedLogs.length}`);
  console.log(`  Layer23Created:    ${layer23CreatedLogs.length}  (subordinate legacies)`);

  const createdIds = new Set<string>();
  for (const log of createdLogs) {
    if (!log.topics[1]) continue;
    const id = ethers.BigNumber.from(log.topics[1]).toString();
    createdIds.add(id);
  }
  const deletedIds = new Set<string>();
  for (const log of deletedLogs) {
    if (!log.topics[1]) continue;
    const id = ethers.BigNumber.from(log.topics[1]).toString();
    deletedIds.add(id);
  }
  const activatedIds = new Set<string>();
  for (const log of activatedLogs) {
    if (!log.topics[1]) continue;
    const id = ethers.BigNumber.from(log.topics[1]).toString();
    activatedIds.add(id);
  }

  const liveIds: string[] = [];
  for (const id of createdIds) {
    if (!deletedIds.has(id) && !activatedIds.has(id)) liveIds.push(id);
  }

  console.log(`\nDerived breakdown:`);
  console.log(`  Ever created (distinct ids):   ${createdIds.size}`);
  console.log(`  Deleted:                       ${deletedIds.size}`);
  console.log(`  Activated (paid out):          ${activatedIds.size}`);
  console.log(`  Live (created - deleted - activated): ${liveIds.length}`);

  const sortedCreated = Array.from(createdIds).sort((a, b) => Number(a) - Number(b));
  console.log(`\nAll created legacy ids: [${sortedCreated.join(", ")}]`);
  console.log(`Live legacy ids:        [${liveIds.sort((a, b) => Number(a) - Number(b)).join(", ")}]`);

  // Counter sanity check: _legacyId should equal max(createdIds)+1 (post-refactor)
  const maxId = sortedCreated.length > 0 ? Number(sortedCreated[sortedCreated.length - 1]) : 0;
  console.log(`\nSanity check:`);
  console.log(`  max created id:  ${maxId}`);
  console.log(`  _legacyId:       ${legacyId.toString()}`);
  console.log(`  gap:             ${Number(legacyId.toString()) - maxId}`);

  // Time breakdown: first/last creation
  if (createdLogs.length > 0) {
    const first = await ethers.provider.getBlock(createdLogs[0].blockNumber);
    const last = await ethers.provider.getBlock(createdLogs[createdLogs.length - 1].blockNumber);
    console.log(`\nActivity window:`);
    console.log(`  first created: ${new Date(first.timestamp * 1000).toISOString()} (block ${createdLogs[0].blockNumber})`);
    console.log(`  last  created: ${new Date(last.timestamp * 1000).toISOString()} (block ${createdLogs[createdLogs.length - 1].blockNumber})`);
  }

  // Who created them? (unique creators)
  const creators = new Set<string>();
  for (const log of createdLogs) {
    const tx = await ethers.provider.getTransaction(log.transactionHash);
    if (tx?.from) creators.add(tx.from.toLowerCase());
  }
  console.log(`\nUnique creator EOAs: ${creators.size}`);
  for (const c of creators) console.log(`  ${c}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

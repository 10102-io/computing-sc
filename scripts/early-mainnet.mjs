// The 2024 contracts on mainnet, checked against this repository: for each one, the source Sourcify
// holds as an exact match of the bytecode on the chain is compared, file by file, with the commit named
// here, and the block it was created in is dated. Then the first legacy: the event the first router
// emitted on 2024-08-19. Read-only, no key, nothing from .env (README, "Project history & audits").
//
//   node scripts/early-mainnet.mjs
//   MAINNET_RPC_URL=<your node> node scripts/early-mainnet.mjs
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { id: topicOf } = createRequire(import.meta.url)("ethers").utils;

const CONTRACTS = [
  { name: "InheritanceWillRouter", address: "0x57F9B7538F3614ecC5074B72371B38e8f9EF13Fa", commit: "a2f2ad9", created: "2024-08-15" },
  { name: "InheritanceWillRouter", address: "0x441a9Ac3bD5CDc2e6C01F9059Ade046Ff49e935b", commit: "c969eb2", created: "2024-10-25" },
  { name: "ForwardingWillRouter", address: "0x5175499ee7b6992621338A2f90A7382071E59840", commit: "c969eb2", created: "2024-10-25" },
  { name: "ForwardingEOAWillRouter", address: "0x590168716Eeed64eD0173Bc5EC730fc1DDAbB615", commit: "c969eb2", created: "2024-10-27" },
];
const FIRST_LEGACY = {
  router: CONTRACTS[0].address,
  tx: "0x5ddd2c447983b96274599838306aa03a876b82891f507ad89a3f771f3181efb5",
  // As declared in contracts/InheritanceWillRouter.sol at a2f2ad9, structs written out.
  event: "InheritanceWillCreated(uint256,address,address,address,address,(string,string,string[],address[]),(uint128,uint128),uint256)",
  created: "2024-08-19",
};

// Public nodes that still serve receipts of 2024 (many prune them: such a node answers null and the next is asked).
const RPCS = [
  process.env.MAINNET_RPC_URL,
  "https://eth.drpc.org",
  "https://1rpc.io/eth",
  "https://eth.merkle.io",
  "https://rpc.mevblocker.io",
].filter(Boolean);
async function rpc(method, params) {
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const body = await res.json();
      if (body.result) return body.result;
    } catch {
      // The next node.
    }
  }
  throw new Error(`${method}: no node answered`);
}
const dayOf = async (blockNumber) => {
  const block = await rpc("eth_getBlockByNumber", [`0x${BigInt(blockNumber).toString(16)}`, false]);
  return new Date(Number(block.timestamp) * 1000).toISOString().slice(0, 10);
};
const atCommit = (commit, file) => {
  try {
    return execFileSync("git", ["show", `${commit}:${file}`], { cwd: repo, maxBuffer: 1 << 26 });
  } catch {
    return null;
  }
};

let failed = 0;
const check = (ok, text) => {
  if (!ok) failed++;
  console.log(`   ${ok ? "ok  " : "FAIL"} ${text}`);
};

for (const c of CONTRACTS) {
  console.log(`\n${c.name} ${c.address}`);
  const res = await fetch(`https://sourcify.dev/server/v2/contract/1/${c.address}?fields=deployment,sources,compilation`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Sourcify answered ${res.status} for ${c.address}`);
  const s = await res.json();
  check(
    s.creationMatch === "exact_match" && s.runtimeMatch === "exact_match",
    `Sourcify: the source is an exact match of the bytecode on the chain (${s.compilation.name}, solc ${s.compilation.compilerVersion})`
  );
  check(s.compilation.name === c.name, `the contract is ${c.name}`);
  const day = await dayOf(s.deployment.blockNumber);
  check(day === c.created, `created ${day} (block ${s.deployment.blockNumber}, transaction ${s.deployment.transactionHash})`);
  // Our own files; the libraries (OpenZeppelin, Safe) come from npm and are not in this repository.
  const own = Object.entries(s.sources).filter(([file]) => file.startsWith("contracts/"));
  const differs = own.filter(([file, { content }]) => !atCommit(c.commit, file)?.equals(Buffer.from(content, "utf8"))).map(([file]) => file);
  check(
    own.length > 0 && differs.length === 0,
    `${own.length - differs.length} of ${own.length} contract files are byte for byte the files of commit ${c.commit}${
      differs.length ? `; not: ${differs.join(", ")}` : ""
    }`
  );
}

console.log(`\nThe first legacy, transaction ${FIRST_LEGACY.tx}`);
const receipt = await rpc("eth_getTransactionReceipt", [FIRST_LEGACY.tx]);
const created = receipt.logs.filter(
  (log) => log.address.toLowerCase() === FIRST_LEGACY.router.toLowerCase() && log.topics[0] === topicOf(FIRST_LEGACY.event)
);
check(receipt.status === "0x1" && created.length === 1, `the router of 2024-08-15 emitted InheritanceWillCreated once`);
const day = await dayOf(receipt.blockNumber);
check(day === FIRST_LEGACY.created, `on ${day} (block ${Number(receipt.blockNumber)})`);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);

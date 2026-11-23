/**
 * Read-only Etherscan check for the current network, over every contract
 * in `contract-addresses.json`: is each implementation (live and pending)
 * and each standalone contract source-verified, and does Etherscan's proxy
 * record point at the live implementation? Where a proxy record is stale
 * (after a timelocked upgrade), re-submit the proxy verification.
 *
 * The chain decides what is a proxy (a non-zero EIP-1967 implementation
 * slot), so a contract added to the book is covered without a change
 * here. Until 2026-11-23 the names were a fixed list, and `LegacyDeployer`
 * was not on it. Exits 1 when anything is unverified or stale.
 *
 *   npx hardhat run scripts/verify-etherscan-status.ts --network sepolia
 *   $env:ES_FIX="1"  # also re-submit stale proxy records
 */
import * as hre from "hardhat";
import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts, verifyProxyOnEtherscan } from "./utils";

dotenv.config();

const API = "https://api.etherscan.io/v2/api";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO_SLOT = "0x" + "0".repeat(64);
/** Not contracts of ours: the governance block holds the Safe and keys, the tokens are Sepolia test tokens. */
const SKIP = /^(_|governance$|ERC20Token_)/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Free-tier Etherscan allows 5 req/s; a rate-limit reply is retried, never reported as "unverified". */
async function source(chainId: number, address: string, key: string) {
  const url = `${API}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${key}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(350);
    const res = await fetch(url);
    const json = (await res.json()) as { status: string; message?: string; result: Array<Record<string, string>> | string };
    if (json.status === "1" && typeof json.result !== "string") return json.result[0];
    if (typeof json.result === "string" && /rate limit/i.test(json.result)) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    throw new Error(`Etherscan ${address}: ${json.message} ${json.result}`);
  }
  throw new Error(`Etherscan rate limit persisted for ${address}`);
}

async function main() {
  const network = hre.network.name;
  const chainId = hre.network.config.chainId!;
  const key = process.env.API_KEY_ETHERSCAN;
  if (!key) throw new Error("API_KEY_ETHERSCAN missing");
  const book = getContracts()[network];
  const fix = process.env.ES_FIX === "1";

  const issues: string[] = [];
  const verifiedLine = (rec: Record<string, string> | undefined, what: string) => {
    if (rec?.SourceCode) return `verified as ${rec.ContractName} (${rec.CompilerVersion})`;
    issues.push(`${what} is not verified`);
    return "NOT VERIFIED";
  };

  let checked = 0;
  for (const [name, value] of Object.entries(book)) {
    const entry = value as any;
    if (SKIP.test(name) || !entry?.address) continue;
    checked++;
    const raw = await ethers.provider.getStorageAt(entry.address, IMPL_SLOT);
    if (raw === ZERO_SLOT) {
      const rec = await source(chainId, entry.address, key);
      console.log(`${name} ${entry.address}: ${verifiedLine(rec, name)}`);
      continue;
    }
    const live = ethers.utils.getAddress("0x" + raw.slice(-40));
    const proxyRec = await source(chainId, entry.address, key);
    const proxyImpl = proxyRec?.Implementation ? ethers.utils.getAddress(proxyRec.Implementation) : "(none)";
    const proxyOk = proxyImpl.toLowerCase() === live.toLowerCase();
    console.log(`${name} proxy ${entry.address}`);
    console.log(`  etherscan proxy record -> ${proxyImpl} ${proxyOk ? "matches live impl" : `STALE (live ${live})`}`);
    if (!proxyOk && fix) {
      const r = await verifyProxyOnEtherscan(entry.address, live, chainId, key);
      console.log(`  re-submitted proxy verification: ${r.message}`);
    } else if (!proxyOk) {
      issues.push(`${name}: Etherscan's proxy record is stale`);
    }
    if (entry.implementation && entry.implementation.toLowerCase() !== live.toLowerCase()) {
      console.log(`  book implementation ${entry.implementation} is NOT the live one`);
      issues.push(`${name}: the book's implementation is not the live one`);
    }
    for (const [label, addr] of [["live", live], ["pending", entry.pendingImplementation]] as Array<[string, string | undefined]>) {
      if (!addr) continue;
      const rec = await source(chainId, addr, key);
      console.log(`  ${label} impl ${addr}: ${verifiedLine(rec, `${name} ${label} implementation`)}`);
    }
  }

  console.log(`\n${checked} contracts checked, ${issues.length} to look at.`);
  for (const issue of issues) console.log(`  ${issue}`);
  if (issues.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

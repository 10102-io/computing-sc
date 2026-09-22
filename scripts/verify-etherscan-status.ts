/**
 * Read-only Etherscan check for the current network: is every recorded
 * implementation (live and pending) source-verified, and does Etherscan's
 * proxy record point at the live implementation? Where a proxy record is
 * stale (after a timelocked upgrade), re-submit the proxy verification.
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
const PROXIES = ["TimeLockRouter", "TimelockERC20", "TimelockERC721", "TimelockERC1155", "TransferEOALegacyRouter", "MultisigLegacyRouter", "PremiumRegistry", "PremiumSetting", "EIP712LegacyVerifier"];

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

  for (const name of PROXIES) {
    const entry = book[name] as any;
    if (!entry?.address) continue;
    const raw = await ethers.provider.getStorageAt(entry.address, IMPL_SLOT);
    const live = ethers.utils.getAddress("0x" + raw.slice(-40));
    const proxyRec = await source(chainId, entry.address, key);
    const proxyImpl = proxyRec?.Implementation ? ethers.utils.getAddress(proxyRec.Implementation) : "(none)";
    const proxyOk = proxyImpl.toLowerCase() === live.toLowerCase();
    console.log(`${name} proxy ${entry.address}`);
    console.log(`  etherscan proxy record -> ${proxyImpl} ${proxyOk ? "matches live impl" : `STALE (live ${live})`}`);
    if (!proxyOk && fix) {
      const r = await verifyProxyOnEtherscan(entry.address, live, chainId, key);
      console.log(`  re-submitted proxy verification: ${r.message}`);
    }
    for (const [label, addr] of [["live", live], ["pending", entry.pendingImplementation]] as Array<[string, string | undefined]>) {
      if (!addr) continue;
      const rec = await source(chainId, addr, key);
      const verified = Boolean(rec?.SourceCode);
      console.log(`  ${label} impl ${addr}: ${verified ? `verified as ${rec!.ContractName} (${rec!.CompilerVersion})` : "NOT VERIFIED"}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

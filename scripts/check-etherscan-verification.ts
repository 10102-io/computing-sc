import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

// Multi-chain Etherscan verification audit.
//
// Reads contract-addresses.json and, for each operational contract on mainnet
// and sepolia (skipping _deprecated / _orphaned / localhost), asks the
// Etherscan v2 API whether the bytecode at that address has matching verified
// source. For proxies, both the proxy and the implementation are checked.
//
// Pure read-only. Safe to run in CI. Uses API_KEY_ETHERSCAN (same key as
// hardhat-etherscan).

const API_KEY = process.env.API_KEY_ETHERSCAN;
if (!API_KEY) {
  console.error(
    "Set API_KEY_ETHERSCAN in .env (same key used by hardhat-etherscan)."
  );
  process.exit(1);
}

const CHAIN_IDS: Record<string, number> = {
  mainnet: 1,
  sepolia: 11155111,
};

const SKIP_KEYS = new Set(["_deprecated", "_orphaned", "_note"]);

type Target = { name: string; address: string; impl?: string };
type AddressBook = Record<string, Record<string, any>>;

function loadTargets(network: string): Target[] {
  const raw = fs.readFileSync(
    path.join(__dirname, "..", "contract-addresses.json"),
    "utf8"
  );
  const book = JSON.parse(raw) as AddressBook;
  const section = book[network];
  if (!section) throw new Error(`No section for ${network}`);
  const out: Target[] = [];
  for (const [name, entry] of Object.entries(section)) {
    if (SKIP_KEYS.has(name)) continue;
    if (!entry || typeof entry !== "object") continue;
    const address = (entry as any).address as string | undefined;
    const impl = (entry as any).implementation as string | undefined;
    if (!address) continue;
    out.push({ name, address, impl });
  }
  return out;
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

async function isVerified(
  chainId: number,
  addr: string,
  attempt = 0
): Promise<{
  verified: boolean;
  name?: string;
  compiler?: string;
}> {
  const url =
    `https://api.etherscan.io/v2/api?chainid=${chainId}` +
    `&module=contract&action=getsourcecode&address=${addr}&apikey=${API_KEY}`;
  const body = await httpGet(url);
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return isVerified(chainId, addr, attempt + 1);
    }
    return { verified: false };
  }
  // Etherscan returns status "0" + "NOTOK" on rate-limit. Retry with backoff.
  if (parsed?.status === "0" && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return isVerified(chainId, addr, attempt + 1);
  }
  const result = parsed?.result?.[0];
  if (!result) return { verified: false };
  const source = result.SourceCode as string;
  if (!source || source.length === 0) return { verified: false };
  return {
    verified: true,
    name: result.ContractName,
    compiler: result.CompilerVersion,
  };
}

async function auditNetwork(network: string): Promise<{
  network: string;
  unverified: string[];
  total: number;
}> {
  const chainId = CHAIN_IDS[network];
  const targets = loadTargets(network);
  const unverified: string[] = [];
  let total = 0;
  console.log(`\n=== ${network} (chainId=${chainId}, ${targets.length} entries) ===\n`);
  for (const t of targets) {
    total += 1;
    const proxy = await isVerified(chainId, t.address);
    const proxyTag = proxy.verified
      ? `verified (${proxy.name})`
      : "UNVERIFIED";
    let line = `${t.name.padEnd(30)} ${t.address}  ${proxyTag}`;
    if (!proxy.verified) unverified.push(`${t.name} proxy ${t.address}`);

    if (t.impl) {
      total += 1;
      await new Promise((r) => setTimeout(r, 500));
      const impl = await isVerified(chainId, t.impl);
      const implTag = impl.verified
        ? `impl verified (${impl.name})`
        : "IMPL UNVERIFIED";
      line += `\n${" ".repeat(32)}impl: ${t.impl}  ${implTag}`;
      if (!impl.verified) unverified.push(`${t.name} impl ${t.impl}`);
    }
    console.log(line);
    await new Promise((r) => setTimeout(r, 500));
  }
  return { network, unverified, total };
}

async function main() {
  const networks = (process.argv[2] || "mainnet,sepolia").split(",");
  const results = [];
  for (const n of networks) results.push(await auditNetwork(n.trim()));

  console.log("\n---\nSummary\n---");
  for (const r of results) {
    if (r.unverified.length === 0) {
      console.log(`${r.network}: OK (${r.total}/${r.total} verified)`);
    } else {
      console.log(
        `${r.network}: ${r.total - r.unverified.length}/${r.total} verified, ${r.unverified.length} UNVERIFIED:`
      );
      for (const u of r.unverified) console.log(`  - ${u}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

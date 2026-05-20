/**
 * Reconcile deployment artifacts for proxies whose on-chain impl address
 * has drifted from local artifacts, or whose `_Implementation.json` is
 * missing `transactionHash`. For each target we rewrite:
 *
 *   deployments/<net>/<Name>.json
 *     - `implementation` → on-chain EIP-1967 impl
 *
 *   deployments/<net>/<Name>_Implementation.json
 *     - `address` → on-chain impl
 *     - `transactionHash` → creation tx (looked up via etherscan)
 *     - `receipt` → transactionReceipt of creation tx
 *     - `deployedBytecode` → eth_getCode(implAddress)
 *     - `abi` → verified abi from etherscan (only when the on-chain impl
 *              is etherscan-verified; otherwise local abi is kept)
 *
 * When we're pulling a verified abi from etherscan (i.e. a full swap to
 * a new impl), we also purge `bytecode`, `metadata`, `storageLayout`,
 * `solcInputHash`, `args`, and `libraries` since they'd be stale relative
 * to the new abi; hardhat-deploy regenerates them on the next real deploy.
 * When we're only backfilling `transactionHash` for an address that
 * already matched on-chain, those fields are preserved.
 *
 * Run (per network):
 *   npx hardhat run --network mainnet scripts/reconcile-impl-artifacts.ts
 *   npx hardhat run --network sepolia scripts/reconcile-impl-artifacts.ts
 *
 * The script is idempotent: running it twice after a successful first
 * run is a no-op.
 */
import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

dotenv.config();

const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const API = "https://api.etherscan.io/v2/api";

function chainIdFor(net: string): number {
  if (net === "mainnet") return 1;
  if (net === "sepolia") return 11155111;
  throw new Error(`unsupported network: ${net}`);
}

type Target = { name: string; networks: Array<"mainnet" | "sepolia"> };
const TARGETS: Target[] = [
  { name: "TransferLegacyRouter", networks: ["mainnet", "sepolia"] },
  { name: "MultisigLegacyRouter", networks: ["mainnet", "sepolia"] },
  { name: "Banner", networks: ["sepolia"] },
  { name: "PremiumRegistry", networks: ["sepolia"] },
  { name: "PremiumSetting", networks: ["sepolia"] },
];

type EtherscanSourceResult = {
  SourceCode: string;
  ABI: string;
  ContractName: string;
  CompilerVersion: string;
};

type EtherscanCreationResult = {
  contractAddress: string;
  contractCreator: string;
  txHash: string;
};

function apiKey(): string {
  const k = process.env.API_KEY_ETHERSCAN ?? process.env.ETHERSCAN_API_KEY;
  if (!k) throw new Error("API_KEY_ETHERSCAN not set");
  return k;
}

async function etherscanSource(
  address: string,
  chainId: number
): Promise<EtherscanSourceResult> {
  const url = `${API}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey()}`;
  const res = await fetch(url);
  const j = (await res.json()) as {
    status: string;
    message: string;
    result: EtherscanSourceResult[];
  };
  if (!j.result?.[0]) throw new Error(`etherscan getsourcecode empty for ${address}`);
  return j.result[0];
}

async function etherscanCreation(
  address: string,
  chainId: number
): Promise<EtherscanCreationResult> {
  const url = `${API}?chainid=${chainId}&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${apiKey()}`;
  // Retry with backoff — etherscan free tier is 3 calls/sec and this script
  // runs several calls back-to-back.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt));
    const res = await fetch(url);
    const j = (await res.json()) as {
      status: string;
      message: string;
      result: EtherscanCreationResult[] | string;
    };
    if (j.status === "1" && Array.isArray(j.result) && j.result[0]) {
      return j.result[0];
    }
    const isRate =
      typeof j.result === "string" && j.result.includes("rate limit");
    if (!isRate) {
      throw new Error(`etherscan getcontractcreation failed: ${JSON.stringify(j)}`);
    }
  }
  throw new Error(`etherscan getcontractcreation: rate-limited after retries`);
}

async function readOnchainImpl(proxy: string): Promise<string> {
  const raw = await ethers.provider.getStorageAt(proxy, EIP1967_IMPL_SLOT);
  return ethers.utils.getAddress("0x" + raw.slice(-40));
}

function readArtifact(p: string): Record<string, unknown> | null {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

function writeJson(p: string, obj: unknown): void {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

async function reconcile(name: string, dry: boolean) {
  const dir = path.join("deployments", network.name);
  const mainPath = path.join(dir, `${name}.json`);
  const implPath = path.join(dir, `${name}_Implementation.json`);

  const main = readArtifact(mainPath);
  const impl = readArtifact(implPath);
  if (!main || !impl) {
    console.log(`SKIP ${name}: missing ${mainPath} or ${implPath}`);
    return;
  }

  const chainId = chainIdFor(network.name);
  const proxyAddr = main.address as string;
  const onchain = await readOnchainImpl(proxyAddr);
  const artifactImpl = main.implementation as string | undefined;
  const implArtifactAddr = impl.address as string;
  const implHasTxHash = typeof impl.transactionHash === "string";

  const mainOk = !!artifactImpl && artifactImpl.toLowerCase() === onchain.toLowerCase();
  const implOk = implArtifactAddr.toLowerCase() === onchain.toLowerCase();

  console.log(`\n=== ${name} ===`);
  console.log(`  proxy:            ${proxyAddr}`);
  console.log(`  on-chain impl:    ${onchain}`);
  console.log(`  main.impl:        ${artifactImpl ?? "(missing)"} ${mainOk ? "(ok)" : "(stale)"}`);
  console.log(`  impl.address:     ${implArtifactAddr} ${implOk ? "(ok)" : "(stale)"}`);
  console.log(`  impl.txHash:      ${implHasTxHash ? "present" : "MISSING"}`);

  const needsWork = !mainOk || !implOk || !implHasTxHash;
  if (!needsWork) {
    console.log(`  nothing to do.`);
    return;
  }

  // Fetch fresh truth. If the on-chain impl is verified on etherscan we
  // rebuild the abi from that verified source. If not, we can only safely
  // keep the existing artifact's abi — which is fine as long as the local
  // `_Implementation.json` address already matched on-chain (i.e. this is
  // a "missing transactionHash / stale main pointer" case, not a full
  // swap to an unknown impl).
  const src = await etherscanSource(onchain, chainId);
  const verified = src.ABI !== "Contract source code not verified";
  let newAbi: unknown = impl.abi;
  if (verified) {
    newAbi = JSON.parse(src.ABI) as unknown;
  } else if (!implOk) {
    throw new Error(
      `${name}: on-chain impl ${onchain} is NOT verified on Etherscan and ` +
        `local _Implementation.json.address (${implArtifactAddr}) doesn't match. ` +
        `Cannot safely reconstruct abi — pausing.`
    );
  }
  const creation = await etherscanCreation(onchain, chainId);
  const txHash = creation.txHash;
  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`no receipt for ${txHash}`);
  const deployedBytecode = await ethers.provider.getCode(onchain);

  // Rebuild _Implementation.json preserving existing fields where useful.
  const newImpl: Record<string, unknown> = {
    ...impl,
    address: onchain,
    abi: newAbi,
    transactionHash: txHash,
    receipt,
    deployedBytecode,
    numDeployments: (impl.numDeployments as number | undefined) ?? 1,
  };
  // When we replaced the abi from verified etherscan source, also purge
  // fields that would disagree with the new truth. Keep them when we're
  // only backfilling transactionHash on an address that already matched.
  if (verified && !implOk) {
    for (const stale of ["bytecode", "metadata", "storageLayout", "solcInputHash", "args", "libraries"]) {
      if (stale in newImpl) delete (newImpl as Record<string, unknown>)[stale];
    }
  }

  if (!dry) {
    writeJson(implPath, newImpl);
    console.log(`  wrote ${implPath}`);
  } else {
    console.log(`  (dry) would write ${implPath}`);
  }

  // Rebuild main.json with the new pointer + refreshed proxy ABI merge.
  // We only touch `implementation` and leave the rest alone — the proxy's
  // own ABI is still the OZ transparent-proxy ABI.
  const newMain: Record<string, unknown> = { ...main, implementation: onchain };
  if (!dry) {
    writeJson(mainPath, newMain);
    console.log(`  wrote ${mainPath}`);
  } else {
    console.log(`  (dry) would write ${mainPath}`);
  }
}

async function main() {
  const net = network.name;
  if (net !== "mainnet" && net !== "sepolia") {
    throw new Error(`must run with --network mainnet|sepolia (got ${net})`);
  }
  const dry = process.env.DRY === "1";
  if (dry) console.log("DRY RUN — no files will be written.");
  const forThisNet = TARGETS.filter((t) =>
    t.networks.includes(net as "mainnet" | "sepolia")
  );
  if (forThisNet.length === 0) {
    console.log(`no targets configured for ${net}`);
    return;
  }
  for (const t of forThisNet) {
    await reconcile(t.name, dry);
    // Space out etherscan API calls to avoid the free-tier rate limit.
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

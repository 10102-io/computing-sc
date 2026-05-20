/* Reconstruct deployment artifacts for Sepolia contracts whose artifacts were
 * wiped during the orphan-chase. Only the fields that sync-ui cares about are
 * populated: `address`, `abi`, and (best-effort) `receipt.blockNumber`. */

import * as fs from "fs";
import * as path from "path";

type Artifact = {
  address: string;
  abi: unknown[];
  implementation?: string;
  receipt?: { blockNumber?: number };
};

const ROOT = path.join(__dirname, "..");
const ARTIFACTS = path.join(ROOT, "artifacts", "contracts");
const DEPLOYMENTS = path.join(ROOT, "deployments", "sepolia");

function readAbi(relArtifact: string): unknown[] {
  const p = path.join(ARTIFACTS, relArtifact);
  const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
  return parsed.abi as unknown[];
}

function writeArtifact(name: string, data: Artifact, force = false) {
  const outPath = path.join(DEPLOYMENTS, `${name}.json`);
  if (fs.existsSync(outPath) && !force) {
    console.log(`  skipping ${name}.json (exists)`);
    return;
  }
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");
  console.log(`  ${force ? "overwrote" : "wrote"} ${name}.json (${data.address})`);
}

function main() {
  console.log("Reconstructing missing Sepolia deployment artifacts...");

  // 1) Non-proxy: TokenWhiteList (wired)
  const tokenWhitelistAbi = readAbi("whitelist/TokenWhiteList.sol/TokenWhiteList.json");
  writeArtifact("TokenWhiteList", {
    address: "0xE7e5011263e862f964F608C26654edAD25497B8F",
    abi: tokenWhitelistAbi,
  });

  // 2) Non-proxy: Payment (wired)
  const paymentAbi = readAbi("common/Payment.sol/Payment.json");
  writeArtifact("Payment", {
    address: "0xd4bf99da7fBcb0A2Fd80754cB5CC9c7CDc9e8D78",
    abi: paymentAbi,
  });

  // 3) Proxy: PremiumRegistry.json (main) + _Implementation.json + _Proxy.json
  const premiumRegistryAbi = readAbi("premium/PremiumRegistry.sol/PremiumRegistry.json");
  writeArtifact("PremiumRegistry", {
    address: "0xC3c59ab1a146Da758fEf1f68Bd5F14189e5d0246",
    implementation: "0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b",
    abi: premiumRegistryAbi,
  });
  writeArtifact("PremiumRegistry_Implementation", {
    address: "0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b",
    abi: premiumRegistryAbi,
  });

  // 4) Proxy: Banner (NEW Banner, the only actually-redeployed contract)
  const bannerAbi = readAbi("common/Banner.sol/Banner.json");
  writeArtifact("Banner", {
    address: "0x9055140Be419cC91e3C48EA005658D1D11C245b7",
    implementation: "0xD4099787c0491eE85CFbb6f1D8C7f07aF8BdA84f",
    abi: bannerAbi,
  });
  writeArtifact("Banner_Implementation", {
    address: "0xD4099787c0491eE85CFbb6f1D8C7f07aF8BdA84f",
    abi: bannerAbi,
  });

  // 5) USDC / USDT test tokens (use ERC20Token mock ABI).
  // These currently point at stale addresses from earlier deploy attempts, so force-overwrite.
  const erc20Abi = readAbi("mock/ERC20Token.sol/ERC20Token.json");
  writeArtifact(
    "ERC20Token_USDC",
    {
      address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      abi: erc20Abi,
    },
    true
  );
  writeArtifact(
    "ERC20Token_USDT",
    {
      address: "0x02f62735EaF5fFB56B629bC529e72801713f27cd",
      abi: erc20Abi,
    },
    true
  );

  console.log("Done.");
}

main();

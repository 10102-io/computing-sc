/**
 * Adds a fixed batch of mainnet ERC-20s (GRT, ENS, LINK, SAFE) to the
 * TokenWhiteList, idempotently: tokens already whitelisted are skipped
 * (the contract reverts with AlreadyWhitelisted on duplicate adds, so we
 * read getWhitelist() first and never send a tx that would revert).
 *
 * DRY-RUN IS THE DEFAULT. Without BROADCAST=1 the script only reports
 * what it would do — no transaction is sent.
 *
 * Usage:
 *   npx hardhat run scripts/whitelist-tokens.ts --network mainnet            # dry-run
 *   BROADCAST=1 npx hardhat run scripts/whitelist-tokens.ts --network mainnet # send txs
 *   (PowerShell: $env:BROADCAST="1"; npx hardhat run scripts/whitelist-tokens.ts --network mainnet)
 *
 * Prereqs: the signer (DEPLOYER_PRIVATE_KEY for --network mainnet) must hold
 * DEFAULT_ADMIN_ROLE on the TokenWhiteList; addToken is role-gated.
 */
import { ethers, deployments, network } from "hardhat";

/** Mainnet token addresses — symbols verified on-chain via eth_call symbol(). */
const TOKENS_TO_WHITELIST: ReadonlyArray<{ symbol: string; address: string }> = [
  { symbol: "GRT", address: "0xc944E90C64B2c07662A292be6244BDf05Cda44a7" },
  { symbol: "ENS", address: "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72" },
  { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA" },
  { symbol: "SAFE", address: "0x5aFE3855358E112B5647B952709E6165e1c1eEEe" },
  { symbol: "wstETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" },
];

async function main() {
  const broadcast = process.env.BROADCAST === "1";
  const [signer] = await ethers.getSigners();
  const whitelistAddr = (await deployments.get("TokenWhiteList")).address;

  console.log(`Network:        ${network.name}`);
  console.log(`Signer:         ${await signer.getAddress()}`);
  console.log(`TokenWhiteList: ${whitelistAddr}`);
  console.log(`Mode:           ${broadcast ? "BROADCAST (txs will be sent)" : "DRY-RUN (set BROADCAST=1 to send)"}`);
  console.log("");

  const whitelist = await ethers.getContractAt("TokenWhiteList", whitelistAddr, signer as any);

  const current: string[] = await whitelist.getWhitelist();
  const currentSet = new Set(current.map((a) => a.toLowerCase()));
  console.log(`Currently whitelisted (${current.length}): ${current.join(", ") || "(none)"}`);
  console.log("");

  let added = 0;
  let skipped = 0;
  for (const t of TOKENS_TO_WHITELIST) {
    if (currentSet.has(t.address.toLowerCase())) {
      console.log(`SKIP  ${t.symbol.padEnd(4)} ${t.address} — already whitelisted`);
      skipped += 1;
      continue;
    }

    // The contract's onlyERC20 modifier will reject non-tokens on-chain;
    // pre-check code existence so a wrong-network run fails loudly here.
    const code = await ethers.provider.getCode(t.address);
    if (code === "0x") {
      throw new Error(
        `No contract code at ${t.symbol} ${t.address} on ${network.name} — wrong network?`
      );
    }

    if (!broadcast) {
      console.log(`WOULD ADD ${t.symbol.padEnd(4)} ${t.address}`);
      added += 1;
      continue;
    }

    console.log(`ADD   ${t.symbol.padEnd(4)} ${t.address} ...`);
    const tx = await whitelist.addToken(t.address);
    console.log(`      tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`      confirmed (gas used: ${receipt.gasUsed.toString()})`);
    added += 1;
  }

  console.log("");
  console.log(`Done. ${broadcast ? "Added" : "Would add"}: ${added}, skipped: ${skipped}.`);

  if (broadcast && added > 0) {
    const post: string[] = await whitelist.getWhitelist();
    const postSet = new Set(post.map((a) => a.toLowerCase()));
    const missing = TOKENS_TO_WHITELIST.filter((t) => !postSet.has(t.address.toLowerCase()));
    if (missing.length > 0) {
      throw new Error(`Post-check failed; still missing: ${missing.map((t) => t.symbol).join(", ")}`);
    }
    console.log(`Post-check OK — whitelist now has ${post.length} tokens.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

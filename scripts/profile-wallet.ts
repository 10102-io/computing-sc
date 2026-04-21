/**
 * Read-only profile of an arbitrary address: is it EOA or contract? First/last
 * activity on mainnet (via Etherscan). Helps identify a mystery wallet that
 * holds privileged roles in our system.
 *
 * Usage:
 *   $env:ADDR = "0x..."
 *   npx hardhat run scripts/profile-wallet.ts --network mainnet
 */
import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const raw = process.env.ADDR ?? process.env.WALLET_ADDR ?? "0x89f544a2ecb12e37978f61aa47aca64f81677944";
  if (!raw) throw new Error("Set ADDR=0x...");
  const addr = ethers.utils.getAddress(raw.toLowerCase());
  const apiKey = process.env.API_KEY_ETHERSCAN;
  if (!apiKey) throw new Error("Set API_KEY_ETHERSCAN");
  const chainId = network.config.chainId === 11155111 ? 11155111 : 1;

  console.log(`Network: ${network.name} (chainId=${chainId})`);
  console.log(`Address: ${addr}\n`);

  const code = await ethers.provider.getCode(addr);
  const isContract = code !== "0x";
  const balance = await ethers.provider.getBalance(addr);
  const nonce = await ethers.provider.getTransactionCount(addr);

  console.log(`  type:       ${isContract ? "CONTRACT" : "EOA"}`);
  console.log(`  ETH balance:${ethers.utils.formatEther(balance)}`);
  console.log(`  nonce:      ${nonce}${!isContract && nonce === 0 ? "  ⚠ zero nonce = wallet never sent a tx" : ""}`);
  if (isContract) {
    console.log(`  code size:  ${(code.length - 2) / 2} bytes`);

    // Quick probe for Gnosis Safe / multisig interface
    const multisigProbes = [
      "function getThreshold() view returns (uint256)",
      "function getOwners() view returns (address[])",
      "function VERSION() view returns (string)",
    ];
    try {
      const c = new ethers.Contract(addr, multisigProbes, ethers.provider);
      const threshold = await c.getThreshold();
      const owners: string[] = await c.getOwners();
      let version = "";
      try { version = await c.VERSION(); } catch {}
      console.log(`  ✓ Looks like a Gnosis Safe (threshold=${threshold.toString()}, ${owners.length} owners, version=${version})`);
      console.log(`    owners:`);
      for (const o of owners) console.log(`      - ${o}`);
    } catch {
      console.log(`  (not a Gnosis Safe)`);
    }
  }

  // First + last tx from Etherscan
  console.log(`\nFetching tx history…`);
  const url = (sort: "asc" | "desc") =>
    `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=txlist` +
    `&address=${addr}&sort=${sort}&page=1&offset=5&apikey=${apiKey}`;

  const [firstRes, lastRes] = await Promise.all([fetch(url("asc")), fetch(url("desc"))]);
  const first: any = await firstRes.json();
  const last: any = await lastRes.json();

  if (Array.isArray(first.result) && first.result.length > 0) {
    const f = first.result[0];
    const date = new Date(Number(f.timeStamp) * 1000).toISOString().slice(0, 10);
    console.log(`  first activity: ${date}  block ${f.blockNumber}  (${f.from === addr.toLowerCase() ? "outbound" : "inbound"})`);
  } else {
    console.log(`  first activity: none found`);
  }

  if (Array.isArray(last.result) && last.result.length > 0) {
    const l = last.result[0];
    const date = new Date(Number(l.timeStamp) * 1000).toISOString().slice(0, 10);
    console.log(`  last activity:  ${date}  block ${l.blockNumber}  (${l.from === addr.toLowerCase() ? "outbound" : "inbound"})`);
    console.log(`\n  5 most recent txs:`);
    for (const t of last.result.slice(0, 5)) {
      const date = new Date(Number(t.timeStamp) * 1000).toISOString().slice(0, 10);
      const dir = t.from === addr.toLowerCase() ? "→" : "←";
      const other = t.from === addr.toLowerCase() ? t.to : t.from;
      console.log(`    ${date}  ${dir} ${other}  method=${(t.input || "0x").slice(0, 10)}  ok=${t.isError === "0"}`);
    }
  }

  console.log(`\n  Etherscan: https://etherscan.io/address/${addr}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

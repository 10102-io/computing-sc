import { ethers } from "hardhat";

// We found that contract-addresses.json had stale/orphaned addresses for the admin portal
// but the on-chain wiring (from OLD PremiumSetting and TimeLockRouter) points at DIFFERENT,
// fully-functional contracts that YOU own.  Verify ownership of those wired targets.

const EXPECTED_ADMIN = "0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630";

const WIRED_PAYMENT = "0xd4bf99da7fBcb0A2Fd80754cB5CC9c7CDc9e8D78";
const WIRED_TOKEN_WHITELIST = "0xE7e5011263e862f964F608C26654edAD25497B8F";
const WIRED_REGISTRY = "0xC3c59ab1a146Da758fEf1f68Bd5F14189e5d0246";
const OLD_BANNER_ORPHAN = "0xf91c245bE0b0B3C8f6398d481Dea9325cC222471";

async function probe(label: string, addr: string) {
  console.log(`\n--- ${label} (${addr}) ---`);
  try {
    const c = await ethers.getContractAt(
      ["function owner() view returns (address)"],
      addr
    );
    const o = await (c as any).owner();
    const tag = o.toLowerCase() === EXPECTED_ADMIN.toLowerCase() ? "YOU" : "OTHER";
    console.log(`  owner: ${o} [${tag}]`);
  } catch {
    console.log(`  owner: n/a`);
  }
  try {
    const c = await ethers.getContractAt(
      [
        "function hasRole(bytes32,address) view returns (bool)",
        "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
      ],
      addr
    );
    const r = await (c as any).DEFAULT_ADMIN_ROLE();
    const h = await (c as any).hasRole(r, EXPECTED_ADMIN);
    console.log(`  DEFAULT_ADMIN_ROLE(you): ${h}`);
    // Also test a couple secondary roles likely to matter
    for (const roleName of ["OPERATOR", "WITHDRAWER", "DEPOSITOR"]) {
      try {
        const roleHash = (ethers as any).keccak256(
          (ethers as any).toUtf8Bytes(roleName)
        );
        const h2 = await (c as any).hasRole(roleHash, EXPECTED_ADMIN);
        console.log(`  ${roleName}(you): ${h2}`);
      } catch {}
    }
  } catch {
    console.log(`  DEFAULT_ADMIN_ROLE: n/a`);
  }
  // If it's a Payment, check fee
  try {
    const c = await ethers.getContractAt(
      ["function getFee() view returns (uint256)"],
      addr
    );
    const f = await (c as any).getFee();
    console.log(`  getFee: ${f}`);
  } catch {}
  // If TokenWhiteList, check a few methods
  try {
    const c = await ethers.getContractAt(
      [
        "function getSupportedTokens() view returns (address[])",
      ],
      addr
    );
    const toks = await (c as any).getSupportedTokens();
    console.log(`  supportedTokens (${toks.length}): ${toks.slice(0, 5).join(", ")}`);
  } catch {
    // try alternative name
    try {
      const c = await ethers.getContractAt(
        ["function tokenList(uint256) view returns (address)"],
        addr
      );
      const first = await (c as any).tokenList(0);
      console.log(`  tokenList[0]: ${first}`);
    } catch {}
  }
}

async function main() {
  await probe("WIRED Payment (from OLD_REGISTRY.payment)", WIRED_PAYMENT);
  await probe("WIRED TokenWhiteList (from TimeLockRouter.tokenWhitelist)", WIRED_TOKEN_WHITELIST);
  await probe("WIRED PremiumRegistry (from OLD PremiumSetting.premiumRegistry)", WIRED_REGISTRY);
  await probe("OLD Banner orphan (listed in original orphan report)", OLD_BANNER_ORPHAN);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

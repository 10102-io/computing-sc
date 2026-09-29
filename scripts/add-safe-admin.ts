/**
 * Gives the governance Safe (`contract-addresses.json` `governance.safe`)
 * the power to take back the operational contracts if the deployer key ever
 * leaks, without changing day-to-day work:
 *   PremiumRegistry, Banner, TokenWhiteList: grant DEFAULT_ADMIN_ROLE to the
 *     Safe (the deployer keeps its roles: plan prices and Premium grants,
 *     banner text, token list). The Safe can then revoke the deployer.
 *   PremiumSetting (single owner: setParams, resetPremium): ownership moves
 *     to the Safe; none of it is routine.
 * Idempotent.
 *
 *   npx hardhat run scripts/add-safe-admin.ts --network mainnet
 */
import { ethers, network } from "hardhat";
import { getContracts } from "./utils";

const ROLE_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
];
const OWNABLE_ABI = ["function owner() view returns (address)", "function transferOwnership(address newOwner)"];

async function main() {
  const [deployer] = await ethers.getSigners();
  const book = getContracts()[network.name] as any;
  const safe: string | undefined = book?.governance?.safe;
  if (!safe) throw new Error("governance.safe missing for this network");
  if ((await ethers.provider.getCode(safe)) === "0x") throw new Error(`Safe ${safe} has no code on ${network.name}`);
  const admin = ethers.constants.HashZero;
  console.log(`Network ${network.name}, deployer ${deployer.address}, Safe ${safe}`);

  for (const name of ["PremiumRegistry", "Banner", "TokenWhiteList"]) {
    const address: string | undefined = book[name]?.address;
    if (!address) {
      console.log(`  ${name}: not in the book, skipped`);
      continue;
    }
    const c = new ethers.Contract(address, ROLE_ABI, deployer);
    if (!(await c.hasRole(admin, safe))) {
      if (!(await c.hasRole(admin, deployer.address))) throw new Error(`${name}: deployer is not admin, cannot grant`);
      const tx = await c.grantRole(admin, safe);
      console.log(`  ${name}: grant admin to the Safe ${tx.hash}`);
      await tx.wait();
    }
    const ok = await c.hasRole(admin, safe);
    console.log(`  ${name.padEnd(16)} Safe admin ${ok}, deployer admin ${await c.hasRole(admin, deployer.address)}`);
    if (!ok) throw new Error(`${name}: Safe is not admin`);
  }

  const settingAddress: string | undefined = book.PremiumSetting?.address;
  if (settingAddress) {
    const s = new ethers.Contract(settingAddress, OWNABLE_ABI, deployer);
    const owner: string = await s.owner();
    if (owner.toLowerCase() === deployer.address.toLowerCase()) {
      const tx = await s.transferOwnership(safe);
      console.log(`  PremiumSetting: ownership to the Safe ${tx.hash}`);
      await tx.wait();
    }
    const now: string = await s.owner();
    console.log(`  PremiumSetting    owner ${now}`);
    if (now.toLowerCase() !== safe.toLowerCase()) throw new Error("PremiumSetting is not owned by the Safe");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

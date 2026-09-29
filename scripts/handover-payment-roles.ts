/**
 * Moves every role on `Payment` (the legacy claim fee and the treasury that
 * receives it and Premium payments) from the deployer to the governance Safe
 * (`contract-addresses.json` `governance.safe`): grant DEFAULT_ADMIN,
 * OPERATOR and WITHDRAWER to the Safe, check the Safe holds all three, then
 * the deployer renounces its own, DEFAULT_ADMIN last. Afterwards a fee change
 * or a withdrawal needs Safe signatures. Idempotent: re-running skips what is
 * already done.
 *
 *   npx hardhat run scripts/handover-payment-roles.ts --network mainnet
 */
import { ethers, network } from "hardhat";
import { getContracts } from "./utils";

const ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
  "function renounceRole(bytes32 role, address callerConfirmation)",
  "function getFee() view returns (uint256)",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const book = getContracts()[network.name] as any;
  const safe: string | undefined = book?.governance?.safe;
  const paymentAddr: string | undefined = book?.Payment?.address;
  if (!safe || !paymentAddr) throw new Error("governance.safe or Payment missing for this network");
  if ((await ethers.provider.getCode(safe)) === "0x") throw new Error(`Safe ${safe} has no code on ${network.name}`);

  const payment = new ethers.Contract(paymentAddr, ABI, deployer);
  const roles: [string, string][] = [
    ["OPERATOR", ethers.utils.id("OPERATOR")],
    ["WITHDRAWER", ethers.utils.id("WITHDRAWER")],
    ["DEFAULT_ADMIN", ethers.constants.HashZero],
  ];
  console.log(`Network ${network.name}, Payment ${paymentAddr}, fee ${(await payment.getFee()).toString()} bps`);
  console.log(`From ${deployer.address} to Safe ${safe}`);

  for (const [name, role] of roles) {
    if (await payment.hasRole(role, safe)) continue;
    const tx = await payment.grantRole(role, safe);
    console.log(`  grant ${name} to the Safe: ${tx.hash}`);
    await tx.wait();
  }
  for (const [name, role] of roles) {
    if (!(await payment.hasRole(role, safe))) throw new Error(`Safe lacks ${name}; not renouncing anything`);
  }
  console.log("  OK  the Safe holds every role");

  for (const [name, role] of roles) {
    if (!(await payment.hasRole(role, deployer.address))) continue;
    const tx = await payment.renounceRole(role, deployer.address);
    console.log(`  deployer renounces ${name}: ${tx.hash}`);
    await tx.wait();
  }
  for (const [name, role] of roles) {
    const d = await payment.hasRole(role, deployer.address);
    const s = await payment.hasRole(role, safe);
    console.log(`  ${name.padEnd(13)} deployer ${d}  Safe ${s}`);
    if (d || !s) throw new Error(`${name} not handed over`);
  }
  console.log(`  OK  fee still ${(await payment.getFee()).toString()} bps`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

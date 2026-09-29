/**
 * ShieldVault admin through the governance Safe: the vault owner's only two
 * powers (docs/plans/shield-vault.md, "Admin surface").
 *
 *   $env:SV_ACTION="pause"      # or "unpause", or "token"
 *   $env:SV_TOKEN="0x..."; $env:SV_SUPPORTED="true"   # SV_ACTION=token
 *   $env:SV_VAULT="0x..."       # optional, defaults to contract-addresses.json ShieldVault
 *   $env:SV_PRINT="1"           # print Safe{Wallet} calldata instead of sending
 *   npx hardhat run scripts/shield-vault-admin.ts --network mainnet
 *
 * Sends through the threshold-1 Safe with the deployer as owner
 * (scripts/utils/safe.ts); once the Safe is 2-of-3, use SV_PRINT=1.
 */
import { ethers, network } from "hardhat";
import { getContracts } from "./utils";
import { execViaSafe } from "./utils/safe";

const ABI = [
  "function owner() view returns (address)",
  "function depositsPaused() view returns (bool)",
  "function tokenSupported(address) view returns (bool)",
  "function setDepositsPaused(bool)",
  "function setTokenSupported(address,bool)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const book = getContracts()[network.name] as any;
  const vaultAddress: string = process.env.SV_VAULT || book?.ShieldVault?.address;
  const safe: string = book?.governance?.safe;
  if (!vaultAddress || !safe) throw new Error(`ShieldVault or governance.safe missing for ${network.name}`);
  const vault = new ethers.Contract(vaultAddress, ABI, signer as any);
  if ((await vault.owner()).toLowerCase() !== safe.toLowerCase()) throw new Error("vault owner is not the governance Safe");

  const action = process.env.SV_ACTION;
  let data: string;
  let check: () => Promise<string>;
  if (action === "pause" || action === "unpause") {
    data = vault.interface.encodeFunctionData("setDepositsPaused", [action === "pause"]);
    check = async () => `depositsPaused = ${await vault.depositsPaused()}`;
  } else if (action === "token") {
    const token = process.env.SV_TOKEN;
    if (!token) throw new Error("SV_TOKEN required");
    const on = process.env.SV_SUPPORTED !== "false";
    data = vault.interface.encodeFunctionData("setTokenSupported", [token, on]);
    check = async () => `tokenSupported(${token}) = ${await vault.tokenSupported(token)}`;
  } else {
    throw new Error('SV_ACTION must be "pause", "unpause" or "token"');
  }

  console.log(`Network ${network.name}, vault ${vaultAddress}, Safe ${safe}`);
  console.log(`Before: ${await check()}`);
  if (process.env.SV_PRINT === "1") {
    console.log(`Safe{Wallet} Transaction Builder: to ${vaultAddress}, value 0, data ${data}`);
    return;
  }
  const tx = await execViaSafe(signer as any, safe, vaultAddress, data);
  console.log(`Safe tx ${tx.hash}`);
  await tx.wait();
  console.log(`After:  ${await check()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

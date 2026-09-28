/**
 * Deploys ShieldVault (docs/plans/shield-vault.md): non-upgradeable, owned
 * from the first block by the governance Safe (contract-addresses.json
 * `governance.safe`), whose only powers are token curation and pausing new
 * deposits. Wired to the network's QuantumRecoveryRegistry.
 *
 *   npx hardhat run scripts/deploy-shield-vault.ts --network sepolia
 */
import { ethers, network, run } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts, saveContract, shouldVerify, sleep } from "./utils";

dotenv.config();

// Non-rebasing tokens only (the vault credits balance deltas; a rebasing
// token's growth would accrue to nobody). stETH is deliberately absent:
// wstETH is its wrapped, non-rebasing form.
const TOKENS: Record<string, Record<string, string>> = {
  mainnet: {
    wstETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  sepolia: {
    WETH: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
  },
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const book = getContracts()[network.name] as any;
  if (!book) throw new Error(`No addresses for ${network.name}`);
  const registry: string | undefined = book.QuantumRecoveryRegistry?.address;
  const safe: string | undefined = book.governance?.safe;
  if (!registry) throw new Error("QuantumRecoveryRegistry not recorded for this network");
  if (!safe) throw new Error("governance.safe not recorded for this network");

  const tokens = { ...(TOKENS[network.name] ?? {}) };
  // Sepolia rehearsals use the public-mint rehearsal token.
  if (network.name === "sepolia" && book.ERC20Token_R2USD?.address) tokens.R2USD = book.ERC20Token_R2USD.address;
  const tokenList = Object.values(tokens);
  if (tokenList.length === 0) throw new Error(`No token set for ${network.name}`);

  console.log(`Network ${network.name}, deployer ${deployer.address}`);
  console.log(`Registry ${registry}, owner (Safe) ${safe}`);
  console.log(`Tokens: ${Object.entries(tokens).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  const Factory = await ethers.getContractFactory("ShieldVault", deployer as any);
  const vault = await Factory.deploy(registry, safe, tokenList);
  await vault.deployed();
  console.log(`ShieldVault ${vault.address}, tx ${vault.deployTransaction.hash}`);

  if ((await vault.owner()).toLowerCase() !== safe.toLowerCase()) throw new Error("owner is not the Safe");
  if ((await vault.registry()).toLowerCase() !== registry.toLowerCase()) throw new Error("registry mismatch");
  for (const t of tokenList) if (!(await vault.tokenSupported(t))) throw new Error(`token ${t} not supported`);
  console.log("  OK  owner, registry and token set as intended");

  saveContract(network.name, "ShieldVault", vault.address);

  if (shouldVerify(network.name)) {
    await sleep(15_000);
    try {
      await run("verify:verify", {
        address: vault.address,
        constructorArguments: [registry, safe, tokenList],
        contract: "contracts/shield/ShieldVault.sol:ShieldVault",
      });
      console.log("  Etherscan verification: OK");
    } catch (e: any) {
      const msg = (e?.message ?? String(e)).toLowerCase();
      console.log(msg.includes("already verified") ? "  already verified" : `  verification failed (non-fatal): ${e?.message ?? e}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

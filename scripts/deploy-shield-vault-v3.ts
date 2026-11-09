/**
 * Deploys ShieldVault v3 (docs/plans/shield-vault.md, "v3"): a new,
 * non-upgradeable vault next to v2, owned from the first block by the
 * governance Safe (contract-addresses.json `governance.safe`), which also
 * receives the fees, so no ownership transfer follows. Wired to the
 * network's QuantumRecoveryRegistry, same token set as v2. Recorded under
 * `ShieldVaultV3`; `ShieldVault` stays the v2 address, whose holdings keep
 * their exits there. The switch that follows is in the plan, "v3: the switch".
 *
 *   $env:SV_FEE_BPS="25"   # optional: the release fee in basis points (default 25, max 50)
 *   npx hardhat run scripts/deploy-shield-vault-v3.ts --network sepolia
 *
 * Refuses to run when `ShieldVaultV3` is already recorded for the network,
 * unless SV_REDEPLOY=1. On the in-process `hardhat` network it is a
 * rehearsal: a fresh registry, a test token and a stand-in Safe, nothing
 * recorded.
 */
import { ethers, network, run } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts, saveContract, shouldVerify, sleep } from "./utils";

dotenv.config();

// The v2 set (scripts/deploy-shield-vault.ts): non-rebasing tokens only.
// Each must also meet the listing rule in docs/plans/shield-vault.md
// ("Tokens"): exact debits, no hooks, a `balanceOf` that never reverts.
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

const DEFAULT_FEE_BPS = 25;

async function main() {
  const [deployer, standIn] = await ethers.getSigners();
  const rehearsal = network.name === "hardhat";
  const book = getContracts()[network.name] as any;
  if (!rehearsal && !book) throw new Error(`No addresses for ${network.name}`);
  if (!rehearsal && book.ShieldVaultV3?.address && process.env.SV_REDEPLOY !== "1") {
    throw new Error(`ShieldVaultV3 already recorded for ${network.name} (${book.ShieldVaultV3.address}); SV_REDEPLOY=1 to replace it`);
  }

  let registry: string | undefined = book?.QuantumRecoveryRegistry?.address;
  let safe: string | undefined = book?.governance?.safe;
  const tokens = { ...(TOKENS[network.name] ?? {}) };
  // Sepolia rehearsals use the public-mint rehearsal token.
  if (network.name === "sepolia" && book.ERC20Token_R2USD?.address) tokens.R2USD = book.ERC20Token_R2USD.address;
  if (rehearsal) {
    registry = (await (await ethers.getContractFactory("QuantumRecoveryRegistry", deployer as any)).deploy()).address;
    safe = standIn.address;
    tokens.TEST = (await (await ethers.getContractFactory("MockAwkwardERC20", deployer as any)).deploy()).address;
  }
  if (!registry) throw new Error("QuantumRecoveryRegistry not recorded for this network");
  if (!safe) throw new Error("governance.safe not recorded for this network");
  if (!rehearsal && (await ethers.provider.getCode(safe)) === "0x") throw new Error(`governance.safe ${safe} has no code`);
  const tokenList = Object.values(tokens);
  if (tokenList.length === 0) throw new Error(`No token set for ${network.name}`);

  const feeRaw = process.env.SV_FEE_BPS ?? String(DEFAULT_FEE_BPS);
  if (!/^\d+$/.test(feeRaw) || Number(feeRaw) > 50) throw new Error("SV_FEE_BPS must be 0 to 50 (basis points)");
  const feeBps = Number(feeRaw);

  console.log(`Network ${network.name}${rehearsal ? " (rehearsal, nothing recorded)" : ""}, deployer ${deployer.address}`);
  console.log(`Registry ${registry}, owner and fee recipient (Safe) ${safe}, release fee ${feeBps} bps`);
  console.log(`Tokens: ${Object.entries(tokens).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  const args = [registry, safe, tokenList, safe, feeBps] as const;
  const Factory = await ethers.getContractFactory("ShieldVaultV3", deployer as any);
  const vault = await Factory.deploy(...args);
  await vault.deployed();
  const receipt = await vault.deployTransaction.wait();
  console.log(`ShieldVaultV3 ${vault.address}, tx ${vault.deployTransaction.hash}, block ${receipt.blockNumber}`);

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(await vault.owner(), safe)) throw new Error("owner is not the Safe");
  if (!same(await vault.pendingOwner(), ethers.constants.AddressZero)) throw new Error("a pending owner is set");
  if (!same(await vault.registry(), registry)) throw new Error("registry mismatch");
  if (!same(await vault.feeRecipient(), safe)) throw new Error("fee recipient is not the Safe");
  if ((await vault.feeBps()) !== feeBps) throw new Error("fee mismatch");
  if ((await vault.MAX_FEE_BPS()) !== 50) throw new Error("fee cap is not 50 bps");
  if (await vault.depositsPaused()) throw new Error("deposits paused at birth");
  for (const t of tokenList) if (!(await vault.tokenSupported(t))) throw new Error(`token ${t} not supported`);
  const domain = await vault.eip712Domain();
  if (domain.name !== "10102 ShieldVault" || domain.version !== "2" || !same(domain.verifyingContract, vault.address)) {
    throw new Error("unexpected EIP-712 domain");
  }
  const size = (await ethers.provider.getCode(vault.address)).length / 2 - 1;
  console.log(`  OK  owner, registry, fee, cap, tokens and signing domain as intended; runtime ${size} bytes`);

  if (rehearsal) return;
  saveContract(network.name, "ShieldVaultV3", vault.address);
  const v2 = book.ShieldVault?.address;
  console.log(`  recorded as ShieldVaultV3; ShieldVault (v2) stays ${v2 ?? "unset"}`);
  console.log(`  next: Etherscan, then the switch in docs/plans/shield-vault.md ("v3: the switch")`);

  if (shouldVerify(network.name)) {
    await vault.deployTransaction.wait(5);
    await sleep(15_000);
    try {
      await run("verify:verify", {
        address: vault.address,
        constructorArguments: [...args],
        contract: "contracts/shield/ShieldVaultV3.sol:ShieldVaultV3",
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

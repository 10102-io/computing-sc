/**
 * Pre-flight sanity check for a mainnet Phase A rollout.
 * Read-only. Confirms:
 *   - we're actually on mainnet
 *   - the deployer address matches the on-chain DefaultProxyAdmin owner
 *     (i.e. we have authority to upgrade)
 *   - the deployer has enough ETH for the cascade (rough heuristic: 0.05 ETH)
 *   - the seven Phase A target proxies are admin-managed
 */
import { ethers, deployments, network } from "hardhat";

async function main() {
  if (network.name !== "mainnet") {
    throw new Error(`Refusing to run preflight on non-mainnet (${network.name})`);
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  console.log(`Network:    ${network.name} (chainId=${chainId})`);
  console.log(`Deployer:   ${deployerAddr}`);

  const balance = await ethers.provider.getBalance(deployerAddr);
  const balanceEth = ethers.utils.formatEther(balance);
  console.log(`Balance:    ${balanceEth} ETH`);

  const adminAddr = (await deployments.get("DefaultProxyAdmin")).address;
  const admin = new ethers.Contract(
    adminAddr,
    [
      "function owner() view returns (address)",
      "function getProxyImplementation(address) view returns (address)",
    ],
    ethers.provider,
  );
  const owner: string = await admin.owner();
  console.log(`Admin:      ${adminAddr}`);
  console.log(`Admin owner ${owner}`);

  const authOk = owner.toLowerCase() === deployerAddr.toLowerCase();
  console.log(`Deployer == admin owner: ${authOk ? "✓" : "✗ MISMATCH — wrong key"}`);

  // Phase A: confirm all 6 proxies are admin-managed
  const PROXIES = [
    "PremiumRegistry",
    "TransferEOALegacyRouter",
    "MultisigLegacyRouter",
    "LegacyDeployer",
    "PremiumSetting",
    "EIP712LegacyVerifier",
  ];
  let allManaged = true;
  console.log(`\nProxy impl readbacks:`);
  for (const name of PROXIES) {
    const addr = (await deployments.get(name)).address;
    try {
      const impl: string = await admin.getProxyImplementation(addr);
      console.log(`  ${name.padEnd(28)} ${addr}  impl=${impl}`);
    } catch (e: any) {
      console.log(`  ${name.padEnd(28)} ${addr}  ✗ NOT MANAGED BY THIS ADMIN`);
      allManaged = false;
    }
  }

  const balanceOk = balance.gte(ethers.utils.parseEther("0.05"));
  console.log(`\nBalance >= 0.05 ETH: ${balanceOk ? "✓" : "✗ TOP UP DEPLOYER"}`);
  console.log(`All proxies managed:  ${allManaged ? "✓" : "✗"}`);
  console.log(`\nPreflight: ${authOk && balanceOk && allManaged ? "PASS ✓ — safe to deploy" : "FAIL ✗ — do NOT deploy"}`);

  if (!(authOk && balanceOk && allManaged)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

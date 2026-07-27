/**
 * Read-only preflight for the create-flow v2 rollout (Sepolia rehearsal /
 * mainnet later). Checks everything the upgrade scripts assume, sends no txs:
 *
 *   npx hardhat run scripts/preflight-create-flow-v2.ts --network sepolia
 */
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

async function main() {
  const network = hre.network.name;
  const [deployer] = await ethers.getSigners();
  const contracts = getContracts()[network];
  if (!contracts) throw new Error(`No addresses for "${network}"`);

  console.log(`Network:  ${network}`);
  console.log(`Deployer: ${deployer.address}`);
  const bal = await deployer.getBalance();
  console.log(`Balance:  ${ethers.utils.formatEther(bal)} ETH`);

  // 1. ProxyAdmin ownership
  const proxyAdmin = await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function getProxyImplementation(address) view returns (address)"
    ],
    contracts["DefaultProxyAdmin"].address
  );
  const adminOwner = await proxyAdmin.owner();
  console.log(`\nProxyAdmin:       ${contracts["DefaultProxyAdmin"].address}`);
  console.log(`ProxyAdmin owner: ${adminOwner} ${adminOwner.toLowerCase() === deployer.address.toLowerCase() ? "(= deployer, OK)" : "(NOT DEPLOYER — ABORT)"}`);

  // 2. Current router implementations
  for (const name of ["TransferEOALegacyRouter", "TimeLockRouter"]) {
    const proxy = contracts[name].address;
    const impl = await proxyAdmin.getProxyImplementation(proxy);
    console.log(`\n${name}`);
    console.log(`  proxy: ${proxy}`);
    console.log(`  impl (on-chain):  ${impl}`);
    console.log(`  impl (manifest):  ${contracts[name].implementation ?? "(none)"}`);
  }

  // 3. EOA router state that must survive the upgrade
  const eoaRouter = await ethers.getContractAt(
    "TransferEOALegacyRouter",
    contracts["TransferEOALegacyRouter"].address
  );
  const legacyImpl = await eoaRouter.legacyImplementation();
  console.log(`\nEOA router legacyImplementation: ${legacyImpl}`);

  // 4. Canonical Permit2 must have code on this chain
  const permit2Code = await ethers.provider.getCode(PERMIT2);
  console.log(`\nPermit2 @ ${PERMIT2}: ${permit2Code === "0x" ? "NO CODE — ABORT" : `code present (${(permit2Code.length - 2) / 2} bytes)`}`);
  if (permit2Code !== "0x") {
    const permit2 = await ethers.getContractAt(
      ["function DOMAIN_SEPARATOR() view returns (bytes32)"],
      PERMIT2
    );
    console.log(`Permit2 DOMAIN_SEPARATOR: ${await permit2.DOMAIN_SEPARATOR()}`);
  }

  // 5. New functions must NOT exist yet on the live impls (sanity that we're
  //    actually upgrading something)
  const probeEoa = await ethers.provider.call({
    to: contracts["TransferEOALegacyRouter"].address,
    data: new ethers.utils.Interface(["function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])"]).encodeFunctionData("eip712Domain")
  }).then(() => "already present", () => "absent (expected pre-upgrade)");
  console.log(`\nEOA router eip712Domain(): ${probeEoa}`);

  const probeTl = await ethers.provider.call({
    to: contracts["TimeLockRouter"].address,
    data: new ethers.utils.Interface(["function sponsoredDomainSeparator() view returns (bytes32)"]).encodeFunctionData("sponsoredDomainSeparator")
  }).then(() => "already present", () => "absent (expected pre-upgrade)");
  console.log(`TimeLockRouter sponsoredDomainSeparator(): ${probeTl}`);

  // 6. Whitelisted test tokens (for the smoke test)
  for (const t of ["ERC20Token_USDC", "ERC20Token_USDT"]) {
    if (contracts[t]) console.log(`${t}: ${contracts[t].address}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

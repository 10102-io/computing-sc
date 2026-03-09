/**
 * Deploys TransferEOALegacyRouter fresh (bypasses hardhat-deploy / DefaultProxyAdmin issues).
 * Uses ERC1967Proxy so no ProxyAdmin is required.
 *
 * Run: npx hardhat run scripts/deploy-eoa-router.ts --network sepolia
 *
 * Prerequisites: RPC and DEPLOYER_PRIVATE_KEY in .env.
 */
import { network, ethers } from "hardhat";
import { getContracts, saveContract, getExternalAddresses } from "./utils";

async function main() {
  const contracts = getContracts()[network.name];
  if (!contracts) throw new Error(`No contracts for network ${network.name}`);

  const [signer] = await ethers.getSigners();
  console.log("Deployer:", signer.address);

  const legacyDeployer = contracts.LegacyDeployer?.address;
  const setting = contracts.PremiumSetting?.address;
  const verifierTerm = contracts.EIP712LegacyVerifier?.address;
  const payment = contracts.Payment?.address;
  if (!legacyDeployer || !setting || !verifierTerm || !payment) {
    throw new Error("Missing dependency addresses in contract-addresses.json");
  }
  const { uniswapRouter, weth } = getExternalAddresses(network.name);

  console.log("Dependencies:", { legacyDeployer, setting, verifierTerm, payment, uniswapRouter, weth });

  // 1. Deploy implementation
  const RouterFactory = await ethers.getContractFactory("TransferEOALegacyRouter");
  const impl = await RouterFactory.deploy();
  await impl.deployed();
  console.log("TransferEOALegacyRouter implementation:", impl.address);

  // 2. Deploy ERC1967Proxy with initialize calldata
  const initData = RouterFactory.interface.encodeFunctionData("initialize", [
    legacyDeployer,
    setting,
    verifierTerm,
    payment,
    uniswapRouter,
    weth,
  ]);
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await ProxyFactory.deploy(impl.address, initData);
  await proxy.deployed();
  console.log("TransferEOALegacyRouter proxy:", proxy.address);

  // 3. Attach router interface to proxy
  const router = RouterFactory.attach(proxy.address).connect(signer);

  // 4. initializeV2 — sets _codeAdmin so setLegacyCreationCode can be called
  const txV2 = await (router as any).initializeV2(signer.address);
  await txV2.wait();
  console.log("initializeV2 done, codeAdmin:", signer.address);

  // 5. Set legacy creation code (TransferEOALegacy bytecode, includes our autoSwap/unswap)
  const EOALegacy = await ethers.getContractFactory("TransferEOALegacy");
  const txCode = await (router as any).setLegacyCreationCode(EOALegacy.bytecode);
  await txCode.wait();
  console.log("setLegacyCreationCode done, bytecode length:", EOALegacy.bytecode.length);

  // 6. Persist
  saveContract(network.name, "TransferEOALegacyRouter", proxy.address, impl.address);
  console.log("Saved to contract-addresses.json:", proxy.address);
  console.log("Done. Next: run deploy/init/0.set_up_legacy.ts to wire up routers.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

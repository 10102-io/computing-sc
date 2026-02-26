import { ethers } from "hardhat";
import { deployProxy } from "../test/utils/proxy";

async function main() {
  const [treasury] = await ethers.getSigners();

  const premiumSetting = await deployProxy("PremiumSetting", [], "initialize", treasury);
  const Payment = await ethers.getContractFactory("Payment");
  const payment = await Payment.deploy();
  const ERC20 = await ethers.getContractFactory("ERC20Token");
  const usdc = await ERC20.deploy("USDC", "USDC", 6);
  const usdt = await ERC20.deploy("USDT", "USDT", 6);
  const premiumRegistry = await deployProxy("PremiumRegistry", [
    usdt.address, usdc.address,
    "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
    "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
    "0x694AA1769357215DE4FAC081bf1f309aDC325306",
    premiumSetting.address, payment.address,
  ], "initialize", treasury);
  const verifier = await deployProxy("EIP712LegacyVerifier", [treasury.address]);
  const legacyDeployer = await deployProxy("LegacyDeployer");
  const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
  const mockRouter = await MockRouter.deploy();

  const router = await deployProxy("TransferEOALegacyRouter", [
    legacyDeployer.address, premiumSetting.address, verifier.address,
    payment.address, mockRouter.address, "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"
  ]);

  console.log("Router deployed at:", router.address);

  try {
    const tx = await router.connect(treasury).initializeV2(treasury.address);
    await tx.wait();
    console.log("initializeV2 succeeded");
  } catch (e: any) {
    console.log("initializeV2 FAILED:", e.message);
    return;
  }

  const Factory = await ethers.getContractFactory("TransferEOALegacy");
  const code = Factory.bytecode;
  console.log("Creation code length (bytes):", code.length / 2);

  try {
    const gasEstimate = await router.connect(treasury).estimateGas.setLegacyCreationCode(code);
    console.log("Gas estimate:", gasEstimate.toString());
    const tx = await router.connect(treasury).setLegacyCreationCode(code, { gasLimit: gasEstimate.mul(12).div(10) });
    await tx.wait();
    console.log("setLegacyCreationCode succeeded");
  } catch (e: any) {
    console.log("setLegacyCreationCode FAILED:", e.message);
  }
}

main().catch(console.error);

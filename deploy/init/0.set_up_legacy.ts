import { DeployFunction } from "hardhat-deploy/dist/types";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

import * as fs from "fs";
import { getContracts, getProvider } from "../../scripts/utils";
import { network } from "hardhat";

const LegacyDeployer = JSON.parse(
    fs.readFileSync(
        "./artifacts/contracts/common/LegacyDeployer.sol/LegacyDeployer.json",
        "utf-8"
    )
).abi;

const VerifierTerm = JSON.parse(
    fs.readFileSync(
        "./artifacts/contracts/term/VerifierTerm.sol/EIP712LegacyVerifier.json",
        "utf-8"
    )
).abi;

const PremiumSetting = JSON.parse(
    fs.readFileSync(
        "./artifacts/contracts/premium/PremiumSetting.sol/PremiumSetting.json",
        "utf-8"
    )
).abi;

async function setRouterAtVerifierTerm(
    verifier: string,
    transferEOALegacyRouter: string,
    transferLegacyRouter: string,
    multisigLegacyRouter: string
) {
    console.log("Calling setRouterAtVerifierTerm at VerifierTerm...")
    const { wallet } = getProvider();
    const contract = new ethers.Contract(verifier, VerifierTerm, wallet);
    const tx = await contract.setRouterAddresses(transferEOALegacyRouter, transferLegacyRouter, multisigLegacyRouter);

    console.log("Raw data:", tx?.data);

    const receipt = await tx.wait();
    console.log("Receipt:", receipt);
}

async function setParamsAtLegacyDeployer(
    legacyDeployer: string,
    multisigLegacyRouter: string,
    transferLegacyRouter: string,
    transferEOALegacyRouter: string
) {
    console.log("Calling setParams at LegacyDeployer...");
    const { wallet } = getProvider();
    const contract = new ethers.Contract(legacyDeployer, LegacyDeployer, wallet);

    const tx = await contract.setParams(multisigLegacyRouter, transferLegacyRouter, transferEOALegacyRouter);

    console.log("Raw data:", tx?.data);

    const receipt = await tx.wait();
    console.log("Receipt:", receipt);


}

async function setParamsAtPremiumSetting(
    premiumSetting: string,
    premiumRegistry: string,
    transferLegacyRouter: string,
    transferEOALegacyRouter: string,
    multisigLegacyRouter: string
) {
    console.log("Calling setParams at PremiumSetting...");
    const { wallet } = getProvider();
    const contract = new ethers.Contract(premiumSetting, PremiumSetting, wallet);

    const tx = await contract.setParams(premiumRegistry, transferLegacyRouter, transferEOALegacyRouter, multisigLegacyRouter);

    console.log("Raw data:", tx?.data);

    const receipt = await tx.wait();
    console.log("Receipt:", receipt);
}

async function main() {
    const contracts = getContracts();
    const networkContracts = contracts[network.name];
    if (!networkContracts) {
        throw new Error(`No contract addresses found for network: ${network.name}. Deploy contracts first.`);
    }
    const verifier = networkContracts["EIP712LegacyVerifier"].address;
    const legacyDeployer = networkContracts["LegacyDeployer"].address;
    const premiumSetting = networkContracts["PremiumSetting"].address;
    const premiumRegistry = networkContracts["PremiumRegistry"].address;
    const multisigLegacyRouter = networkContracts["MultisigLegacyRouter"].address;
    const transferLegacyRouter = networkContracts["TransferLegacyRouter"].address;
    const transferEOALegacyRouter = networkContracts["TransferEOALegacyRouter"].address;

    await setRouterAtVerifierTerm(verifier, transferEOALegacyRouter, transferLegacyRouter, multisigLegacyRouter);
    await setParamsAtLegacyDeployer(legacyDeployer, multisigLegacyRouter, transferLegacyRouter, transferEOALegacyRouter);
    await setParamsAtPremiumSetting(premiumSetting, premiumRegistry, transferLegacyRouter, transferEOALegacyRouter, multisigLegacyRouter);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

const setUpLegacy: DeployFunction = async () => {
  /* Run via: npx hardhat run deploy/init/0.set_up_legacy.ts --network <network> */
};
setUpLegacy.tags = ["init", "set_up_legacy"];
setUpLegacy.id = "set_up_legacy";
export default setUpLegacy;
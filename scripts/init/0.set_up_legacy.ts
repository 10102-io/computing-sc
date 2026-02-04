import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

import * as fs from "fs";
import { getContracts, getProvider } from "../utils";
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

async function main() {
    const contracts = getContracts();
    const networkContracts = contracts[network.name];
    if (!networkContracts) {
        throw new Error(`No contract addresses found for network: ${network.name}. Deploy contracts first.`);
    }
    const verifier = networkContracts["EIP712LegacyVerifier"].address;
    const legacyDeployer = networkContracts["LegacyDeployer"].address;
    const multisigLegacyRouter = networkContracts["MultisigLegacyRouter"].address;
    const transferLegacyRouter = networkContracts["TransferLegacyRouter"].address;
    const transferEOALegacyRouter = networkContracts["TransferEOALegacyRouter"].address;

    await setRouterAtVerifierTerm(verifier, transferEOALegacyRouter, transferLegacyRouter, multisigLegacyRouter);
    await setParamsAtLegacyDeployer(legacyDeployer, multisigLegacyRouter, transferLegacyRouter, transferEOALegacyRouter);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

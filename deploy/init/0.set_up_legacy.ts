import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

import * as fs from "fs";
import { getContracts, getProvider } from "../../scripts/utils";
import { network } from "hardhat";



const contracts = getContracts();
const verifier = contracts[network.name]["EIP712LegacyVerifier"].address;
const legacyDeployer = contracts[network.name]["LegacyDeployer"].address;

//legacy router
const multisigLegacyRouter = contracts[network.name]["MultisigLegacyRouter"].address;
const transferLegacyRouter = contracts[network.name]["TransferLegacyRouter"].address;
const transferEOALegacyRouter = contracts[network.name]["TransferEOALegacyRouter"].address;



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

async function setRouterAtVerifierTerm() {
    console.log("Calling setRouterAtVerifierTerm at VerifierTerm...")
    const { provider, wallet } = getProvider();
    const contract = new ethers.Contract(verifier, VerifierTerm, wallet);
    const tx = await contract.setRouterAddresses(transferEOALegacyRouter, transferLegacyRouter, multisigLegacyRouter);

    console.log("Raw data:", tx?.data);
    
    const receipt = await tx.wait();
    console.log("Receipt:", receipt);
}

async function setParamsAtLegacyDeployer() {
    console.log("Calling setParams at LegacyDeployer...");
    const { provider, wallet } = getProvider();
    const contract = new ethers.Contract(legacyDeployer, LegacyDeployer, wallet);

    const tx = await contract.setParams(multisigLegacyRouter, transferLegacyRouter, transferEOALegacyRouter);

    console.log("Raw data:", tx?.data);
    
    const receipt = await tx.wait();
    console.log("Receipt:", receipt);


}

async function main() {
   
    await setRouterAtVerifierTerm();
    await setParamsAtLegacyDeployer();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
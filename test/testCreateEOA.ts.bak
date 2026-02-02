// scripts/test-create-legacy.ts

import { ethers } from "hardhat";
import type { Signer } from "ethers";

async function main() {
  const [deployer] = await ethers.getSigners();

  const contractAddress = "0xF3E80D1A9d95CB6A05079872872709766Ed6dd8a";

  const abi = [ 
  {
    "inputs":[
      {
        "components":[
          {"internalType":"string","name":"name","type":"string"},
          {"internalType":"string","name":"note","type":"string"},
          {"internalType":"string[]","name":"nickNames","type":"string[]"},
          {
            "components":[
              {"internalType":"address","name":"user","type":"address"},
              {"internalType":"uint8","name":"percent","type":"uint8"}
            ],
            "internalType":"struct TransferLegacyStruct.Distribution[]",
            "name":"distributions",
            "type":"tuple[]"
          }
        ],
        "internalType":"struct TransferEOALegacyRouter.LegacyMainConfig",
        "name":"mainConfig_",
        "type":"tuple"
      },
      {
        "components":[
          {"internalType":"uint128","name":"lackOfOutgoingTxRange","type":"uint128"},
          {"internalType":"uint256","name":"delayLayer2","type":"uint256"},
          {"internalType":"uint256","name":"delayLayer3","type":"uint256"}
        ],
        "internalType":"struct TransferLegacyStruct.LegacyExtraConfig",
        "name":"extraConfig_",
        "type":"tuple"
      },
      {
        "components":[
          {"internalType":"address","name":"user","type":"address"},
          {"internalType":"uint8","name":"percent","type":"uint8"}
        ],
        "internalType":"struct TransferLegacyStruct.Distribution",
        "name":"layer2Distribution_",
        "type":"tuple"
      },
      {
        "components":[
          {"internalType":"address","name":"user","type":"address"},
          {"internalType":"uint8","name":"percent","type":"uint8"}
        ],
        "internalType":"struct TransferLegacyStruct.Distribution",
        "name":"layer3Distribution_",
        "type":"tuple"
      },
      {"internalType":"string","name":"nickName2","type":"string"},
      {"internalType":"string","name":"nickName3","type":"string"}
    ],
    "name":"createLegacy",
    "outputs":[{"internalType":"address","name":"","type":"address"}],
    "stateMutability":"nonpayable",
    "type":"function"
  }
];

const contract = new ethers.Contract(contractAddress, abi, deployer as unknown as Signer);


  const mainConfig = {
    name: "abc",
    note: "nothing",
    nickNames: ["dadad"],
    distributions: [
      {
        user: "0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae",
        percent: 100
      }
    ]
  };

  const extraConfig = {
    lackOfOutgoingTxRange: 1,
    delayLayer2: 1,
    delayLayer3: 0
  };

  const layer2Distribution = {
    user: "0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae",
    percent: 100
  };

  const layer3Distribution = {
    user: "",
    percent: 0
  };

  const nickName2 = "daddd";
  const nickName3 = "";

  const tx = await contract.createLegacy(
    mainConfig,
    extraConfig,
    layer2Distribution,
    layer3Distribution,
    nickName2,
    nickName3,
    {
      gasLimit: 5000000, 
      gasPrice: ethers.utils.parseUnits("10", "gwei"), 
    }
  );

  console.log("Transaction hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("Transaction mined at:", receipt.blockNumber);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

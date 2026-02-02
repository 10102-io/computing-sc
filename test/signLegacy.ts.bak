import Web3 from "web3";
import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

// ========== CONFIGURATION ===========
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL!;
let PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY!;
const LEGACY_ROUTER = "0x9Deca1c4547E2a9d4679aDff52616986adA848dB";
const EXPECTED_USER_ADDRESS = "0x00005e2b5E613408d02b27d8133C6894AC949C06";

const LEGACY_ROUTER_ABI = JSON.parse(
  fs.readFileSync(
    "./artifacts/contracts/forwarding/TransferLegacyEOAContractRouter.sol/TransferEOALegacyRouter.json",
    "utf-8"
  )
).abi;
// ==============================

if (!PRIVATE_KEY.startsWith("0x")) PRIVATE_KEY = "0x" + PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
  throw new Error("Invalid PRIVATE_KEY: needs 0x prefix and 64 hex characters.");
}

const web3 = new Web3(SEPOLIA_RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY);
const user = wallet.address;

console.log("User address:", user);
console.log("PRIVATE_KEY (partially hidden):", PRIVATE_KEY.slice(0, 10) + "********************");
console.log("PRIVATE_KEY length:", PRIVATE_KEY.length);

if (user.toLowerCase() !== EXPECTED_USER_ADDRESS.toLowerCase()) {
  console.warn(`WARNING: user (${user}) does not match EXPECTED_USER_ADDRESS (${EXPECTED_USER_ADDRESS})`);
}

// ===== CALCULATE LEGACY ADDRESS ACCORDING TO FACTORY =====
async function computeCreate2AddressEOAFactory(
  sender: string,
  nonce: number,
  bytecode: string
): Promise<string> {
  const salt = ethers.utils.keccak256(ethers.utils.solidityPack(["address", "uint256"], [sender, nonce]));
  const bytecodeHash = ethers.utils.keccak256(bytecode);
  return ethers.utils.getCreate2Address(LEGACY_ROUTER, salt, bytecodeHash);
}

// ===== CREATE SIGNATURE =====
async function generateLegacySignature(): Promise<{ signature: string; timestamp: number; legacyAddress: string }> {
  const router = new web3.eth.Contract(LEGACY_ROUTER_ABI, LEGACY_ROUTER);
  const currentNonce = await router.methods.nonceByUsers(user).call();
  const nextNonce = Number(currentNonce) + 1;

  const bytecodeRaw = fs.readFileSync(
    "./artifacts/contracts/forwarding/TransferLegacyEOAContract.sol/TransferEOALegacy.json",
    "utf-8"
  );
  const parsed = JSON.parse(bytecodeRaw);
  const legacyBytecode = parsed.bytecode;

  const legacyAddress = (await computeCreate2AddressEOAFactory(user, nextNonce, legacyBytecode)).toLowerCase();
  console.log("Predicted legacy address:", legacyAddress);

  const timestamp = Math.floor(Date.now() / 1000);
  console.log("Timestamp:", timestamp);

  const message = `I agree to legacy at address ${legacyAddress} at timestamp ${timestamp}`;
  console.log("Message:", message);

  const messageHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(message));
  const signature = await wallet.signMessage(ethers.utils.arrayify(messageHash));
  console.log("Signature:", signature);

  const ethSignedMessageHash = ethers.utils.hashMessage(ethers.utils.arrayify(messageHash));
  const recoveredAddress = ethers.utils.recoverAddress(ethSignedMessageHash, signature);
  console.log("Recovered address:", recoveredAddress);
  console.log("Expected address:", user);

  if (recoveredAddress.toLowerCase() !== user.toLowerCase()) {
    throw new Error("Signature verification failed: recoveredAddress !== user");
  }

  return { signature, timestamp, legacyAddress };
}

async function main() {
  const { signature, timestamp } = await generateLegacySignature();

  const router = new web3.eth.Contract(LEGACY_ROUTER_ABI, LEGACY_ROUTER);
  const txCount = await web3.eth.getTransactionCount(user);

  const mainConfig = {
    name: "abc",
    note: "nothing",
    nickNames: ["dadad"],
    distributions: [
      {
        user: "0x74B39049851D8dE8390e665CA4A59903B25E373E",
        percent: 100,
      },
    ],
  };

  const extraConfig = {
    lackOfOutgoingTxRange: 1,
    delayLayer2: 1,
    delayLayer3: 1,
  };

  const layer2Distribution = {
    user: "0xC822DcaD6f4e7CD8B6e80CAd1AFA3F97ae8579CD",
    percent: 100,
  };

  const layer3Distribution = {
    user: "0x6f5e0e8B41CD7Fa814cD4eBe31dCD16F2Ef58372",
    percent: 100,
  };

  const txData = router.methods
    .createLegacy(
      mainConfig,
      extraConfig,
      layer2Distribution,
      layer3Distribution,
      "layer2",
      "layer3",
      timestamp,
      signature
    )
    .encodeABI();

  try {
    await router.methods
      .createLegacy(
        mainConfig,
        extraConfig,
        layer2Distribution,
        layer3Distribution,
        "layer2",
        "layer3",
        timestamp,
        signature
      )
      .call({ from: user });
  } catch (err: any) {
    const revertData = err?.data;
    if (revertData && revertData.startsWith("0x08c379a0")) {
      const reason = web3.utils.toAscii("0x" + revertData.slice(138));
      console.error("Transaction reverted with reason:", reason);
    } else {
      console.error("Transaction reverted:", err.message || err);
    }
    process.exit(1);
  }

  const gasEstimate = await router.methods
    .createLegacy(
      mainConfig,
      extraConfig,
      layer2Distribution,
      layer3Distribution,
      "layer2",
      "layer3",
      timestamp,
      signature
    )
    .estimateGas({ from: user });

  console.log("Gas estimate:", gasEstimate);

  const tx = {
    nonce: txCount,
    gas: web3.utils.toHex(Math.floor(Number(gasEstimate) * 1.2)),
    gasPrice: await web3.eth.getGasPrice(),
    data: txData,
    to: LEGACY_ROUTER,
    from: user,
  };

  const signedTx = await web3.eth.accounts.signTransaction(tx, PRIVATE_KEY);
  const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction!);

  console.log("\nTransaction successful:");
  console.log("Signature:", signature);
  console.log("Timestamp:", timestamp);
  console.log("Tx Hash:", receipt.transactionHash);
}

main().catch((err) => {
  console.error("Transaction failed:", err.message || err);
});
/**
 * Deploy all contracts to Sepolia in dependency order.
 * Run from project root: npx hardhat run scripts/deploy-sepolia.ts --network sepolia
 */
import { execSync } from "child_process";

const NETWORK = "sepolia";

const TAGS_IN_ORDER = [
  "Payment",
  "Banner",
  "EIP712LegacyVerifier",
  "LegacyDeployer",
  "PremiumSetting",
  "MultisigLegacyRouter",
  "TransferLegacyRouter",
  "TransferEOALegacyRouter",
  "TimeLockRouter",
  "TimelockERC20",
  "TimelockERC721",
  "TimelockERC1155",
  "PremiumRegistry",
  "PremiumAutomationManager",
  "PremiumSendMail",
  "PremiumMailRouter",
  "PremiumMailBeforeActivation",
  "PremiumMailReadyToActivate",
  "PremiumMailActivated",
];

function main(): void {
  for (const tag of TAGS_IN_ORDER) {
    console.log(`\n>>> Deploying ${tag}...\n`);
    execSync(`npx hardhat deploy --network ${NETWORK} --tags ${tag}`, {
      stdio: "inherit",
    });
  }
  console.log("\n>>> All contracts deployed to Sepolia.\n");
}

main();

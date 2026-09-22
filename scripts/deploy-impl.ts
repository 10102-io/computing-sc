/**
 * Deploy new implementations for proxied contracts WITHOUT touching the
 * proxies. The upgrade itself is a timelock operation (timelock-op.ts); this
 * script only produces the artifacts that operation needs:
 *
 *   - deploys each implementation, waits for confirmations, verifies on
 *     Etherscan when configured,
 *   - records it as `<Name>.pendingImplementation` in contract-addresses.json
 *     (the live `implementation` field is updated only after execution, by
 *     scripts/refresh-impl-artifacts.ts),
 *   - writes output/upgrade-batch-<network>.json for TL_BATCH.
 *
 *   $env:IMPLS="TimeLockRouter,TimelockERC20,TimelockERC721,TimelockERC1155"
 *   npx hardhat run scripts/deploy-impl.ts --network sepolia
 *
 * Run scripts/dump-storage-layouts.ts before and after the source change and
 * diff the two files first; this script does not check layouts.
 */
import * as fs from "fs";
import * as path from "path";
import * as hre from "hardhat";
import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts, shouldVerify } from "./utils";

dotenv.config();

const ALLOWED = [
  "TimeLockRouter",
  "TimelockERC20",
  "TimelockERC721",
  "TimelockERC1155",
  "TransferEOALegacyRouter",
  "MultisigLegacyRouter",
  "EIP712LegacyVerifier",
  "PremiumRegistry",
  "PremiumSetting",
];

async function main() {
  const names = (process.env.IMPLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) throw new Error(`Set IMPLS to a comma list of: ${ALLOWED.join(", ")}`);
  for (const n of names) if (!ALLOWED.includes(n)) throw new Error(`${n} is not an upgradeable deployment here.`);

  const [deployer] = await ethers.getSigners();
  const book = getContracts();
  const net = book[network.name];
  if (!net) throw new Error(`No addresses for ${network.name}`);
  console.log(`Network ${network.name}, deployer ${deployer.address}`);

  const batch: Array<{ proxy: string; impl: string }> = [];
  for (const name of names) {
    const proxy = net[name]?.address;
    if (!proxy) throw new Error(`${name} proxy not recorded for ${network.name}`);
    const factory = await ethers.getContractFactory(name);
    const impl = await factory.deploy();
    console.log(`${name}: deploying implementation, tx ${impl.deployTransaction.hash}`);
    await impl.deployTransaction.wait(network.name === "hardhat" || network.name === "localhost" ? 1 : 2);
    console.log(`${name}: implementation ${impl.address}`);

    if (shouldVerify(network.name)) {
      try {
        await hre.run("verify:verify", { address: impl.address, constructorArguments: [] });
        console.log(`${name}: verified`);
      } catch (err: any) {
        console.warn(`${name}: verify failed or already verified: ${err?.message ?? err}`);
      }
    }

    (net[name] as any).pendingImplementation = impl.address;
    batch.push({ proxy: name, impl: impl.address });
  }

  book[network.name] = net;
  const bookPath = path.join(__dirname, "..", "contract-addresses.json");
  fs.writeFileSync(bookPath, JSON.stringify(book, null, 2) + "\n");

  const outDir = path.join(__dirname, "..", "output");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `upgrade-batch-${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(batch, null, 2));
  console.log(`\nWrote pendingImplementation entries and ${path.relative(process.cwd(), file)}.`);
  console.log(`Next: $env:TL_ACTION="print"; $env:TL_BATCH="${path.relative(process.cwd(), file)}"; npx hardhat run scripts/timelock-op.ts --network ${network.name}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

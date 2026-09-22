/**
 * Governance hardening, Track A of docs/plans/round-2026-09.md.
 *
 * Every step prints what it would do (targets, calldata, operation id and
 * eta for scheduled steps) and does nothing unless GOV_EXECUTE=1. Targets are
 * read from contract-addresses.json and cross-checked live; the script
 * refuses to send when the recorded Safe or guardian does not match what the
 * chain shows (a typo here would be a one-step, irreversible mistake).
 *
 *   GOV_STEP = 1   transferOwnership(UpgradeTimelock) on the three vaults   (instant, EOA)
 *   GOV_STEP = 1b  transferOwnership(Safe) on TimeLockRouter                (instant, EOA)
 *   GOV_STEP = 2a  batch: grantRole(PROPOSER, Safe), grantRole(CANCELLER,
 *                  guardian…), revokeRole(CANCELLER, EOA)                    (scheduled, delay)
 *   GOV_STEP = 2c  revokeRole(PROPOSER, EOA)                                 (scheduled; only
 *                  after the Safe threshold is 2)
 *   GOV_STEP = 3   updateDelay(604800)                                       (scheduled; last)
 *
 * Scheduled steps are handed to timelock-op.ts semantics in-process: they
 * compute the same salt/id, so `TL_ACTION=execute` with the batch file this
 * script writes (output/governance-<step>-<network>.json) executes them.
 *
 *   $env:GOV_STEP="1"; npx hardhat run scripts/harden-governance.ts --network sepolia
 *   $env:GOV_STEP="1"; $env:GOV_EXECUTE="1"; npx hardhat run scripts/harden-governance.ts --network sepolia
 */
import * as fs from "fs";
import * as path from "path";
import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts } from "./utils";
import { readSafe } from "./utils/safe";

dotenv.config();

const ZERO32 = "0x" + "00".repeat(32);
const MAINTAINER = "0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630";
const ROLE = (name: string) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name));
const PROPOSER = ROLE("PROPOSER_ROLE");
const CANCELLER = ROLE("CANCELLER_ROLE");
const SEVEN_DAYS = 604800;

const OWNABLE = ["function owner() view returns (address)", "function transferOwnership(address)"];
const TL_ABI = [
  "function getMinDelay() view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function grantRole(bytes32,address)",
  "function revokeRole(bytes32,address)",
  "function updateDelay(uint256)",
  "function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns (bytes32)",
  "function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns (bytes32)",
  "function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)",
  "function schedule(address,uint256,bytes,bytes32,bytes32,uint256)",
  "function isOperationPending(bytes32) view returns (bool)",
  "function isOperationDone(bytes32) view returns (bool)",
];

interface Call {
  target: string;
  data: string;
  label: string;
}

async function main() {
  const step = (process.env.GOV_STEP ?? "").toLowerCase();
  const execute = process.env.GOV_EXECUTE === "1";
  if (!["1", "1b", "2a", "2c", "3"].includes(step)) throw new Error("Set GOV_STEP to 1 | 1b | 2a | 2c | 3.");

  const [signer] = await ethers.getSigners();
  const book = getContracts()[network.name];
  if (!book) throw new Error(`No addresses for ${network.name}`);
  const gov = (book as any).governance ?? {};
  const safe: string | undefined = gov.safe;
  const guardians: string[] = gov.guardians ?? [];
  const timelockAddr: string = book.UpgradeTimelock.address;
  const timelock = new ethers.Contract(timelockAddr, TL_ABI, signer);

  console.log(`Network: ${network.name}   signer: ${signer.address}   ${execute ? "EXECUTE" : "dry run"}`);
  if (signer.address.toLowerCase() !== MAINTAINER.toLowerCase()) {
    throw new Error(`Signer is not the maintainer EOA (${MAINTAINER}); refusing.`);
  }

  // Cross-check the recorded Safe and guardian against the chain.
  if (!safe) throw new Error("governance.safe is not recorded for this network.");
  const safeState = await readSafe(signer, safe);
  console.log(`Safe ${safe}: threshold ${safeState.threshold}, owners ${safeState.owners.join(", ")}`);
  if (guardians.length === 0) throw new Error("governance.guardians is empty for this network.");
  for (const g of guardians) {
    if ((await ethers.provider.getCode(g)) !== "0x") throw new Error(`Guardian ${g} has code; expected an EOA.`);
  }

  const instant = async (calls: Call[]) => {
    for (const c of calls) {
      console.log(`\n${c.label}\n  target ${c.target}\n  data   ${c.data}`);
      if (!execute) continue;
      const tx = await signer.sendTransaction({ to: c.target, data: c.data });
      console.log(`  tx ${tx.hash}`);
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error("transaction reverted");
    }
  };

  const scheduled = async (calls: Call[], fileTag: string) => {
    const targets = calls.map((c) => c.target);
    const values = calls.map(() => 0);
    const datas = calls.map((c) => c.data);
    const salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(calls.map((c) => `${c.target}:${c.data}`).join("|")));
    const isBatch = calls.length > 1;
    const id: string = isBatch
      ? await timelock.hashOperationBatch(targets, values, datas, ZERO32, salt)
      : await timelock.hashOperation(targets[0], 0, datas[0], ZERO32, salt);
    const delay = (await timelock.getMinDelay()).toNumber();
    const eta = new Date((Math.floor(Date.now() / 1000) + delay) * 1000).toISOString();
    calls.forEach((c, i) => console.log(`\n[${i}] ${c.label}\n  target ${c.target}\n  data   ${c.data}`));
    console.log(`\n  operation id ${id}\n  salt         ${salt}\n  delay        ${delay} s, eta if scheduled now ~${eta}`);

    const outDir = path.join(__dirname, "..", "output");
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `governance-${fileTag}-${network.name}.json`);
    fs.writeFileSync(file, JSON.stringify(calls.map(({ target, data, label }) => ({ target, data, label })), null, 2));
    console.log(`  batch file for timelock-op.ts (TL_BATCH): ${path.relative(process.cwd(), file)}`);

    if (await timelock.isOperationDone(id)) return console.log("  already executed.");
    if (await timelock.isOperationPending(id)) return console.log("  already scheduled.");
    if (!execute) return;
    const tx = isBatch
      ? await timelock.scheduleBatch(targets, values, datas, ZERO32, salt, delay)
      : await timelock.schedule(targets[0], 0, datas[0], ZERO32, salt, delay);
    console.log(`  schedule tx ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("schedule reverted");
    console.log(`  scheduled; execute after the eta with TL_ACTION=execute TL_BATCH=${path.relative(process.cwd(), file)}`);
  };

  const ownableIface = new ethers.utils.Interface(OWNABLE);
  const tlIface = new ethers.utils.Interface(TL_ABI);

  if (step === "1") {
    const calls: Call[] = [];
    for (const name of ["TimelockERC20", "TimelockERC721", "TimelockERC1155"]) {
      const vault = new ethers.Contract(book[name].address, OWNABLE, signer);
      const owner: string = await vault.owner();
      if (owner.toLowerCase() === timelockAddr.toLowerCase()) {
        console.log(`${name}: already owned by the timelock, skipping.`);
        continue;
      }
      if (owner.toLowerCase() !== signer.address.toLowerCase()) throw new Error(`${name} owner is ${owner}, not the signer.`);
      calls.push({
        target: book[name].address,
        data: ownableIface.encodeFunctionData("transferOwnership", [timelockAddr]),
        label: `${name}.transferOwnership(UpgradeTimelock ${timelockAddr})`,
      });
    }
    await instant(calls);
    return;
  }

  if (step === "1b") {
    const router = new ethers.Contract(book.TimeLockRouter.address, OWNABLE, signer);
    const owner: string = await router.owner();
    if (owner.toLowerCase() === safe.toLowerCase()) return console.log("TimeLockRouter already owned by the Safe.");
    if (owner.toLowerCase() !== signer.address.toLowerCase()) throw new Error(`TimeLockRouter owner is ${owner}, not the signer.`);
    await instant([
      {
        target: book.TimeLockRouter.address,
        data: ownableIface.encodeFunctionData("transferOwnership", [safe]),
        label: `TimeLockRouter.transferOwnership(Safe ${safe})`,
      },
    ]);
    return;
  }

  if (step === "2a") {
    const calls: Call[] = [
      { target: timelockAddr, data: tlIface.encodeFunctionData("grantRole", [PROPOSER, safe]), label: `grantRole(PROPOSER, Safe ${safe})` },
      ...guardians.map((g) => ({
        target: timelockAddr,
        data: tlIface.encodeFunctionData("grantRole", [CANCELLER, g]),
        label: `grantRole(CANCELLER, guardian ${g})`,
      })),
      { target: timelockAddr, data: tlIface.encodeFunctionData("revokeRole", [CANCELLER, MAINTAINER]), label: `revokeRole(CANCELLER, EOA ${MAINTAINER})` },
    ];
    await scheduled(calls, "2a");
    return;
  }

  if (step === "2c") {
    if (safeState.threshold < 2) throw new Error(`Safe threshold is ${safeState.threshold}; raise it to 2 before revoking the EOA's PROPOSER.`);
    if (!(await timelock.hasRole(PROPOSER, safe))) throw new Error("Safe is not PROPOSER yet (run 2a first).");
    await scheduled(
      [{ target: timelockAddr, data: tlIface.encodeFunctionData("revokeRole", [PROPOSER, MAINTAINER]), label: `revokeRole(PROPOSER, EOA ${MAINTAINER})` }],
      "2c"
    );
    return;
  }

  // step 3
  if (!(await timelock.hasRole(PROPOSER, safe))) throw new Error("Safe is not PROPOSER yet (run 2a first).");
  await scheduled(
    [{ target: timelockAddr, data: tlIface.encodeFunctionData("updateDelay", [SEVEN_DAYS]), label: `updateDelay(${SEVEN_DAYS})` }],
    "3"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

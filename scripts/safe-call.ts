/**
 * Immediate calls from the governance Safe, the ones that are deliberately
 * not timelocked: the EOA router's create pause and attestor kill switch, the
 * TimeLockRouter's create pause. Everything else on the EOA router (clone
 * implementation, pull vault, a non-zero attestor) goes through the
 * UpgradeTimelock with timelock-op.ts.
 *
 * Prints the call for Safe{Wallet}'s Transaction Builder. With
 * SAFE_ACTION=send it executes through a threshold-1 Safe from the configured
 * signer (an owner), then reads the result back.
 *
 *   $env:SAFE_CALL="pause-eoa"; npx hardhat run scripts/safe-call.ts --network mainnet
 *   presets: pause-eoa, unpause-eoa, stop-renewals, pause-timelock, unpause-timelock
 *   any other call: $env:SAFE_TARGET="0x..."; $env:SAFE_DATA="0x..."
 *   execute: $env:SAFE_ACTION="send"
 */
import { ethers, network } from "hardhat";
import { getContracts } from "./utils";
import { execViaSafe, readSafe } from "./utils/safe";

const EOA = new ethers.utils.Interface([
  "function setCreatePaused(bool)",
  "function setActivityAttestor(address)",
  "function createPaused() view returns (bool)",
  "function activityAttestor() view returns (address)",
]);
const TL = new ethers.utils.Interface(["function setCreatePaused(bool)", "function createPaused() view returns (bool)"]);

async function main() {
  const book = getContracts()[network.name] as any;
  const safe: string = book?.governance?.safe;
  if (!safe) throw new Error(`governance.safe missing for ${network.name}`);
  const eoa: string = book.TransferEOALegacyRouter.address;
  const tl: string = book.TimeLockRouter.address;

  const presets: Record<string, { target: string; data: string; what: string }> = {
    "pause-eoa": { target: eoa, data: EOA.encodeFunctionData("setCreatePaused", [true]), what: "stop new EOA legacies (claims, check-ins, deletes and withdrawals keep working)" },
    "unpause-eoa": { target: eoa, data: EOA.encodeFunctionData("setCreatePaused", [false]), what: "allow new EOA legacies again" },
    "stop-renewals": { target: eoa, data: EOA.encodeFunctionData("setActivityAttestor", [ethers.constants.AddressZero]), what: "kill switch: no automatic renewal until the timelock installs an attestor (48 hours at least)" },
    "pause-timelock": { target: tl, data: TL.encodeFunctionData("setCreatePaused", [true]), what: "stop new timelocks (withdrawals keep working)" },
    "unpause-timelock": { target: tl, data: TL.encodeFunctionData("setCreatePaused", [false]), what: "allow new timelocks again" },
  };
  const preset = process.env.SAFE_CALL ? presets[process.env.SAFE_CALL] : undefined;
  if (process.env.SAFE_CALL && !preset) throw new Error(`Unknown SAFE_CALL; presets: ${Object.keys(presets).join(", ")}`);
  const target = preset?.target ?? process.env.SAFE_TARGET;
  const data = preset?.data ?? process.env.SAFE_DATA;
  if (!target || !data) throw new Error("Set SAFE_CALL to a preset, or SAFE_TARGET and SAFE_DATA");

  const state = await readSafe(ethers.provider, safe);
  console.log(`Network ${network.name}, Safe ${safe} (threshold ${state.threshold} of ${state.owners.length})`);
  if (preset) console.log(`Call: ${process.env.SAFE_CALL}: ${preset.what}`);
  console.log(`  to    ${target}\n  value 0\n  data  ${data}`);

  if ((process.env.SAFE_ACTION ?? "print") !== "send") {
    console.log("Printed only. Paste it into Safe{Wallet} (Transaction Builder, custom data), or rerun with SAFE_ACTION=send on a threshold-1 Safe.");
    return;
  }
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer configured; use Safe{Wallet} with the printed call");
  const tx = await execViaSafe(signer, safe, target, data);
  console.log(`Sent ${tx.hash}`);
  await tx.wait();
  const eoaRead = new ethers.Contract(eoa, EOA, ethers.provider);
  const tlRead = new ethers.Contract(tl, TL, ethers.provider);
  console.log(`Now: EOA createPaused ${await eoaRead.createPaused()}, attestor ${await eoaRead.activityAttestor()}, timelock createPaused ${await tlRead.createPaused()}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

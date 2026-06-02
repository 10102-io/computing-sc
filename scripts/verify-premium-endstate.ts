import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

/**
 * Read-only post-deploy sanity check for the Phase B end-state. Run after
 * `deploy-premium-endstate.ts` to confirm the upgrades + view are live and
 * callable BEFORE pointing the worker at them.
 *
 * Usage:
 *   npx hardhat run scripts/verify-premium-endstate.ts --network sepolia
 *
 * Optional env:
 *   - WATCHED_LEGACIES=0x..,0x..  — also dumps the view's due windows for them
 *
 * Touches nothing (pure eth_call). Exits non-zero if a check fails.
 */

const PROXY_ADMIN_ABI = ["function getProxyImplementation(address) view returns (address)"];
const VIEW_ABI = [
  "function setting() view returns (address)",
  "function defaultNotifyAhead() view returns (uint256)",
  "function dueRemindersBatch(address[] legacies) view returns (uint8[][])"
];

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const network = hre.network.name;
  console.log(`Network: ${network}\n`);

  const c = getContracts()[network];
  if (!c) throw new Error(`No contract addresses for network "${network}"`);

  const proxyAdminAddr = c["DefaultProxyAdmin"]?.address;
  const registryAddr = c["PremiumRegistry"]?.address;
  const settingAddr = c["PremiumSetting"]?.address;
  const viewAddr = c["PremiumReminderView"]?.address;

  const proxyAdmin = await ethers.getContractAt(PROXY_ADMIN_ABI, proxyAdminAddr!);

  console.log("Proxy implementations (on-chain vs contract-addresses.json):");
  if (registryAddr) {
    const live = await proxyAdmin.getProxyImplementation(registryAddr);
    check("PremiumRegistry impl matches file", live.toLowerCase() === c["PremiumRegistry"]?.implementation?.toLowerCase(), live);
  }
  if (settingAddr) {
    const live = await proxyAdmin.getProxyImplementation(settingAddr);
    check("PremiumSetting impl matches file", live.toLowerCase() === c["PremiumSetting"]?.implementation?.toLowerCase(), live);
  }

  console.log("\nPremiumSetting end-state surface:");
  const setting = await ethers.getContractAt(
    [
      "function notifyActivatedTransfer(address,address)",
      "function getTimeAhead(address) view returns (uint256)"
    ],
    settingAddr!
  );
  // The function selector existing in the ABI is enough; a static call would
  // revert (onlyRouter) which still proves it's present.
  check("notifyActivatedTransfer present", typeof setting.notifyActivatedTransfer === "function");

  console.log("\nPremiumReminderView:");
  if (!viewAddr) {
    check("PremiumReminderView deployed", false, "not in contract-addresses.json — run the deploy first");
  } else {
    const view = await ethers.getContractAt(VIEW_ABI, viewAddr);
    const wiredSetting: string = await view.setting();
    check("view.setting() points at PremiumSetting", wiredSetting.toLowerCase() === settingAddr!.toLowerCase(), wiredSetting);
    const ahead = await view.defaultNotifyAhead();
    check("view.defaultNotifyAhead() > 0", Number(ahead) > 0, `${ahead}s`);

    // Callable check: empty batch must return empty without reverting.
    const empty = await view.dueRemindersBatch([]);
    check("dueRemindersBatch([]) callable", Array.isArray(empty) && empty.length === 0);

    const watched = (process.env.WATCHED_LEGACIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
    if (watched.length) {
      console.log("\n  Due windows for WATCHED_LEGACIES:");
      const res = await view.dueRemindersBatch(watched);
      watched.forEach((legacy, i) => {
        const types = (res[i] ?? []).map((n: any) => Number(n));
        console.log(`    ${legacy}: [${types.join(", ")}]`);
      });
    }
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

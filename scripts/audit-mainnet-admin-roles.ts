/**
 * Read-only mainnet audit of admin/owner roles across all proxies we operate.
 *
 * Specifically flags:
 *   - DefaultProxyAdmin.owner()  → who can issue proxy upgrades
 *   - Per-proxy current implementation (via admin.getProxyImplementation)
 *   - Per-proxy `_initialized` version (ERC-7201 slot) — tells us whether
 *     reinitializer(N) style rotations are still open
 *   - First 12 storage slots of each proxy, scanned for any appearance of the
 *     known stale dev wallet 0x974763b760d566154B1767534cF9537CEe2f886f
 *   - For proxies that expose Ownable (owner()), reads & flags that too
 *
 * Sends zero transactions. Safe to run against mainnet.
 *
 * Usage:
 *   npx hardhat run scripts/audit-mainnet-admin-roles.ts --network mainnet
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const STALE_DEV = "0x974763b760d566154B1767534cF9537CEe2f886f".toLowerCase();
const CONTRACTED_DEPLOYER = "0x89F544A2ecb12E37978F61aA47ACa64f81677944".toLowerCase();
const FLAGGED_ADDRESSES: Record<string, string> = {
  [STALE_DEV]: "STALE DEV WALLET",
  [CONTRACTED_DEPLOYER]: "CONTRACTED DEPLOYER (0x89F544A2, handed off ProxyAdmin 2026-03-12)",
};
const INITIALIZABLE_SLOT =
  "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

const ADMIN_ABI = [
  "function getProxyImplementation(address) view returns (address)",
  "function getProxyAdmin(address) view returns (address)",
  "function owner() view returns (address)",
];

const OWNABLE_ABI = ["function owner() view returns (address)"];

type NetAddrs = Record<string, { address: string; implementation?: string }>;

async function main() {
  const netName = network.name;
  const addrsPath = path.resolve(__dirname, "..", "contract-addresses.json");
  const addrsAll = JSON.parse(fs.readFileSync(addrsPath, "utf8"));
  const addrs: NetAddrs = addrsAll[netName];
  if (!addrs) throw new Error(`No addresses for network "${netName}" in contract-addresses.json`);

  const proxyAdminAddr = addrs.DefaultProxyAdmin?.address;
  if (!proxyAdminAddr) throw new Error("DefaultProxyAdmin missing from contract-addresses.json");

  console.log(`\n=== Admin-role audit: ${netName} ===`);
  console.log(`DefaultProxyAdmin: ${proxyAdminAddr}`);

  // 1. Who owns the ProxyAdmin?
  const admin = new ethers.Contract(proxyAdminAddr, ADMIN_ABI, ethers.provider);
  const adminOwner = (await admin.owner()).toLowerCase();
  const adminOwnerFlag = adminOwner === STALE_DEV ? "  ⚠ STALE DEV WALLET" : "";
  console.log(`  owner():           ${adminOwner}${adminOwnerFlag}`);
  console.log(
    `  → This address is the ONLY one that can issue upgrade() / upgradeAndCall() on every proxy.`
  );

  // Proxies we care about, grouped by "in refactor scope" vs "sibling infra"
  const scope: Record<string, string[]> = {
    "Refactor target (must be ready before mainnet deploy)": [
      "LegacyDeployer",
      "TransferEOALegacyRouter",
    ],
    "Siblings (same _codeAdmin pattern — worth flagging)": [
      "TransferLegacyRouter",
      "MultisigLegacyRouter",
    ],
    "Other upgradeable proxies (orthogonal but part of the system)": [
      "PremiumSetting",
      "PremiumRegistry",
      "PremiumAutomationManager",
      "PremiumMailRouter",
      "PremiumMailBeforeActivation",
      "PremiumMailActivated",
      "PremiumMailReadyToActivate",
      "EIP712LegacyVerifier",
      "TimeLockRouter",
      "TimelockERC20",
      "TimelockERC721",
      "TimelockERC1155",
      "Banner",
    ],
  };

  type Finding = {
    name: string;
    proxy: string;
    implRecorded: string | null;
    implOnChain: string | null;
    driftedImpl: boolean;
    initVersion: bigint | null;
    ownable: string | null;
    ownableIsStale: boolean;
    staleSlots: Array<{ slot: number; value: string; label: string }>;
  };
  const findings: Finding[] = [];

  for (const [groupName, names] of Object.entries(scope)) {
    console.log(`\n── ${groupName} ──`);
    for (const name of names) {
      const entry = addrs[name];
      if (!entry) {
        console.log(`\n  [${name}] not in contract-addresses.json — skipping`);
        continue;
      }
      const proxy = entry.address;
      const implRecorded = entry.implementation ?? null;

      let implOnChain: string | null = null;
      try {
        implOnChain = (await admin.getProxyImplementation(proxy)).toLowerCase();
      } catch {
        // e.g. the proxy is not administered by this ProxyAdmin
      }
      const driftedImpl =
        !!implOnChain &&
        !!implRecorded &&
        implOnChain.toLowerCase() !== implRecorded.toLowerCase();

      // Initialized version (if using OZ upgradeable Initializable)
      let initVersion: bigint | null = null;
      try {
        const packed = await ethers.provider.getStorageAt(proxy, INITIALIZABLE_SLOT);
        // _initialized is the low-order 8 bytes (OZ v5 namespaced layout)
        const initializedHex = packed.slice(-16);
        initVersion = BigInt("0x" + initializedHex);
      } catch {}

      // Ownable owner() if present
      let ownable: string | null = null;
      try {
        const c = new ethers.Contract(proxy, OWNABLE_ABI, ethers.provider);
        ownable = (await c.owner()).toLowerCase();
      } catch {}
      const ownableIsStale = !!ownable && ownable === STALE_DEV;

      // Scan first 12 storage slots for appearances of ANY flagged wallet
      const staleSlots: Array<{ slot: number; value: string; label: string }> = [];
      for (let i = 0; i < 12; i++) {
        const v = await ethers.provider.getStorageAt(proxy, i);
        const asAddress = ("0x" + v.slice(-40)).toLowerCase();
        if (FLAGGED_ADDRESSES[asAddress]) {
          staleSlots.push({ slot: i, value: v, label: FLAGGED_ADDRESSES[asAddress] });
        }
      }

      findings.push({
        name,
        proxy,
        implRecorded,
        implOnChain,
        driftedImpl,
        initVersion,
        ownable,
        ownableIsStale,
        staleSlots,
      });

      console.log(`\n  [${name}]`);
      console.log(`    proxy:         ${proxy}`);
      console.log(`    impl (file):   ${implRecorded ?? "—"}`);
      console.log(`    impl (chain):  ${implOnChain ?? "(not managed by this admin)"}`);
      if (driftedImpl) {
        console.log(`    ⚠ drift: contract-addresses.json is out of sync with on-chain state`);
      }
      if (initVersion != null) {
        const reinitHint =
          initVersion < 2n
            ? "initializeV2 (reinitializer(2)) callable"
            : initVersion < 3n
              ? "initializeV2 (reinitializer(3)) callable"
              : "future reinitializer(>3) only";
        console.log(`    _initialized:  ${initVersion}  (${reinitHint})`);
      }
      if (ownable) {
        const flag = ownableIsStale ? "  ⚠ STALE DEV WALLET" : "";
        console.log(`    owner():       ${ownable}${flag}`);
      }
      if (staleSlots.length > 0) {
        for (const s of staleSlots) {
          console.log(`    ⚠ flagged address at slot ${s.slot}: ${s.label}`);
        }
        console.log(`      (likely a _codeAdmin / _creator / similar role — requires rotation)`);
      } else {
        console.log(`    storage scan:  clean (no flagged addresses in first 12 slots)`);
      }
    }
  }

  console.log(`\n\n=== Summary ===`);
  const staleAdminOwner = adminOwner === STALE_DEV;
  const staleOwnable = findings.filter((f) => f.ownableIsStale);
  const staleInSlots = findings.filter((f) => f.staleSlots.length > 0);
  const drifted = findings.filter((f) => f.driftedImpl);

  if (staleAdminOwner) {
    console.log(`  ⚠ DefaultProxyAdmin.owner() is the stale dev wallet — you cannot upgrade any proxy.`);
  } else {
    console.log(`  ✓ DefaultProxyAdmin.owner() is NOT the stale dev wallet.`);
  }

  if (staleOwnable.length === 0) {
    console.log(`  ✓ No Ownable proxy owned by the stale dev wallet.`);
  } else {
    console.log(`  ⚠ Ownable proxies owned by the stale dev wallet:`);
    for (const f of staleOwnable) console.log(`      - ${f.name} (${f.proxy})`);
  }

  if (staleInSlots.length === 0) {
    console.log(`  ✓ No flagged-wallet references found in scanned storage slots.`);
  } else {
    console.log(`  ⚠ Flagged-wallet references in storage (likely _codeAdmin/_creator):`);
    for (const f of staleInSlots) {
      for (const s of f.staleSlots) {
        console.log(`      - ${f.name} @ slot ${s.slot}: ${s.label}  (initialized=${f.initVersion})`);
      }
    }
  }

  if (drifted.length === 0) {
    console.log(`  ✓ contract-addresses.json impl entries match on-chain state.`);
  } else {
    console.log(`  ⚠ contract-addresses.json is out of sync for:`);
    for (const f of drifted)
      console.log(`      - ${f.name}: file=${f.implRecorded}  chain=${f.implOnChain}`);
  }

  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

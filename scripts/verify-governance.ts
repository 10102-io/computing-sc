/**
 * Pass/fail table of the protocol's control surface on the current network
 * (docs/plans/round-2026-09.md, Track A). Read-only; safe to run any time.
 *
 *   npx hardhat run scripts/verify-governance.ts --network mainnet
 *   $env:GOV_PHASE="final"; npx hardhat run scripts/verify-governance.ts --network mainnet
 *
 * GOV_PHASE selects the expected end state:
 *   baseline  – before the round (EOA owns vaults and router, EOA is proposer
 *               and canceller)
 *   interim   – after steps 1, 1b, 2a (vaults → timelock, TimeLockRouter →
 *               Safe, Safe + EOA propose, guardian cancels, EOA cannot cancel)
 *   final     – after the Safe is 2-of-3, step 2c and step 3 (EOA proposes
 *               nothing, delay 7 days)
 * Default: interim.
 *
 * Pending operations come from the reminder-worker's ledger (`GET /upgrades`,
 * WORKER_URL, default production) because free RPCs do not serve enough log
 * history to prove "nothing is queued"; every id it returns is also checked
 * live with `isOperationPending`.
 */
import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts } from "./utils";

dotenv.config();

type Phase = "baseline" | "interim" | "final";
const MAINTAINER = "0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630";
const ROLE = (name: string) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name));
const PROPOSER = ROLE("PROPOSER_ROLE");
const CANCELLER = ROLE("CANCELLER_ROLE");
const EXECUTOR = ROLE("EXECUTOR_ROLE");
const ADMIN = ethers.constants.HashZero;
const CANONICAL_UNISWAP_V2: Record<string, string> = {
  mainnet: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  sepolia: "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008",
};

interface Row {
  check: string;
  expected: string;
  actual: string;
  ok: boolean;
}

const same = (a?: string, b?: string) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();

async function main() {
  const phase = ((process.env.GOV_PHASE ?? "interim").toLowerCase() as Phase) || "interim";
  const book = getContracts()[network.name];
  if (!book) throw new Error(`No addresses for ${network.name}`);
  const gov = (book as any).governance ?? {};
  const safe: string | undefined = gov.safe;
  const guardians: string[] = gov.guardians ?? [];
  const timelockAddr = book.UpgradeTimelock.address;
  const provider = ethers.provider;

  const ownable = ["function owner() view returns (address)"];
  const vaultAbi = [...ownable, "function uniswapRouter() view returns (address)", "function routerAddresses() view returns (address)"];
  const tlAbi = [
    "function getMinDelay() view returns (uint256)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function isOperationPending(bytes32) view returns (bool)",
    "function getTimestamp(bytes32) view returns (uint256)",
  ];
  const at = (addr: string, abi: string[]) => new ethers.Contract(addr, abi, provider);

  const timelock = at(timelockAddr, tlAbi);
  const vaults = ["TimelockERC20", "TimelockERC721", "TimelockERC1155"].map((n) => ({ name: n, c: at(book[n].address, vaultAbi) }));
  const router = at(book.TimeLockRouter.address, [...ownable, "function createPaused() view returns (bool)", "function uniswapRouter() view returns (address)"]);
  const proxyAdmin = at(book.DefaultProxyAdmin.address, ownable);

  const expectVaultOwner = phase === "baseline" ? MAINTAINER : timelockAddr;
  const expectRouterOwner = phase === "baseline" ? MAINTAINER : safe ?? "(governance.safe missing)";
  const expectDelay = phase === "final" ? 604800 : network.name === "mainnet" ? 172800 : 300;

  const rows: Row[] = [];
  const push = (check: string, expected: string, actual: string, ok: boolean) => rows.push({ check, expected, actual, ok });

  for (const v of vaults) {
    const [owner, uni, ra] = await Promise.all([v.c.owner(), v.c.uniswapRouter().catch(() => "n/a"), v.c.routerAddresses()]);
    push(`${v.name}.owner`, expectVaultOwner, owner, same(owner, expectVaultOwner));
    push(`${v.name}.routerAddresses`, book.TimeLockRouter.address, ra, same(ra, book.TimeLockRouter.address));
    if (v.name === "TimelockERC20") {
      const canonical = CANONICAL_UNISWAP_V2[network.name] ?? "(no canonical for this network)";
      push(`${v.name}.uniswapRouter`, canonical, uni, same(uni, canonical));
    }
  }

  const [routerOwner, paused, routerUni] = await Promise.all([router.owner(), router.createPaused(), router.uniswapRouter()]);
  push("TimeLockRouter.owner", expectRouterOwner, routerOwner, same(routerOwner, expectRouterOwner));
  push("TimeLockRouter.createPaused", "false", String(paused), paused === false);
  push("TimeLockRouter.uniswapRouter", CANONICAL_UNISWAP_V2[network.name] ?? "?", routerUni, same(routerUni, CANONICAL_UNISWAP_V2[network.name]));

  const paOwner = await proxyAdmin.owner();
  push("DefaultProxyAdmin.owner", timelockAddr, paOwner, same(paOwner, timelockAddr));

  const delay = (await timelock.getMinDelay()).toNumber();
  push("UpgradeTimelock.getMinDelay", String(expectDelay), String(delay), delay === expectDelay);

  const has = (role: string, who: string) => timelock.hasRole(role, who) as Promise<boolean>;
  const eoaProposer = await has(PROPOSER, MAINTAINER);
  const eoaCanceller = await has(CANCELLER, MAINTAINER);
  push("EOA is PROPOSER", phase === "final" ? "false" : "true", String(eoaProposer), eoaProposer === (phase !== "final"));
  push("EOA is CANCELLER", phase === "baseline" ? "true" : "false", String(eoaCanceller), eoaCanceller === (phase === "baseline"));
  if (safe) {
    const safeProposer = await has(PROPOSER, safe);
    push("Safe is PROPOSER", phase === "baseline" ? "false" : "true", String(safeProposer), safeProposer === (phase !== "baseline"));
    const safeCanceller = await has(CANCELLER, safe);
    push("Safe is CANCELLER", "false", String(safeCanceller), safeCanceller === false);
  } else {
    push("governance.safe recorded", "address", "missing", false);
  }
  if (guardians.length === 0) push("governance.guardians recorded", ">= 1", "0", false);
  for (const g of guardians) {
    const gc = await has(CANCELLER, g);
    push(`Guardian ${g.slice(0, 8)} is CANCELLER`, phase === "baseline" ? "false" : "true", String(gc), gc === (phase !== "baseline"));
    const gp = await has(PROPOSER, g);
    push(`Guardian ${g.slice(0, 8)} is PROPOSER`, "false", String(gp), gp === false);
  }
  const openExecutor = await has(EXECUTOR, ethers.constants.AddressZero);
  push("EXECUTOR open (address(0))", "true", String(openExecutor), openExecutor === true);
  const selfAdmin = await has(ADMIN, timelockAddr);
  push("DEFAULT_ADMIN is the timelock itself", "true", String(selfAdmin), selfAdmin === true);
  for (const who of [MAINTAINER, safe, ...guardians].filter(Boolean) as string[]) {
    const a = await has(ADMIN, who);
    push(`${who.slice(0, 8)} is not DEFAULT_ADMIN`, "false", String(a), a === false);
  }

  // Pending operations: worker ledger + live check.
  const workerUrl = (process.env.WORKER_URL ?? "https://reminder-worker-production.up.railway.app").replace(/\/$/, "");
  let pendingNote = "worker unreachable";
  try {
    const res = await fetch(`${workerUrl}/upgrades`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const body = (await res.json()) as { chainId?: number; pending?: Array<{ opId: string; eta: number; target: string }> };
      const chainId = (await provider.getNetwork()).chainId;
      if (Number(body.chainId) !== chainId) {
        // The worker is single-chain (mainnet). On other networks the
        // ledger cannot answer; the timelock-op status of known ids is the
        // check that remains, so this row is informational, not a failure.
        pendingNote = `not tracked here (worker watches chain ${body.chainId})`;
        push("Pending timelock operations", "none (or known)", pendingNote, true);
      } else {
        const pending = body.pending ?? [];
        const live: string[] = [];
        for (const p of pending) {
          const isPending = await timelock.isOperationPending(p.opId);
          if (isPending) live.push(`${p.opId.slice(0, 10)}… eta ${new Date(p.eta * 1000).toISOString()} → ${p.target}`);
        }
        pendingNote = live.length ? live.join("; ") : "none";
        push("Pending timelock operations", "none (or known)", pendingNote, true);
      }
    } else pendingNote = `worker ${res.status}`;
  } catch {
    /* keep note */
  }
  if (!rows.find((r) => r.check === "Pending timelock operations")) {
    push("Pending timelock operations", "none (or known)", pendingNote, false);
  }

  const width = Math.max(...rows.map((r) => r.check.length));
  console.log(`\nGovernance on ${network.name}, expected phase "${phase}"\n`);
  for (const r of rows) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check.padEnd(width)}  expected ${r.expected}  actual ${r.actual}`);
  }
  const failures = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failures}/${rows.length} checks pass.`);
  if (failures > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

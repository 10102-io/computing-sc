/**
 * Wave A smoke test on Sepolia: runbook step A7 of docs/plans/train-2026-11.md.
 * Run AFTER A6 (the batch executed) and BEFORE A8:
 *
 *   npx hardhat run scripts/smoke-train-2026-11.ts --network sepolia
 *
 * Every transaction carries an explicit gas price (eth_gasPrice x2, or
 * SMOKE_GAS_PRICE_WEI), never hardhat's fixed Sepolia default. Signer: the
 * deployer, also the threshold-1 governance Safe's signer. Fresh wallets
 * (owner, beneficiary, buyer) get SMOKE_FUND_ETH each (default 0.00005) and
 * send what is left back at the end. No private key is ever printed.
 *
 * Legs (PASS / FAIL / SKIP with transaction hashes; a failure does not stop
 * the run; exit 1 if any FAIL):
 *   1. M-2: a no-return token (MockNoReturnERC20, deployed here) directly
 *      approved to the predicted clone; a 60-second legacy; the beneficiary
 *      claims through the router and receives the amount less the fee.
 *   2. M-1: vault2 still binds the activated legacy; the owner unbinds it.
 *   3. From the Safe: setCreatePaused(true), a create reverts, unpause (always,
 *      in a finally); setActivityAttestor(0), recordActivity refused; then the
 *      timelock-op command that reinstalls the recorded attestor is printed.
 *   4. createTimelockUntil with unlockAt = now + 90 s: withdraw reverts before,
 *      succeeds after.
 *   5. A coupon purchase (10% off, cap 1, 1 h expiry) of the cheapest plan in
 *      ETH, if the deployer holds OPERATOR and the price feed answers.
 *   6. recordSelfConsent(activeTermsHash, ShieldVault, 1) from the deployer.
 *   Static checks: an empty timelock create with ETH reverts EmptyTimelock; a
 *   zero-minimum non-WETH swap reverts ZeroAmountOutMin on both routers.
 *
 * Addresses: contract-addresses.json for the network; the new clone and vault
 * from `train202611` (written by train-2026-11.ts), falling back to the
 * post-A8 keys TransferEOALegacyImpl / LegacyPullVault. The router must
 * already use both (the batch executed), or the run stops before sending.
 */
import { BigNumber, Contract, Signer, Wallet } from "ethers";
import { ethers, network } from "hardhat";
import { getContracts } from "./utils";
import { readSafe, preValidatedSignature } from "./utils/safe";
import { readEoaRouterAdmin } from "./utils/live-code";

type Status = "PASS" | "FAIL" | "SKIP";

export interface SmokeAddresses {
  router: string;
  clone: string;
  vault2: string;
  timeLockRouter: string;
  premiumRegistry: string;
  verifier: string;
  safe: string;
  attestor: string;
  timelock: string;
  shieldVault: string;
}

export interface SmokeContext {
  deployer: Signer;
  addresses: SmokeAddresses;
  /** Transaction overrides applied to every send (the gas price). */
  overrides: Record<string, unknown>;
  /** ETH given to each fresh wallet. */
  fund: BigNumber;
  /** Resolves once the chain's latest timestamp is at least `ts`. */
  waitUntil: (ts: number) => Promise<void>;
  /** Sends `to.call(data)` from the governance Safe; resolves to the receipt. */
  safeExec: (to: string, data: string) => Promise<any>;
  /** Set when the deployer cannot drive the Safe alone: leg 3 is skipped. */
  safeSkipReason?: string;
  networkName: string;
}

const ZERO = ethers.constants.AddressZero;
const SELECTORS = [
  "EmptyTimelock()",
  "ZeroAmountOutMin()",
  "CreationPaused()",
  "NotActivityAttestor()",
  "StillLocked()",
  "UnswapNeedsSoleRecipient()",
].map((s) => ({ name: s, selector: ethers.utils.id(s).slice(0, 10) }));

/** The custom error a failed call carried, by selector, searched anywhere in the error. */
function revertName(err: any): string {
  const blob = (JSON.stringify(err ?? "") + " " + (err?.message ?? "")).toLowerCase();
  for (const { name, selector } of SELECTORS) if (blob.includes(selector)) return name;
  const m = blob.match(/reverted with custom error '([a-z0-9_]+)\(/i);
  return m ? `${m[1]}(...)` : `unknown (${String(err?.message ?? err).slice(0, 120)})`;
}

export async function runSmoke(ctx: SmokeContext): Promise<boolean> {
  const { deployer, addresses: a, overrides } = ctx;
  const provider = deployer.provider!;
  const me = await deployer.getAddress();
  const results: Array<{ leg: string; status: Status; detail: string }> = [];
  const txs: Record<string, string[]> = {};
  let current = "setup";
  const report = (leg: string, status: Status, detail: string) => {
    results.push({ leg, status, detail });
    const hashes = txs[leg]?.length ? `\n      tx ${txs[leg].join("\n      tx ")}` : "";
    console.log(`${status.padEnd(4)}  ${leg}: ${detail}${hashes}`);
  };

  /** Estimate, add 30%, send with the run's gas price, wait, remember the hash. */
  const send = async (c: Contract, method: string, args: unknown[], extra: Record<string, unknown> = {}) => {
    const ov = { ...overrides, ...extra };
    const estimate: BigNumber = await c.estimateGas[method](...args, ov);
    const tx = await c[method](...args, { ...ov, gasLimit: estimate.mul(13).div(10) });
    (txs[current] ??= []).push(tx.hash);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`${method} reverted (${tx.hash})`);
    return rc;
  };
  const expectRevert = async (call: () => Promise<unknown>, error: string): Promise<string> => {
    try {
      await call();
    } catch (e: any) {
      const got = revertName(e);
      return got === error ? "" : `expected ${error}, got ${got}`;
    }
    return `expected ${error}, the call succeeded`;
  };
  const now = async () => (await provider.getBlock("latest")).timestamp;
  const logsOf = (rc: any, c: Contract, name: string) =>
    rc.logs
      .filter((l: any) => l.address.toLowerCase() === c.address.toLowerCase())
      .map((l: any) => {
        try {
          return c.interface.parseLog(l);
        } catch {
          return undefined;
        }
      })
      .filter((p: any) => p && p.name === name);

  const balanceBefore = await provider.getBalance(me);
  console.log(`Network ${ctx.networkName}, deployer ${me}, balance ${ethers.utils.formatEther(balanceBefore)} ETH`);
  console.log(`Gas price ${JSON.stringify(overrides)}; ${ethers.utils.formatEther(ctx.fund)} ETH per fresh wallet`);

  const router = await ethers.getContractAt("TransferEOALegacyRouter", a.router, deployer);
  const vault2 = await ethers.getContractAt("LegacyPullVaultV2", a.vault2, deployer);
  const liveImpl: string = await router.legacyImplementation();
  const liveVault: string = await router.pullVault();
  if (liveImpl.toLowerCase() !== a.clone.toLowerCase() || liveVault.toLowerCase() !== a.vault2.toLowerCase()) {
    console.log(`The router uses clone ${liveImpl} and vault ${liveVault}, not the train's ${a.clone} / ${a.vault2}.`);
    console.log("Has the wave A batch executed (A6)? Nothing sent.");
    return false;
  }

  // About 2.7M gas in all (measured locally), plus the fresh wallets' float.
  const runPrice = BigNumber.from((overrides.gasPrice as any) ?? (await provider.getGasPrice()));
  const budget = runPrice.mul(4_000_000).add(ctx.fund.mul(3));
  if (balanceBefore.lt(budget)) {
    console.log(`The run needs about ${ethers.utils.formatEther(budget)} ETH at this gas price; the deployer has less. Nothing sent.`);
    return false;
  }

  // Fresh wallets, funded from the deployer and swept back at the end.
  const owner = Wallet.createRandom().connect(provider);
  const bene = Wallet.createRandom().connect(provider);
  const buyer = Wallet.createRandom().connect(provider);
  const wallets = [owner, bene, buyer];
  console.log(`Fresh wallets: owner ${owner.address}, beneficiary ${bene.address}, buyer ${buyer.address}`);
  for (const w of wallets) {
    const tx = await deployer.sendTransaction({ to: w.address, value: ctx.fund, gasLimit: 21000, ...overrides });
    (txs.setup ??= []).push(tx.hash);
    await tx.wait();
  }
  const token = await (await ethers.getContractFactory("MockNoReturnERC20", deployer)).deploy("Smoke Tether", "sUSDT", 6, overrides);
  (txs.setup ??= []).push(token.deployTransaction.hash);
  await token.deployed();
  console.log(`No-return token ${token.address}`);
  await send(token, "mint", [owner.address, 1_000_000_000]);

  let legacyId: BigNumber | undefined;
  let legacyAddress = "";

  // ── Leg 1, M-2 ──────────────────────────────────────────────────────────
  current = "1 M-2 no-return token, direct approval, claim";
  try {
    const amount = 100_000_000; // 100 sUSDT
    const predicted: string = await router.getNextLegacyAddress(owner.address);
    await send(token.connect(owner), "approve", [predicted, amount]);
    const payment = await ethers.getContractAt("Payment", await router.paymentContract(), deployer);
    const fee: BigNumber = await payment.getFee();
    const verifier = await ethers.getContractAt("EIP712LegacyVerifier", a.verifier, deployer);
    const ts = await now();
    const sig = await owner.signMessage(await verifier.generateVersionedMessage(ts));
    const zero = { user: ZERO, percent: 0 };
    const bundle = { permitBatch: { details: [], spender: ZERO, sigDeadline: 0 }, signature: "0x" };
    const rc = await send(router.connect(owner), "createLegacyV2WithMaxFee", [
      [{ user: bene.address, percent: 1_000_000 }],
      { lackOfOutgoingTxRange: 60, delayLayer2: 0, delayLayer3: 0 },
      zero,
      zero,
      bundle,
      ts,
      sig,
      fee,
    ]);
    const created = logsOf(rc, router, "TransferEOALegacyCreatedV2")[0];
    legacyId = created.args.legacyId;
    legacyAddress = created.args.legacyAddress;
    if (legacyAddress.toLowerCase() !== predicted.toLowerCase()) throw new Error(`legacy ${legacyAddress} is not the predicted ${predicted}`);
    const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddress, deployer);
    const createdAt = (await provider.getBlock(rc.blockNumber)).timestamp;
    console.log(`      legacy ${legacyId!.toString()} at ${legacyAddress}, fee ${fee.toString()} bps, waiting for the 60 s trigger`);
    await ctx.waitUntil(createdAt + 62);
    await send(router.connect(bene), "activeLegacy", [legacyId, [token.address], false]);
    const got: BigNumber = await token.balanceOf(bene.address);
    const expected = BigNumber.from(amount).sub(BigNumber.from(amount).mul(await legacy.adminFeePercent()).div(10_000));
    report(current, got.eq(expected) ? "PASS" : "FAIL", `beneficiary received ${got.toString()} of ${amount} (expected ${expected.toString()})`);
  } catch (e: any) {
    report(current, "FAIL", e?.reason ?? e?.message ?? String(e));
  }

  // ── Leg 2, M-1 ──────────────────────────────────────────────────────────
  current = "2 M-1 unbind after activation";
  try {
    if (!legacyAddress) throw new Error("leg 1 created no legacy");
    const bound: string = await vault2.boundLegacy(owner.address);
    if (bound === ZERO) {
      report(current, "PASS", "the binding was already cleared on activation");
    } else if (bound.toLowerCase() !== legacyAddress.toLowerCase()) {
      report(current, "FAIL", `vault2 binds ${bound}, not the activated legacy ${legacyAddress}`);
    } else {
      const rc = await send(vault2.connect(owner), "unbind", []);
      const ev = logsOf(rc, vault2, "LegacyUnbound")[0];
      const after: string = await vault2.boundLegacy(owner.address);
      const ok = after === ZERO && ev && ev.args.legacy.toLowerCase() === legacyAddress.toLowerCase();
      report(current, ok ? "PASS" : "FAIL", `bound to the activated legacy, unbind() cleared it (${after}), LegacyUnbound ${ev ? "emitted" : "missing"}`);
    }
  } catch (e: any) {
    report(current, "FAIL", e?.reason ?? e?.message ?? String(e));
  }

  // ── Leg 3, the Safe's fast levers ───────────────────────────────────────
  current = "3 Safe pause and attestor kill switch";
  const viaSafe = async (data: string) => {
    const rc = await ctx.safeExec(a.router, data);
    (txs[current] ??= []).push(rc.transactionHash);
  };
  try {
    const admin = await readEoaRouterAdmin(a.router);
    if (ctx.safeSkipReason) {
      report(current, "SKIP", ctx.safeSkipReason);
    } else if (admin.codeAdmin.toLowerCase() !== a.safe.toLowerCase()) {
      report(current, "FAIL", `the router's code admin is ${admin.codeAdmin}, not the Safe ${a.safe}`);
    } else {
      const problems: string[] = [];
      await viaSafe(router.interface.encodeFunctionData("setCreatePaused", [true]));
      try {
        const ts = await now();
        const zero = { user: ZERO, percent: 0 };
        const bundle = { permitBatch: { details: [], spender: ZERO, sigDeadline: 0 }, signature: "0x" };
        const why = await expectRevert(
          () =>
            router
              .connect(buyer)
              .callStatic.createLegacyV2([{ user: bene.address, percent: 1_000_000 }], { lackOfOutgoingTxRange: 60, delayLayer2: 0, delayLayer3: 0 }, zero, zero, bundle, ts, "0x"),
          "CreationPaused()"
        );
        if (why) problems.push(`paused create: ${why}`);
      } finally {
        await viaSafe(router.interface.encodeFunctionData("setCreatePaused", [false]));
      }
      if (await router.createPaused()) problems.push("still paused after unpausing");
      await viaSafe(router.interface.encodeFunctionData("setActivityAttestor", [ZERO]));
      if ((await router.activityAttestor()) !== ZERO) problems.push("attestor not zeroed");
      const why = await expectRevert(
        () => router.connect(provider).callStatic.recordActivity(legacyId ?? 1, 1, { from: a.attestor }),
        "NotActivityAttestor()"
      );
      if (why) problems.push(`recordActivity: ${why}`);
      report(current, problems.length ? "FAIL" : "PASS", problems.length ? problems.join("; ") : "paused and unpaused from the Safe; attestor zeroed, recordActivity refused");
      const data = router.interface.encodeFunctionData("setActivityAttestor", [a.attestor]);
      console.log("      To reinstall the recorded attestor (timelocked; not part of this check):");
      console.log(
        `      Remove-Item Env:TL_BATCH -ErrorAction SilentlyContinue; $env:TL_TARGET="${a.router}"; $env:TL_DATA="${data}"; $env:TL_ACTION="print"; npx hardhat run scripts/timelock-op.ts --network ${ctx.networkName}`
      );
      console.log(`      then the same with $env:TL_ACTION="schedule"; $env:TL_VIA_SAFE="1", and after the delay $env:TL_ACTION="execute".`);
    }
  } catch (e: any) {
    report(current, "FAIL", e?.reason ?? e?.message ?? String(e));
  }

  // ── Leg 4, createTimelockUntil ──────────────────────────────────────────
  current = "4 createTimelockUntil";
  const tlr = await ethers.getContractAt("TimeLockRouter", a.timeLockRouter, deployer);
  try {
    const amount = 10_000_000;
    await send(token.connect(owner), "approve", [a.timeLockRouter, amount]);
    const unlockAt = (await now()) + 90;
    const lock = {
      timelockETHSwap: { storageToken: ZERO, amountOutMin: 0, deadline: 0 },
      timelockERC20: [{ tokenAddress: token.address, amount }],
      timelockERC721: [],
      timelockERC1155: [],
      duration: 0,
      name: "smoke",
    };
    await send(tlr.connect(owner), "createTimelockUntil", [lock, unlockAt]);
    const id: BigNumber = await tlr.timelockCounter();
    const vault = await ethers.getContractAt("TimelockERC20", await tlr.timelockERC20Contract(), deployer);
    const info = await vault.timelocks(id);
    const problems: string[] = [];
    if (!info.unlockTime.eq(unlockAt)) problems.push(`unlockTime ${info.unlockTime.toString()} is not ${unlockAt}`);
    const early = await expectRevert(() => tlr.connect(owner).callStatic["withdraw(uint256)"](id), "StillLocked()");
    if (early) problems.push(`early withdraw: ${early}`);
    console.log(`      timelock ${id.toString()}, unlocks at ${unlockAt}; waiting`);
    await ctx.waitUntil(unlockAt + 2);
    const before: BigNumber = await token.balanceOf(owner.address);
    await send(tlr.connect(owner), "withdraw(uint256)", [id]);
    const back = (await token.balanceOf(owner.address)).sub(before);
    if (!back.eq(amount)) problems.push(`withdrew ${back.toString()} of ${amount}`);
    report(current, problems.length ? "FAIL" : "PASS", problems.length ? problems.join("; ") : `opened at unlockAt exactly; refused before, ${amount} returned after`);
  } catch (e: any) {
    report(current, "FAIL", e?.reason ?? e?.message ?? String(e));
  }

  // ── Leg 5, coupon purchase ──────────────────────────────────────────────
  current = "5 coupon purchase";
  try {
    const registry = await ethers.getContractAt("PremiumRegistry", a.premiumRegistry, deployer);
    const operator = await registry.OPERATOR();
    if (!(await registry.hasRole(operator, me))) {
      report(current, "SKIP", `the deployer does not hold OPERATOR on PremiumRegistry ${a.premiumRegistry}`);
    } else {
      let plan = -1;
      let cheapest = ethers.constants.MaxUint256;
      const count = (await registry.getNextPlanId()).toNumber();
      for (let i = 0; i < count; i++) {
        const p = await registry.premiumPlans(i);
        if (p.isActive && p.usdPrice.lt(cheapest)) {
          cheapest = p.usdPrice;
          plan = i;
        }
      }
      let price: BigNumber | undefined;
      let priceError = "";
      try {
        if (plan >= 0) price = await registry.getPlanPriceETH(plan);
      } catch (e: any) {
        priceError = e?.reason ?? e?.message ?? String(e);
      }
      if (plan < 0) report(current, "SKIP", "no active plan");
      else if (!price) report(current, "SKIP", `getPlanPriceETH(${plan}) fails: ${priceError}`);
      else if (price.gt(ctx.fund.div(2))) report(current, "SKIP", `plan ${plan} costs ${ethers.utils.formatEther(price)} ETH, above this run's budget`);
      else {
        const code = `SMOKE-${Date.now()}`;
        await send(registry, "setCoupon", [code, 1000, (await now()) + 3600, 1, ZERO, true]);
        const rc = await send(registry.connect(buyer), "subscribeWithETH", [plan, code, ZERO], { value: price });
        const ev = logsOf(rc, registry, "PlanSubscribedWithCode")[0];
        const atBlock: BigNumber = await registry.getPlanPriceETH(plan, { blockTag: rc.blockNumber });
        const expected = atBlock.sub(atBlock.mul(1000).div(10_000));
        const ok = ev && ev.args.code === code && ev.args.value.eq(expected);
        report(
          current,
          ok ? "PASS" : "FAIL",
          ev
            ? `plan ${plan}: paid ${ev.args.value.toString()} wei with ${code}, expected ${expected.toString()} (10% off ${atBlock.toString()})`
            : "PlanSubscribedWithCode missing"
        );
      }
    }
  } catch (e: any) {
    report(current, "FAIL", e?.reason ?? e?.message ?? String(e));
  }

  // ── Leg 6, self-recorded consent ────────────────────────────────────────
  current = "6 recordSelfConsent";
  try {
    const verifier = await ethers.getContractAt("EIP712LegacyVerifier", a.verifier, deployer);
    const termsHash: string = await verifier.activeTermsHash();
    if (termsHash === ethers.constants.HashZero) {
      report(current, "SKIP", "no active terms on the verifier");
    } else {
      const rc = await send(verifier, "recordSelfConsent", [termsHash, a.shieldVault, 1]);
      const ev = logsOf(rc, verifier, "SelfConsentRecorded")[0];
      const n = (await verifier.getUserSelfConsentCount(me)).toNumber();
      const rec = await verifier.getUserSelfConsent(me, n - 1);
      const ok =
        ev &&
        rec.termsHash === termsHash &&
        rec.refContract.toLowerCase() === a.shieldVault.toLowerCase() &&
        rec.refId.eq(1) &&
        ev.args.refContract.toLowerCase() === a.shieldVault.toLowerCase();
      report(current, ok ? "PASS" : "FAIL", `SelfConsentRecorded ${ev ? "emitted" : "missing"}; record ${n - 1}: terms ${rec.termsVersion}, ref ${rec.refContract} #${rec.refId.toString()}`);
    }
  } catch (e: any) {
    report(current, "FAIL", e?.reason ?? e?.message ?? String(e));
  }

  // ── Static checks ───────────────────────────────────────────────────────
  current = "static: empty timelock with ETH";
  try {
    const empty = {
      timelockETHSwap: { storageToken: ZERO, amountOutMin: 0, deadline: 0 },
      timelockERC20: [],
      timelockERC721: [],
      timelockERC1155: [],
      duration: 86400,
      name: "smoke",
    };
    const why = await expectRevert(() => tlr.callStatic.createTimelock(empty, { value: 1 }), "EmptyTimelock()");
    report(current, why ? "FAIL" : "PASS", why || "EmptyTimelock()");
  } catch (e: any) {
    report(current, "FAIL", e?.message ?? String(e));
  }

  current = "static: zero-minimum non-WETH swap";
  try {
    const problems: string[] = [];
    const deadline = (await now()) + 600;
    // TimeLockRouter: the storage token must be whitelisted to reach the check.
    const listAddr: string = await tlr.tokenWhitelist();
    const uni = new Contract(await tlr.uniswapRouter(), ["function WETH() view returns (address)"], deployer);
    let swapToken = "";
    if (listAddr !== ZERO) {
      const list = await ethers.getContractAt("TokenWhiteList", listAddr, deployer);
      const weth = ((await uni.WETH()) as string).toLowerCase();
      swapToken = ((await list.getWhitelist()) as string[]).find((t) => t !== ZERO && t.toLowerCase() !== weth) ?? "";
    }
    if (swapToken) {
      const lock = {
        timelockETHSwap: { storageToken: swapToken, amountOutMin: 0, deadline },
        timelockERC20: [],
        timelockERC721: [],
        timelockERC1155: [],
        duration: 86400,
        name: "smoke",
      };
      const why = await expectRevert(() => tlr.callStatic.createTimelock(lock, { value: 1 }), "ZeroAmountOutMin()");
      if (why) problems.push(`TimeLockRouter: ${why}`);
    } else {
      console.log("      TimeLockRouter leg skipped: no whitelisted non-WETH token");
    }
    if (legacyId) {
      const why = await expectRevert(
        () => router.connect(owner).callStatic.autoSwap(legacyId, { storageToken: token.address, amountOutMin: 0, deadline }, { value: 1 }),
        "ZeroAmountOutMin()"
      );
      if (why) problems.push(`EOA router autoSwap: ${why}`);
    }
    report(current, problems.length ? "FAIL" : swapToken || legacyId ? "PASS" : "SKIP", problems.length ? problems.join("; ") : `ZeroAmountOutMin()${swapToken ? ` (TimeLockRouter with ${swapToken})` : ""}${legacyId ? " (EOA router autoSwap)" : ""}`);
  } catch (e: any) {
    report(current, "FAIL", e?.message ?? String(e));
  }

  // ── Sweep the fresh wallets back ────────────────────────────────────────
  for (const w of wallets) {
    const bal = await provider.getBalance(w.address);
    const cost = runPrice.mul(21000);
    if (bal.gt(cost)) {
      try {
        await (await w.sendTransaction({ to: me, value: bal.sub(cost), gasLimit: 21000, gasPrice: runPrice })).wait();
      } catch (e: any) {
        console.log(`      sweep from ${w.address} failed: ${e?.message ?? e}`);
      }
    }
  }
  const balanceAfter = await provider.getBalance(me);
  const left = (await Promise.all(wallets.map((w) => provider.getBalance(w.address)))).reduce((s, b) => s.add(b), BigNumber.from(0));
  console.log(
    `\nSpent ${ethers.utils.formatEther(balanceBefore.sub(balanceAfter))} ETH from the deployer (balance ${ethers.utils.formatEther(balanceAfter)}); ${ethers.utils.formatEther(left)} ETH left in the fresh wallets.`
  );
  const fails = results.filter((r) => r.status === "FAIL").length;
  console.log(`${results.filter((r) => r.status === "PASS").length} PASS, ${fails} FAIL, ${results.filter((r) => r.status === "SKIP").length} SKIP`);
  return fails === 0;
}

async function main() {
  if (network.name === "mainnet") throw new Error("This smoke test sends transactions: Sepolia (or a local chain) only.");
  const net: any = (getContracts() as any)[network.name];
  if (!net) throw new Error(`No addresses for ${network.name} in contract-addresses.json`);
  const pick = (...vals: Array<string | undefined>) => {
    const v = vals.find(Boolean);
    if (!v) throw new Error("missing address");
    return ethers.utils.getAddress(v);
  };
  const addresses: SmokeAddresses = {
    router: pick(net.TransferEOALegacyRouter?.address),
    clone: pick(net.train202611?.TransferEOALegacyImpl, net.TransferEOALegacyImpl?.address),
    vault2: pick(net.train202611?.LegacyPullVaultV2, net.LegacyPullVault?.address),
    timeLockRouter: pick(net.TimeLockRouter?.address),
    premiumRegistry: pick(net.PremiumRegistry?.address),
    verifier: pick(net.EIP712LegacyVerifier?.address),
    safe: pick(net.governance?.safe),
    attestor: pick(net.governance?.activityAttestor),
    timelock: pick(net.UpgradeTimelock?.address),
    shieldVault: pick(net.ShieldVault?.address, net.UpgradeTimelock?.address),
  };
  const [first] = await ethers.getSigners();
  if (!first) throw new Error(`No signer for ${network.name}: DEPLOYER_PRIVATE_KEY is not configured.`);
  const deployer = first as unknown as Signer; // ethers v5 at runtime

  const rpcPrice = BigNumber.from(await ethers.provider.send("eth_gasPrice", []));
  const base = (await ethers.provider.getBlock("latest")).baseFeePerGas ?? BigNumber.from(0);
  const gasPrice = process.env.SMOKE_GAS_PRICE_WEI
    ? BigNumber.from(process.env.SMOKE_GAS_PRICE_WEI)
    : (rpcPrice.gt(base) ? rpcPrice : base).mul(2).add(1);
  const fund = ethers.utils.parseEther(process.env.SMOKE_FUND_ETH ?? "0.00005");

  const safeState = await readSafe(deployer, addresses.safe);
  const me = (await deployer.getAddress()).toLowerCase();
  const safeSkipReason = !safeState.owners.includes(me)
    ? `the deployer is not an owner of Safe ${addresses.safe}`
    : safeState.threshold !== 1
      ? `Safe ${addresses.safe} has threshold ${safeState.threshold}: run these levers through Safe{Wallet}`
      : undefined;
  const safeExec = async (to: string, data: string) => {
    // execViaSafe's call with an explicit gas price, not hardhat's Sepolia default.
    const safe = new Contract(
      addresses.safe,
      ["function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)"],
      deployer
    );
    const args = [to, 0, data, 0, 0, 0, 0, ZERO, ZERO, preValidatedSignature(me)];
    const estimate: BigNumber = await safe.estimateGas.execTransaction(...args, { gasPrice });
    const tx = await safe.execTransaction(...args, { gasPrice, gasLimit: estimate.mul(13).div(10) });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`Safe execTransaction reverted (${tx.hash})`);
    return rc;
  };
  const waitUntil = async (ts: number) => {
    for (;;) {
      const latest = (await ethers.provider.getBlock("latest")).timestamp;
      if (latest >= ts) return;
      await new Promise((r) => setTimeout(r, Math.min(15_000, (ts - latest) * 1000 + 3000)));
    }
  };

  const ok = await runSmoke({ deployer, addresses, overrides: { gasPrice }, fund, waitUntil, safeExec, safeSkipReason, networkName: network.name });
  if (!ok) process.exitCode = 1;
}

if (!process.env.SMOKE_LIBRARY) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

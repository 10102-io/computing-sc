import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { deployProxy } from "./utils/proxy";
import { currentTime, increase } from "./utils/time";
import { DAY, expectRevert } from "./fixtures/eoaTrain";
import { genMessage } from "../scripts/utils/genMsg";
import { wireRouters } from "./fixtures/wiring";
import safeBytecode from "./fixtures/safe-bytecode.json";

// The Safe guard under the Safe users have: the bytecode of the canonical
// Safe 1.3.0, 1.4.1 and 1.5.0 as it stands on mainnet (scripts/safe-bytecode.mjs
// fetches it and checks the file against mainnet; the four hashes below
// pin what the cases stand on). A legacy is set up the way the app does it:
// one batch through MultiSendCallOnly that sets the guard, enables the
// module and has the Safe call the guard, so the guard counts the one
// transaction it cannot see.
//
// Version 1 of the guard also took a direct call carrying signatures over
// the Safe's previous transaction, and never checked the signers against
// the Safe's owners (found 2026-11-19). "a call that is not the Safe's"
// sends that call to version 2, and first to the version 1 code from
// mainnet, so the cases are shown to be the call that worked.

const ZERO = ethers.constants.AddressZero;
const SENTINEL = "0x0000000000000000000000000000000000000001";
const WAIT = 30 * DAY;
const DEV = "0x974763b760d566154B1767534cF9537CEe2f886f";
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
// Safe 1.5.0: keccak256("module_manager.module_guard.address").
const MODULE_GUARD_SLOT = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947";
const EXECUTION_FAILURE = ethers.utils.id("ExecutionFailure(bytes32,uint256)");
const PINNED: Record<string, string> = {
  "1.3.0": "0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e",
  "1.4.1": "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4",
  "1.5.0": "0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2",
  "guard-v1": "0x497f6a70489f8ad05257c7cecd2a6783e839b5dd918baed0ec97dfe26b9fa293",
};

const SAFE_ABI = [
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation) returns (bool)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isModuleEnabled(address module) view returns (bool)",
  "function enableModule(address module)",
  "function disableModule(address prevModule, address module)",
  "function setGuard(address guard)",
  "function setModuleGuard(address moduleGuard)",
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function changeThreshold(uint256 _threshold)",
  "function VERSION() view returns (string)",
];
const FACTORY_ABI = ["function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)"];
const MULTISEND = new ethers.utils.Interface(["function multiSend(bytes transactions)"]);
const GUARD_V1_ABI = [
  "function initialize(address _safeWallet)",
  "function getLastTimestampTxs() view returns (uint256)",
  "function checkTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures, address msgSender)",
];

type SafeVersion = "1.3.0" | "1.4.1" | "1.5.0";
type SafeTx = { to: string; value?: number; data?: string; operation?: number; safeTxGas?: number };
type Call = { to: string; data: string };

/** The arguments of `execTransaction` and `checkTransaction` up to the signatures. */
function txArgs(tx: SafeTx) {
  return [tx.to, tx.value ?? 0, tx.data ?? "0x", tx.operation ?? 0, tx.safeTxGas ?? 0, 0, 0, ZERO, ZERO] as const;
}

/** Raw signatures over a Safe transaction hash, in the ascending signer order the Safe asks for. */
function signHash(hash: string, wallets: any[]): string {
  const sorted = [...wallets].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  return ethers.utils.hexConcat(sorted.map((w) => ethers.utils.joinSignature(w._signingKey().signDigest(hash))));
}

const strangers = () => [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];

// The random walk ("in any order of events"): fixed seeds, so a failure
// names its seed and step and runs again the same way.
const WALK_SEEDS = [10102, 20261119];
const WALK_STEPS = 60;

/** mulberry32: a small seeded generator, enough to order test steps. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The guard's clock, as a number of seconds. */
async function clock(guard: any): Promise<number> {
  return (await guard.getLastTimestampTxs()).toNumber();
}

/** Whether the nonce the guard noted is the Safe's nonce. */
async function upToDate(guard: any, safe: any): Promise<boolean> {
  return (await guard.lastNonce()).eq(await safe.nonce());
}

async function timeOf(tx: any): Promise<number> {
  const receipt = await tx.wait();
  return (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;
}

async function execSafeTx(safe: any, tx: SafeTx, owners: any[], sender: any) {
  const nonce = await safe.nonce();
  const hash: string = await safe.getTransactionHash(...txArgs(tx), nonce);
  const signatures = signHash(hash, owners);
  const receipt = await (await safe.connect(sender).execTransaction(...txArgs(tx), signatures)).wait();
  const at = (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;
  return { hash, signatures, receipt, at };
}

function fixturesFor(version: SafeVersion) {
  /** A 2 of 3 Safe and a legacy created for it: two heirs, both needed, after 30 days. Nothing set on the Safe yet. */
  async function createdFixture() {
    const [treasury, relayer, outsider, heir1, heir2, moduleKey] = await ethers.getSigners();

    // The Safe's owners are plain keys, so a test can sign a Safe transaction hash directly.
    const owners = [0, 1, 2].map(() => ethers.Wallet.createRandom().connect(ethers.provider));
    for (const owner of owners) await network.provider.send("hardhat_setBalance", [owner.address, "0x56BC75E2D63100000"]);

    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    const usdc = await ERC20.deploy("USDC", "USDC", 6);

    await network.provider.send("hardhat_setBalance", [DEV, "0x1000000000000000000"]);
    const dev = await ethers.getImpersonatedSigner(DEV);

    const premiumSetting = await deployProxy("PremiumSetting", [], "initialize", dev);
    const payment = await (await ethers.getContractFactory("Payment")).deploy();
    const premiumRegistry = await deployProxy(
      "PremiumRegistry",
      [
        usdt.address,
        usdc.address,
        "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
        "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
        "0x694AA1769357215DE4FAC081bf1f309aDC325306",
        premiumSetting.address,
        payment.address,
      ],
      "initialize",
      dev,
    );
    const verifierTerm = await deployProxy("EIP712LegacyVerifier", [dev.address]);
    const legacyDeployer = await deployProxy("LegacyDeployer");
    const transferEOALegacyRouter = await deployProxy(
      "TransferEOALegacyRouter",
      [
        legacyDeployer.address,
        premiumSetting.address,
        verifierTerm.address,
        payment.address,
        "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008",
        "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
      ],
      "initialize",
      undefined,
      [dev.address],
    );
    const router = await deployProxy("MultisigLegacyRouter", [legacyDeployer.address, premiumSetting.address, verifierTerm.address]);
    await wireRouters({
      admin: dev,
      legacyDeployerAdmin: treasury,
      premiumSetting,
      premiumRegistry,
      legacyDeployer,
      verifierTerm,
      transferEOALegacyRouter,
      multisigLegacyRouter: router,
    });

    // The Safe of this version as it is on mainnet, 2 of 3, with its usual fallback handler.
    const parts = safeBytecode[version];
    assert.equal(parts.singleton.codeHash, PINNED[version], `${version} singleton`);
    for (const part of [parts.singleton, parts.factory, parts.fallbackHandler, parts.multiSendCallOnly]) {
      assert.equal(ethers.utils.keccak256(part.code), part.codeHash, `${version} fixture`);
      await network.provider.send("hardhat_setCode", [part.address, part.code]);
    }
    const factory = new ethers.Contract(parts.factory.address, FACTORY_ABI, relayer);
    const safeInterface = new ethers.utils.Interface(SAFE_ABI);
    const setup = safeInterface.encodeFunctionData("setup", [owners.map((o) => o.address), 2, ZERO, "0x", parts.fallbackHandler.address, ZERO, 0, ZERO]);
    const safeAddress: string = await factory.callStatic.createProxyWithNonce(parts.singleton.address, setup, 1);
    await factory.createProxyWithNonce(parts.singleton.address, setup, 1);
    const safe = new ethers.Contract(safeAddress, SAFE_ABI, ethers.provider);
    assert.equal(await safe.VERSION(), version);
    await treasury.sendTransaction({ to: safeAddress, value: ethers.utils.parseEther("1") });
    // A Safe that has been used: its nonce is not zero when the legacy is created.
    await execSafeTx(safe, { to: safeAddress }, owners.slice(0, 2), relayer);
    assert.equal((await safe.nonce()).toString(), "1");

    const creator = owners[0];
    const legacyAddress: string = await router.getNextLegacyAddress(creator.address);
    const ts = await currentTime();
    const agreement = await creator.signMessage(await genMessage(ts));
    await router
      .connect(creator)
      .createLegacy(
        safeAddress,
        { name: "family", note: "", nickNames: ["one", "two"], beneficiaries: [heir1.address, heir2.address] },
        { minRequiredSignatures: 2, lackOfOutgoingTxRange: WAIT },
        ts,
        agreement,
      );
    const guard = await ethers.getContractAt("SafeGuard", await router.guardAddresses(1));
    const legacy = await ethers.getContractAt("MultisigLegacy", legacyAddress);
    const createdAt: number = await currentTime();

    /** A Safe transaction signed by two owners (the first two unless told otherwise). */
    const exec = (tx: SafeTx, signers = owners.slice(0, 2)) => execSafeTx(safe, tx, signers, relayer);
    /** A call of the Safe on itself. */
    const onSafe = (fn: string, args: unknown[]): Call => ({ to: safeAddress, data: safeInterface.encodeFunctionData(fn, args) });
    /** Calls as one Safe transaction through MultiSendCallOnly, as the app batches them. */
    const batch = (calls: Call[]): SafeTx => ({
      to: parts.multiSendCallOnly.address,
      operation: 1,
      data: MULTISEND.encodeFunctionData("multiSend", [
        ethers.utils.hexConcat(
          calls.map((c) => ethers.utils.solidityPack(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, 0, ethers.utils.hexDataLength(c.data), c.data])),
        ),
      ]),
    });
    /** The Safe calling its guard's hook with nothing in it: how a batch has itself counted. */
    const ping: Call = { to: guard.address, data: guard.interface.encodeFunctionData("checkTransaction", [ZERO, 0, "0x", 0, 0, 0, 0, ZERO, ZERO, "0x", ZERO]) };

    return { router, legacyDeployer, treasury, safe, safeInterface, guard, legacy, owners, relayer, outsider, heir1, heir2, moduleKey, createdAt, creator, exec, onSafe, batch, ping };
  }

  /** The same, set up on the Safe with the app's batch. */
  async function deployFixture() {
    const ctx = await createdFixture();
    const setUp = await ctx.exec(ctx.batch([ctx.onSafe("setGuard", [ctx.guard.address]), ctx.onSafe("enableModule", [ctx.legacy.address]), ctx.ping]));
    return { ...ctx, setUpAt: setUp.at };
  }

  return { createdFixture, deployFixture };
}

describe("LegacyDeployer: the contract that deploys each guard", function () {
  it("has an implementation nobody can initialise and own", async function () {
    const [, outsider] = await ethers.getSigners();
    const implementation = await (await ethers.getContractFactory("LegacyDeployer")).deploy();
    await expectRevert(implementation.connect(outsider).initialize(), "InvalidInitialization()");
    assert.equal(await implementation.owner(), ZERO);
  });

  it("deploys for the routers only: its owner cannot put a legacy where a router said one would be", async function () {
    const { legacyDeployer, treasury, creator, router } = await loadFixture(fixturesFor("1.4.1").createdFixture);
    assert.equal(await legacyDeployer.owner(), treasury.address);
    const code = (await ethers.getContractFactory("MultisigLegacy")).bytecode;
    assert.equal(await legacyDeployer.getNextAddress(code, creator.address), await router.getNextLegacyAddress(creator.address));
    await expectRevert(legacyDeployer.connect(treasury).createLegacy(code, creator.address), "Router only");
    await expectRevert(legacyDeployer.connect(treasury).cloneLegacy(legacyDeployer.address, creator.address), "Router only");
  });
});

describe("SafeGuard bound to an address that does not answer like a Safe", function () {
  it("never reverts in a hook or in sync: the clock moves with its calls, the nonce stays unread", async function () {
    const [, , outsider, plainKey] = await ethers.getSigners();
    // A key answers nothing to `nonce()`; a token has no such function and reverts.
    const token = await (await ethers.getContractFactory("ERC20Token")).deploy("T", "T", 6);
    for (const bound of [plainKey.address, token.address]) {
      const guard = await (await ethers.getContractFactory("SafeGuard")).deploy();
      const started = await timeOf(await guard.initialize(bound));
      assert.equal(await clock(guard), started);
      assert.equal((await guard.lastNonce()).toString(), "0");

      await network.provider.send("hardhat_setBalance", [bound, "0x56BC75E2D63100000"]);
      const caller = await ethers.getImpersonatedSigner(bound);
      await increase(DAY);
      const first = await timeOf(await guard.connect(caller).checkTransaction(ZERO, 0, "0x", 0, 0, 0, 0, ZERO, ZERO, "0x", ZERO));
      assert.equal(await clock(guard), first);
      await increase(DAY);
      const second = await timeOf(await guard.connect(caller).checkModuleTransaction(ZERO, 0, "0x", 0, ZERO));
      assert.equal(await clock(guard), second);
      assert.ok(second > first && first > started);
      await guard.connect(caller).checkAfterExecution(ethers.constants.HashZero, true);
      await guard.connect(caller).checkAfterModuleExecution(ethers.constants.HashZero, true);

      // Nothing proves a missed transaction, so anyone's sync is a call without effect.
      await increase(DAY);
      await guard.connect(outsider).sync();
      assert.equal(await clock(guard), second);
      assert.equal((await guard.lastNonce()).toString(), "0");
    }
  });
});

for (const version of ["1.3.0", "1.4.1", "1.5.0"] as SafeVersion[]) {
  describe(`SafeGuard under Safe ${version}: the clock of a Safe legacy`, function () {
    this.timeout(180000);
    const { createdFixture, deployFixture } = fixturesFor(version);

    /** One Safe transaction seen by the guard, then ten quiet days. */
    async function afterOneSafeTx() {
      const ctx = await loadFixture(deployFixture);
      const tx: SafeTx = { to: ctx.safe.address };
      const last = await ctx.exec(tx);
      const stamped = await clock(ctx.guard);
      assert.equal(stamped, last.at);
      await increase(10 * DAY);
      // What version 1 hashed: the Safe's previous transaction.
      const previous: string = await ctx.safe.getTransactionHash(...txArgs(tx), (await ctx.safe.nonce()).sub(1));
      assert.equal(previous, last.hash);
      return { ...ctx, tx, last, stamped };
    }

    /** The legacy activated by a stranger: who owns the Safe after, and how many must sign. */
    async function activate(ctx: { router: any; safe: any; legacy: any; outsider: any }) {
      await ctx.router.connect(ctx.outsider).activeLegacy(1);
      assert.equal(await ctx.legacy.isLive(), false);
      const owners: string[] = await ctx.safe.getOwners();
      return { owners: [...owners].sort(), threshold: (await ctx.safe.getThreshold()).toNumber() };
    }

    /** A second legacy for the same Safe, created the way the first was: legacy 2 of the router, with its own guard. */
    async function createAgain(ctx: { router: any; safe: any; creator: any; heir1: any; heir2: any }) {
      const ts = await currentTime();
      const agreement = await ctx.creator.signMessage(await genMessage(ts));
      await ctx.router
        .connect(ctx.creator)
        .createLegacy(
          ctx.safe.address,
          { name: "family, again", note: "", nickNames: ["one", "two"], beneficiaries: [ctx.heir1.address, ctx.heir2.address] },
          { minRequiredSignatures: 2, lackOfOutgoingTxRange: WAIT },
          ts,
          agreement,
        );
      const guard = await ethers.getContractAt("SafeGuard", await ctx.router.guardAddresses(2));
      const legacy = await ethers.getContractAt("MultisigLegacy", await ctx.router.legacyAddresses(2));
      return { guard, legacy };
    }

    /** The address a Safe keeps in one of its guard slots. */
    async function inSlot(safe: any, slot: string): Promise<string> {
      return ethers.utils.getAddress("0x" + (await ethers.provider.getStorageAt(safe.address, slot)).slice(26));
    }

    describe("the guard a new legacy gets", function () {
      it("is version 2, bound to its Safe, and notes the time and the Safe's nonce at the creation", async function () {
        const { safe, guard, legacy, createdAt } = await loadFixture(createdFixture);
        assert.equal((await guard.GUARD_VERSION()).toString(), "2");
        assert.equal(await guard.safeWallet(), safe.address);
        assert.equal(await clock(guard), createdAt);
        assert.equal((await guard.lastTimestampTxs()).toNumber(), createdAt);
        assert.equal((await guard.lastNonce()).toString(), "1", "the nonce of a Safe that had executed one transaction");
        assert.equal(await upToDate(guard, safe), true);
        assert.equal(await legacy.safeGuard(), guard.address);
      });

      it("is accepted by the Safe as its guard, beside the legacy as its module, and the app's batch counts itself", async function () {
        const { safe, guard, legacy, router, setUpAt, createdAt } = await loadFixture(deployFixture);
        assert.equal(await guard.supportsInterface("0xe6d7a83a"), true, "the transaction guard interface");
        assert.equal(await guard.supportsInterface("0x58401ed8"), true, "Safe 1.5.0's module guard interface");
        assert.equal(await guard.supportsInterface("0x01ffc9a7"), true, "ERC-165");
        assert.equal(await guard.supportsInterface("0xffffffff"), false);
        const stored = await ethers.provider.getStorageAt(safe.address, GUARD_SLOT);
        assert.equal(ethers.utils.getAddress("0x" + stored.slice(26)), guard.address);
        assert.equal(await safe.isModuleEnabled(legacy.address), true);

        // The Safe read its guard before the batch ran, so the guard saw it only through the batch's last call.
        assert.ok(setUpAt > createdAt);
        assert.equal(await clock(guard), setUpAt);
        assert.equal(await upToDate(guard, safe), true);
        assert.equal(await router.checkActiveLegacy(1), false);
      });

      it("cannot be bound a second time", async function () {
        const { safe, guard, outsider } = await loadFixture(deployFixture);
        await expectRevert(guard.connect(outsider).initialize(outsider.address), "SafeGuardInitialized()");
        assert.equal(await guard.safeWallet(), safe.address);
      });
    });

    describe("a transaction of the Safe", function () {
      it("moves the clock and the nonce noted", async function () {
        const { safe, guard, owners, exec, setUpAt } = await loadFixture(deployFixture);
        await increase(5 * DAY);
        const { at } = await exec({ to: safe.address }, owners.slice(1, 3));
        assert.equal(await clock(guard), at);
        assert.ok(at >= setUpAt + 5 * DAY);
        assert.equal((await guard.lastNonce()).toString(), "3", "one before the creation, the set-up, this one");
        assert.equal(await upToDate(guard, safe), true);
      });

      it("moves the clock when its inner call fails: the owners signed, so they are there", async function () {
        const { safe, guard, exec } = await loadFixture(deployFixture);
        await increase(3 * DAY);
        // An unknown call on the guard reverts; with safeTxGas set the Safe records the failure and goes on.
        const { receipt, at } = await exec({ to: guard.address, data: "0xdeadbeef", safeTxGas: 100000 });
        assert.ok(
          receipt.logs.some((log: any) => log.address === safe.address && log.topics[0] === EXECUTION_FAILURE),
          "the inner call failed",
        );
        assert.equal(await clock(guard), at);
        assert.equal(await upToDate(guard, safe), true);
      });
    });

    describe("a call that is not the Safe's", function () {
      it("moved a version 1 guard: the code from mainnet takes signatures of keys that own nothing", async function () {
        const { safe, outsider, tx, last } = await afterOneSafeTx();
        const v1 = safeBytecode["guard-v1"].guard;
        assert.equal(v1.codeHash, PINNED["guard-v1"]);
        assert.equal(ethers.utils.keccak256(v1.code), v1.codeHash, "guard-v1 fixture");
        const at = ethers.Wallet.createRandom().address;
        await network.provider.send("hardhat_setCode", [at, v1.code]);
        const guardV1 = new ethers.Contract(at, GUARD_V1_ABI, outsider);
        await guardV1.initialize(safe.address);
        const bound = await clock(guardV1);

        await increase(DAY);
        await guardV1.checkTransaction(...txArgs(tx), signHash(last.hash, strangers()), outsider.address);
        assert.ok((await clock(guardV1)) >= bound + DAY, "the stranger moved version 1");
      });

      it("with signatures of keys that own nothing: changes nothing", async function () {
        const { guard, outsider, tx, last, stamped } = await afterOneSafeTx();
        await guard.connect(outsider).checkTransaction(...txArgs(tx), signHash(last.hash, strangers()), outsider.address);
        assert.equal(await clock(guard), stamped);
      });

      it("with the owners' own signatures of the last transaction, replayed: changes nothing", async function () {
        const { guard, outsider, tx, last, stamped } = await afterOneSafeTx();
        await guard.connect(outsider).checkTransaction(...txArgs(tx), last.signatures, outsider.address);
        assert.equal(await clock(guard), stamped);
      });

      it("from an owner, straight to the guard: changes nothing", async function () {
        const { guard, owners, tx, last, stamped } = await afterOneSafeTx();
        await guard.connect(owners[0]).checkTransaction(...txArgs(tx), last.signatures, owners[0].address);
        assert.equal(await clock(guard), stamped);
      });

      it("naming the Safe as the sender, reporting an execution or a module's transaction: changes nothing", async function () {
        const { safe, guard, outsider, tx, last, stamped } = await afterOneSafeTx();
        await guard.connect(outsider).checkTransaction(...txArgs(tx), last.signatures, safe.address);
        await guard.connect(outsider).checkAfterExecution(last.hash, true);
        await guard.connect(outsider).checkModuleTransaction(safe.address, 0, "0x", 0, safe.address);
        await guard.connect(outsider).checkAfterModuleExecution(last.hash, true);
        assert.equal(await clock(guard), stamped);
        assert.equal(await upToDate(guard, safe), true);
      });

      it("asking the guard to catch up when it has missed nothing: changes nothing", async function () {
        const { safe, guard, outsider, owners, stamped } = await afterOneSafeTx();
        await guard.connect(outsider).sync();
        await guard.connect(owners[0]).sync();
        assert.equal(await clock(guard), stamped);
        assert.equal(await upToDate(guard, safe), true);
      });
    });

    describe("a legacy that kept a version 1 guard (created before 2026-11)", function () {
      /** The created legacy with the version 1 code from mainnet at its guard's address, showing the time of the creation. */
      async function onVersion1() {
        const ctx = await loadFixture(createdFixture);
        const v1 = safeBytecode["guard-v1"].guard;
        assert.equal(v1.codeHash, PINNED["guard-v1"]);
        assert.equal(ethers.utils.keccak256(v1.code), v1.codeHash, "guard-v1 fixture");
        await network.provider.send("hardhat_setCode", [ctx.guard.address, v1.code]);
        // Version 1 keeps the time alone in its first slot, and the Safe in its second as version 2 does.
        await network.provider.send("hardhat_setStorageAt", [ctx.guard.address, "0x0", ethers.utils.hexZeroPad(ethers.utils.hexlify(ctx.createdAt), 32)]);
        const guardV1 = new ethers.Contract(ctx.guard.address, GUARD_V1_ABI, ethers.provider);
        assert.equal(await clock(guardV1), ctx.createdAt);
        await assert.rejects(ctx.guard.lastNonce(), "version 1 keeps no nonce");
        return { ...ctx, guardV1 };
      }

      it("is set up by the app's batch all the same: the last call is the Safe's, so the wait starts at the set-up", async function () {
        const ctx = await onVersion1();
        const { router, guard, guardV1, legacy, exec, onSafe, batch, ping, outsider, createdAt, owners, heir1, heir2 } = ctx;
        const setUp = await exec(batch([onSafe("setGuard", [guard.address]), onSafe("enableModule", [legacy.address]), ping]));
        assert.ok(setUp.at > createdAt);
        assert.equal(await clock(guardV1), setUp.at);

        await increase(WAIT - DAY);
        assert.equal(await router.checkActiveLegacy(1), false);
        await expectRevert(router.connect(outsider).activeLegacy(1), "NotEnoughContitionalActive()");
        await increase(DAY);
        assert.equal(await router.checkActiveLegacy(1), true);
        const after = await activate(ctx);
        assert.deepEqual(after.owners, [...owners.map((o) => o.address), heir1.address, heir2.address].sort());
        assert.equal(after.threshold, 2);
      });

      it("is taken at its word by the router: it has no nonce to be behind with, and activates on the time it shows", async function () {
        const ctx = await onVersion1();
        const { router, guard, guardV1, legacy, exec, onSafe, createdAt } = ctx;
        // Set up by hand, in two transactions the guard does not see. A version 2 guard would be behind here.
        await exec(onSafe("enableModule", [legacy.address]));
        await exec(onSafe("setGuard", [guard.address]));
        assert.equal(await clock(guardV1), createdAt);
        await increase(WAIT);
        assert.equal(await router.checkActiveLegacy(1), true);
        assert.equal((await activate(ctx)).owners.length, 5);
      });

      it("gives way to version 2 when the Safe deletes the legacy and creates it again", async function () {
        const ctx = await onVersion1();
        const { router, safe, guard, legacy, exec, onSafe, batch, outsider, owners, heir1, heir2 } = ctx;
        await exec(batch([onSafe("setGuard", [guard.address]), onSafe("enableModule", [legacy.address]), ctx.ping]));
        // One legacy per Safe: while the first is on it, the router creates no second.
        await expectRevert(createAgain(ctx), "ExistedGuardInSafeWallet(address)");

        // The app's delete: the guard off and the module disabled, in one Safe transaction.
        await exec(batch([onSafe("setGuard", [ZERO]), onSafe("disableModule", [SENTINEL, legacy.address])]));
        const again = await createAgain(ctx);
        assert.notEqual(again.guard.address, guard.address);
        assert.equal((await again.guard.GUARD_VERSION()).toString(), "2");
        assert.equal(await again.guard.safeWallet(), safe.address);
        assert.equal(await upToDate(again.guard, safe), true);
        const againPing: Call = { to: again.guard.address, data: ctx.ping.data };
        const setUp = await exec(batch([onSafe("setGuard", [again.guard.address]), onSafe("enableModule", [again.legacy.address]), againPing]));
        assert.equal(await clock(again.guard), setUp.at);
        assert.equal(await inSlot(safe, GUARD_SLOT), again.guard.address);

        // The first legacy is off the Safe for good, whatever its guard shows; the second runs on the Safe's own clock.
        await increase(WAIT);
        assert.equal(await router.checkActiveLegacy(1), false);
        await expectRevert(router.connect(outsider).activeLegacy(1), "GuardSafeWalletInvalid()");
        assert.equal(await router.checkActiveLegacy(2), true);
        await router.connect(outsider).activeLegacy(2);
        assert.equal(await again.legacy.isLive(), false);
        assert.equal(await legacy.isLive(), true);
        assert.deepEqual([...(await safe.getOwners())].sort(), [...owners.map((o) => o.address), heir1.address, heir2.address].sort());
        assert.equal((await safe.getThreshold()).toNumber(), 2);
      });
    });

    describe("what the guard did not see", function () {
      it("a set-up without the app's last call: no activation on the old time; anyone has it counted and the wait starts then", async function () {
        const { router, safe, guard, legacy, exec, onSafe, outsider, createdAt } = await loadFixture(createdFixture);
        await exec(onSafe("enableModule", [legacy.address]));
        await exec(onSafe("setGuard", [guard.address]));
        // Two transactions of the Safe, neither seen: a Safe reads its guard before it executes.
        assert.equal(await clock(guard), createdAt);
        assert.equal(await upToDate(guard, safe), false);

        await increase(WAIT + DAY);
        assert.equal(await legacy.checkActiveLegacy(guard.address), true, "by the old time alone the wait is over");
        assert.equal(await router.checkActiveLegacy(1), false);
        await expectRevert(router.connect(outsider).activeLegacy(1), "GuardBehindSafeWallet()");

        const at = await timeOf(await guard.connect(outsider).sync());
        assert.equal(await clock(guard), at);
        assert.equal(await upToDate(guard, safe), true);
        await expectRevert(router.connect(outsider).activeLegacy(1), "NotEnoughContitionalActive()");

        // Counted once: a second call does not push the wait further.
        await increase(WAIT - DAY);
        await guard.connect(outsider).sync();
        assert.equal(await clock(guard), at);
        assert.equal(await router.checkActiveLegacy(1), false);
        await increase(DAY);
        assert.equal(await router.checkActiveLegacy(1), true);
        assert.equal((await activate({ router, safe, legacy, outsider })).owners.length, 5);
      });

      it("the same set-up: the Safe's next transaction brings the guard up to date by itself", async function () {
        const { router, safe, guard, legacy, exec, onSafe } = await loadFixture(createdFixture);
        await exec(onSafe("enableModule", [legacy.address]));
        await exec(onSafe("setGuard", [guard.address]));
        assert.equal(await upToDate(guard, safe), false);

        await increase(WAIT + DAY);
        const { at } = await exec({ to: safe.address });
        assert.equal(await clock(guard), at);
        assert.equal(await upToDate(guard, safe), true);
        assert.equal(await router.checkActiveLegacy(1), false);
        await increase(WAIT);
        assert.equal(await router.checkActiveLegacy(1), true);
      });

      it("a Safe that took the guard off and left the module: no activation, its clock stopped and the Safe did not", async function () {
        const { router, safe, guard, legacy, exec, onSafe, outsider, setUpAt } = await loadFixture(deployFixture);
        // The Safe saw the guard for the last time when it took it off, and goes on working without it.
        const off = await exec(onSafe("setGuard", [ZERO]));
        assert.equal(await clock(guard), off.at);
        assert.ok(off.at > setUpAt);
        await increase(WAIT + DAY);
        await exec({ to: safe.address });
        assert.equal(await clock(guard), off.at, "a Safe without the guard does not move it");
        assert.equal(await safe.isModuleEnabled(legacy.address), true);

        // By the clock alone the wait is over; the Safe is in use, so nobody gets in.
        assert.equal(await legacy.checkActiveLegacy(guard.address), true);
        assert.equal(await router.checkActiveLegacy(1), false);
        await expectRevert(router.connect(outsider).activeLegacy(1), "GuardSafeWalletInvalid()");
        assert.equal((await safe.getOwners()).length, 3);
        assert.equal(await legacy.isLive(), true);
      });

      it("a guard set again after a time off: the old time does not count, in the very next block either", async function () {
        const { router, safe, guard, legacy, exec, onSafe, outsider } = await loadFixture(deployFixture);
        const off = await exec(onSafe("setGuard", [ZERO]));
        await increase(WAIT + DAY);
        await exec({ to: safe.address });
        await exec(onSafe("setGuard", [guard.address]));

        // The guard is the Safe's guard again and shows a time more than the wait ago.
        assert.equal(await clock(guard), off.at);
        assert.equal(await legacy.checkActiveLegacy(guard.address), true);
        assert.equal(await upToDate(guard, safe), false);
        assert.equal(await router.checkActiveLegacy(1), false);
        await expectRevert(router.connect(outsider).activeLegacy(1), "GuardBehindSafeWallet()");

        const at = await timeOf(await guard.connect(outsider).sync());
        assert.equal(await clock(guard), at);
        await increase(WAIT - DAY);
        assert.equal(await router.checkActiveLegacy(1), false);
        await increase(DAY);
        assert.equal(await router.checkActiveLegacy(1), true);
      });

      it("a Safe that put another guard in its place: no activation", async function () {
        const { router, safe, guard, legacy, exec, onSafe, outsider } = await loadFixture(deployFixture);
        const other = await (await ethers.getContractFactory("SafeGuard")).deploy();
        await other.initialize(safe.address);
        await exec(onSafe("setGuard", [other.address]));
        await increase(WAIT + DAY);
        assert.equal(await legacy.checkActiveLegacy(guard.address), true);
        assert.equal(await router.checkActiveLegacy(1), false);
        await expectRevert(router.connect(outsider).activeLegacy(1), "GuardSafeWalletInvalid()");
      });

      it("a Safe that kept the guard and disabled the module: no activation, and the check says so", async function () {
        const { router, safe, guard, legacy, exec, onSafe, outsider } = await loadFixture(deployFixture);
        await exec(onSafe("disableModule", [SENTINEL, legacy.address]));
        await increase(WAIT + DAY);
        assert.equal(await legacy.checkActiveLegacy(guard.address), true);
        assert.equal(await upToDate(guard, safe), true);
        assert.equal(await router.checkActiveLegacy(1), false);
        await expectRevert(router.connect(outsider).activeLegacy(1), "ModuleSafeWalletInvalid()");
      });

      it("a legacy never set up on its Safe: no activation", async function () {
        const { router, guard, legacy, outsider } = await loadFixture(createdFixture);
        await increase(WAIT + DAY);
        assert.equal(await legacy.checkActiveLegacy(guard.address), true);
        assert.equal(await router.checkActiveLegacy(1), false);
        await expectRevert(router.connect(outsider).activeLegacy(1), "GuardSafeWalletInvalid()");
      });
    });

    describe("a Safe used through a module", function () {
      it("a module can have the Safe call the guard, and that counts", async function () {
        const { safe, guard, exec, onSafe, moduleKey, ping } = await loadFixture(deployFixture);
        await exec(onSafe("enableModule", [moduleKey.address]));
        await increase(DAY);
        const at = await timeOf(await safe.connect(moduleKey).execTransactionFromModule(ping.to, 0, ping.data, 0));
        assert.equal(await clock(guard), at);
        assert.equal(await upToDate(guard, safe), true);
      });

      if (version !== "1.5.0") {
        it(`a module's transaction is not seen: Safe ${version} has no guard for modules`, async function () {
          const { safe, guard, exec, onSafe, moduleKey, outsider } = await loadFixture(deployFixture);
          const enabled = await exec(onSafe("enableModule", [moduleKey.address]));
          await increase(DAY);
          await (await safe.connect(moduleKey).execTransactionFromModule(outsider.address, 1, "0x", 0)).wait();
          assert.equal(await clock(guard), enabled.at);
          // A module's transaction has no nonce, so nothing shows the guard it missed one.
          assert.equal(await upToDate(guard, safe), true);
        });
      } else {
        it("a module's transaction counts once the Safe sets the guard for its modules too", async function () {
          const ctx = await loadFixture(deployFixture);
          const { safe, guard, exec, onSafe, moduleKey, outsider, heir1, heir2, owners } = ctx;
          const enabled = await exec(onSafe("enableModule", [moduleKey.address]));
          await increase(DAY);
          await (await safe.connect(moduleKey).execTransactionFromModule(outsider.address, 1, "0x", 0)).wait();
          assert.equal(await clock(guard), enabled.at, "not seen without the module guard");

          await exec(onSafe("setModuleGuard", [guard.address]));
          await increase(DAY);
          const at = await timeOf(await safe.connect(moduleKey).execTransactionFromModule(outsider.address, 1, "0x", 0));
          assert.equal(await clock(guard), at);
          assert.equal(await upToDate(guard, safe), true);

          // The legacy is a module itself: its activation passes the same hook.
          await increase(WAIT);
          const after = await activate(ctx);
          assert.deepEqual(after.owners, [...owners.map((o) => o.address), heir1.address, heir2.address].sort());
          assert.equal(after.threshold, 2);
        });

        it("the app's batch for this Safe sets the guard for its modules in the same transaction, and its delete takes all of it off", async function () {
          const ctx = await loadFixture(createdFixture);
          const { router, safe, guard, legacy, exec, onSafe, batch, ping, moduleKey, outsider } = ctx;
          const setUp = await exec(
            batch([onSafe("setGuard", [guard.address]), onSafe("setModuleGuard", [guard.address]), onSafe("enableModule", [legacy.address]), ping]),
          );
          assert.equal(await inSlot(safe, GUARD_SLOT), guard.address);
          assert.equal(await inSlot(safe, MODULE_GUARD_SLOT), guard.address);
          assert.equal(await safe.isModuleEnabled(legacy.address), true);
          assert.equal(await clock(guard), setUp.at);
          assert.equal(await upToDate(guard, safe), true);

          // From the first day on, what a module does for the Safe starts the wait again.
          await exec(onSafe("enableModule", [moduleKey.address]));
          await increase(WAIT - DAY);
          const moved = await timeOf(await safe.connect(moduleKey).execTransactionFromModule(outsider.address, 1, "0x", 0));
          assert.equal(await clock(guard), moved);
          await increase(2 * DAY);
          assert.equal(await router.checkActiveLegacy(1), false);
          await expectRevert(router.connect(outsider).activeLegacy(1), "NotEnoughContitionalActive()");

          // The delete: the guard, the module guard and the module, each only the legacy's own.
          await exec(batch([onSafe("setGuard", [ZERO]), onSafe("setModuleGuard", [ZERO]), onSafe("disableModule", [moduleKey.address, legacy.address])]));
          assert.equal(await inSlot(safe, GUARD_SLOT), ZERO);
          assert.equal(await inSlot(safe, MODULE_GUARD_SLOT), ZERO);
          assert.equal(await safe.isModuleEnabled(legacy.address), false);
          assert.equal(await safe.isModuleEnabled(moduleKey.address), true, "another module of the Safe stays");
          const quiet = await clock(guard);
          await (await safe.connect(moduleKey).execTransactionFromModule(outsider.address, 1, "0x", 0)).wait();
          await exec({ to: safe.address });
          assert.equal(await clock(guard), quiet, "nothing of the Safe reaches the guard any more");
          await increase(WAIT);
          await expectRevert(router.connect(outsider).activeLegacy(1), "GuardSafeWalletInvalid()");
        });

        it("a guard an earlier legacy left on the Safe's modules is one the next legacy's set-up can tell and replace", async function () {
          const ctx = await loadFixture(createdFixture);
          const { router, safe, guard, legacy, exec, onSafe, batch, ping, moduleKey, outsider, owners, heir1, heir2 } = ctx;
          await exec(batch([onSafe("setGuard", [guard.address]), onSafe("setModuleGuard", [guard.address]), onSafe("enableModule", [legacy.address]), ping]));
          // Taken off by hand, the module guard forgotten.
          await exec(batch([onSafe("setGuard", [ZERO]), onSafe("disableModule", [SENTINEL, legacy.address])]));
          assert.equal(await inSlot(safe, MODULE_GUARD_SLOT), guard.address);

          // What the app asks before it replaces a module guard: the same code as the new guard, bound to this Safe.
          const again = await createAgain(ctx);
          assert.equal(await ethers.provider.getCode(guard.address), await ethers.provider.getCode(again.guard.address));
          assert.equal(await guard.safeWallet(), safe.address);
          const againPing: Call = { to: again.guard.address, data: ping.data };
          const setUp = await exec(
            batch([
              onSafe("setGuard", [again.guard.address]),
              onSafe("setModuleGuard", [again.guard.address]),
              onSafe("enableModule", [again.legacy.address]),
              againPing,
            ]),
          );
          assert.equal(await inSlot(safe, MODULE_GUARD_SLOT), again.guard.address);
          assert.equal(await clock(again.guard), setUp.at);

          // The Safe's modules now move the new guard and no longer the old one.
          await exec(onSafe("enableModule", [moduleKey.address]));
          const old = await clock(guard);
          await increase(DAY);
          const moved = await timeOf(await safe.connect(moduleKey).execTransactionFromModule(outsider.address, 1, "0x", 0));
          assert.equal(await clock(again.guard), moved);
          assert.equal(await clock(guard), old);

          await increase(WAIT);
          await expectRevert(router.connect(outsider).activeLegacy(1), "GuardSafeWalletInvalid()");
          await router.connect(outsider).activeLegacy(2);
          assert.equal(await again.legacy.isLive(), false);
          assert.deepEqual([...(await safe.getOwners())].sort(), [...owners.map((o) => o.address), heir1.address, heir2.address].sort());
        });
      }
    });

    describe("the legacy on that clock", function () {
      it("cannot be activated while the Safe is active, and each Safe transaction starts the wait again", async function () {
        const { router, safe, exec, outsider } = await loadFixture(deployFixture);
        await increase(WAIT - DAY);
        assert.equal(await router.checkActiveLegacy(1), false);
        await exec({ to: safe.address });

        await increase(WAIT - DAY);
        assert.equal(await router.checkActiveLegacy(1), false);
        await expectRevert(router.connect(outsider).activeLegacy(1), "NotEnoughContitionalActive()");
      });

      it("activates after the wait, whatever a stranger sent the guard on the way", async function () {
        const ctx = await loadFixture(deployFixture);
        const { router, safe, guard, owners, outsider, heir1, heir2, setUpAt } = ctx;
        const tx: SafeTx = { to: safe.address };
        const hash: string = await safe.getTransactionHash(...txArgs(tx), (await safe.nonce()).sub(1));

        // A stranger tries to hold the clock back, before and after the wait runs out.
        await increase(WAIT - DAY);
        await guard.connect(outsider).checkTransaction(...txArgs(tx), signHash(hash, strangers()), outsider.address);
        await guard.connect(outsider).sync();
        await increase(2 * DAY);
        await guard.connect(outsider).checkTransaction(...txArgs(tx), signHash(hash, strangers()), outsider.address);
        await guard.connect(outsider).sync();
        assert.equal(await clock(guard), setUpAt);
        assert.equal(await router.checkActiveLegacy(1), true);

        // Anyone may activate. The heirs join the owners, and the threshold is the one the Safe had and the legacy named.
        const after = await activate(ctx);
        assert.deepEqual(after.owners, [...owners.map((o) => o.address), heir1.address, heir2.address].sort());
        assert.equal(after.threshold, 2);

        // Activated once, and the check says so from then on.
        await expectRevert(router.connect(outsider).activeLegacy(1), "LegacyNotActive()");
        assert.equal(await router.checkActiveLegacy(1), false);
        await increase(WAIT);
        assert.equal(await router.checkActiveLegacy(1), false);
      });

      it("takes changes from the legacy's own Safe only: a contract that answers the way that Safe would is refused", async function () {
        const { router, guard, legacy, exec, outsider } = await loadFixture(deployFixture);
        const lookalike = await (await ethers.getContractFactory("MockSafeLookalike")).deploy(guard.address, legacy.address);
        const calls = [
          router.interface.encodeFunctionData("setNameNote", [1, "not yours", "send your keys to this address"]),
          router.interface.encodeFunctionData("setActivationTrigger", [1, 1]),
          router.interface.encodeFunctionData("setLegacyBeneficiaries", [1, ["me"], [outsider.address], 1]),
          router.interface.encodeFunctionData("setLegacyConfig", [
            1,
            { name: "x", note: "", nickNames: ["me"], beneficiaries: [outsider.address] },
            { minRequiredSignatures: 1, lackOfOutgoingTxRange: 1 },
          ]),
        ];
        for (const data of calls) {
          await expectRevert(lookalike.connect(outsider).forward(router.address, data), "SenderIsNotSafeWalletOfLegacy()");
        }
        assert.equal(await legacy.getLegacyName(), "family");

        // The Safe itself renames its legacy as before.
        await exec({ to: router.address, data: router.interface.encodeFunctionData("setNameNote", [1, "ours", "a note"]) });
        assert.equal(await legacy.getLegacyName(), "ours");
      });

      it("lowers the Safe's threshold to the one the legacy names", async function () {
        const ctx = await loadFixture(deployFixture);
        const { router, exec, heir1, heir2 } = ctx;
        // The Safe is 2 of 3; its legacy now asks for one signature.
        await exec({ to: router.address, data: router.interface.encodeFunctionData("setLegacyBeneficiaries", [1, ["one", "two"], [heir1.address, heir2.address], 1]) });
        await increase(WAIT);
        const after = await activate(ctx);
        assert.equal(after.owners.length, 5);
        assert.equal(after.threshold, 1);
      });

      it("raises the Safe's threshold to the one the legacy names", async function () {
        const ctx = await loadFixture(deployFixture);
        const { safe, exec, onSafe } = ctx;
        await exec(onSafe("changeThreshold", [1]));
        assert.equal((await safe.getThreshold()).toString(), "1");
        await increase(WAIT);
        const after = await activate(ctx);
        assert.equal(after.owners.length, 5);
        assert.equal(after.threshold, 2);
      });

      it("activates when the Safe made one of the heirs an owner in the meantime: the other still joins", async function () {
        const ctx = await loadFixture(deployFixture);
        const { safe, exec, onSafe, owners, heir1, heir2 } = ctx;
        await exec(onSafe("addOwnerWithThreshold", [heir1.address, 2]));
        assert.equal((await safe.getOwners()).length, 4);

        await increase(WAIT);
        const after = await activate(ctx);
        assert.deepEqual(after.owners, [...owners.map((o) => o.address), heir1.address, heir2.address].sort());
        assert.equal(after.threshold, 2);
      });

      it("activates when every heir is an owner already: nobody to add, the threshold still set", async function () {
        const ctx = await loadFixture(deployFixture);
        const { exec, onSafe, owners, heir1, heir2 } = ctx;
        await exec(onSafe("addOwnerWithThreshold", [heir1.address, 3]));
        await exec(onSafe("addOwnerWithThreshold", [heir2.address, 3]), owners);
        await increase(WAIT);
        const after = await activate(ctx);
        assert.deepEqual(after.owners, [...owners.map((o) => o.address), heir1.address, heir2.address].sort());
        assert.equal(after.threshold, 2);
      });

      it("refuses a beneficiary a Safe could never take as an owner", async function () {
        const { router, safe, owners } = await loadFixture(createdFixture);
        const ts = await currentTime();
        const agreement = await owners[1].signMessage(await genMessage(ts));
        for (const bad of [SENTINEL, ZERO, safe.address, owners[2].address]) {
          await expectRevert(
            router
              .connect(owners[1])
              .createLegacy(safe.address, { name: "x", note: "", nickNames: ["one"], beneficiaries: [bad] }, { minRequiredSignatures: 1, lackOfOutgoingTxRange: WAIT }, ts, agreement),
            "BeneficiaryInvalid()",
          );
        }
      });
    });

    // The cases above each walk one path. Here the Safe, strangers and a
    // module act in an order drawn from a seed, and after every step the
    // guard and the router are held to a model of five facts: the clock,
    // the nonce noted, and whether the guard, the legacy and (1.5.0) the
    // module guard are on the Safe. What must hold throughout: only the Safe
    // moves the clock, `sync` moves it exactly when the nonce shows a missed
    // transaction, and `checkActiveLegacy` is true exactly when
    // `activeLegacy` goes through, with the reason it gives when it does not.
    describe("in any order of events", function () {
      for (const seed of WALK_SEEDS) {
        it(`holds to the model over ${WALK_STEPS} steps (seed ${seed})`, async function () {
          const ctx = await loadFixture(deployFixture);
          const { router, safe, guard, legacy, exec, onSafe, batch, ping, outsider, moduleKey, heir1, heir2, owners } = ctx;
          const random = prng(seed);
          const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
          const modules = new ethers.Contract(safe.address, ["function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)"], ethers.provider);
          const nonceNow = async (): Promise<number> => (await safe.nonce()).toNumber();

          // A second module, a plain key, so the Safe can be used without its owners.
          const first = await exec(onSafe("enableModule", [moduleKey.address]));
          const model = { clock: first.at, noted: await nonceNow(), guardOn: true, legacyOn: true, moduleGuardOn: false };

          /** A transaction the Safe's owners signed: the guard sees it when it was the Safe's guard as the transaction began. */
          const safeTx = async (tx: SafeTx, pings = false) => {
            const seen = model.guardOn;
            const { at } = await exec(tx);
            if (seen || pings) {
              model.clock = at;
              model.noted = await nonceNow();
            }
          };
          const moduleTx = async (to: string, value: number, data: string, counts: boolean) => {
            const at = await timeOf(await safe.connect(moduleKey).execTransactionFromModule(to, value, data, 0));
            if (counts) {
              model.clock = at;
              model.noted = await nonceNow();
            }
          };

          const steps: Record<string, () => Promise<void>> = {
            "a Safe transaction": () => safeTx({ to: outsider.address, value: 1 }),
            "a Safe transaction whose inner call fails": () => safeTx({ to: router.address, data: "0xdeadbeef", safeTxGas: 100000 }),
            "the Safe has the guard count a call": () => safeTx({ to: ping.to, data: ping.data }, true),
            "a wait": () => increase(pick([1, 5, 12, 29]) * DAY + 3600),
            "a wait longer than the legacy's": () => increase(pick([31, 45]) * DAY),
            "a stranger calls a hook": async () => {
              const tx: SafeTx = { to: safe.address };
              const hash: string = await safe.getTransactionHash(...txArgs(tx), (await safe.nonce()).sub(1));
              await pick([
                () => guard.connect(outsider).checkTransaction(...txArgs(tx), signHash(hash, strangers()), outsider.address),
                () => guard.connect(outsider).checkTransaction(...txArgs(tx), signHash(hash, owners.slice(0, 2)), outsider.address),
                () => guard.connect(outsider).checkAfterExecution(hash, true),
                () => guard.connect(outsider).checkModuleTransaction(outsider.address, 0, "0x", 0, outsider.address),
                () => guard.connect(outsider).checkAfterModuleExecution(hash, true),
              ])();
            },
            "anyone calls sync": async () => {
              const behind = model.noted !== (await nonceNow());
              const at = await timeOf(await guard.connect(outsider).sync());
              if (behind) {
                model.clock = at;
                model.noted = await nonceNow();
              }
            },
            "the Safe takes the guard off or sets it again": async () => {
              if (model.guardOn) {
                await safeTx(onSafe("setGuard", [ZERO]));
                model.guardOn = false;
              } else if (random() < 0.5) {
                // Set alone: the Safe read its guard before, so the guard is behind by this transaction.
                await safeTx(onSafe("setGuard", [guard.address]));
                model.guardOn = true;
              } else {
                // Set the way the app does, with the call that has it counted.
                await safeTx(batch([onSafe("setGuard", [guard.address]), ping]), true);
                model.guardOn = true;
              }
            },
            "the Safe disables the legacy or enables it again": async () => {
              if (model.legacyOn) {
                const [list]: [string[]] = await modules.getModulesPaginated(SENTINEL, 10);
                const at = list.indexOf(legacy.address);
                await safeTx(onSafe("disableModule", [at === 0 ? SENTINEL : list[at - 1], legacy.address]));
              } else {
                await safeTx(onSafe("enableModule", [legacy.address]));
              }
              model.legacyOn = !model.legacyOn;
            },
            "a module moves funds": () => moduleTx(outsider.address, 1, "0x", model.moduleGuardOn),
            "a module has the Safe call the guard": () => moduleTx(ping.to, 0, ping.data, true),
          };
          if (version === "1.5.0") {
            steps["the Safe sets or clears the module guard"] = async () => {
              await safeTx(onSafe("setModuleGuard", [model.moduleGuardOn ? ZERO : guard.address]));
              model.moduleGuardOn = !model.moduleGuardOn;
            };
          }
          const names = Object.keys(steps);

          const trail: string[] = [];
          let answeredTrue = 0;
          for (let i = 0; i < WALK_STEPS; i++) {
            const name = pick(names);
            trail.push(name);
            const where = `seed ${seed}, step ${i + 1} (${trail.slice(-6).join(" > ")})`;
            await steps[name]();

            assert.equal(await clock(guard), model.clock, `the clock: ${where}`);
            assert.equal((await guard.lastNonce()).toNumber(), model.noted, `the nonce noted: ${where}`);
            assert.ok(model.noted <= (await nonceNow()), `the guard never notes a nonce the Safe has not reached: ${where}`);
            const stored = await ethers.provider.getStorageAt(safe.address, GUARD_SLOT);
            assert.equal(ethers.utils.getAddress("0x" + stored.slice(26)), model.guardOn ? guard.address : ZERO, `the Safe's guard: ${where}`);
            assert.equal(await safe.isModuleEnabled(legacy.address), model.legacyOn, `the module: ${where}`);

            // Whether the wait has run out is asked a block later than it is read here: leave the minutes around it out.
            const waited = (await currentTime()) - model.clock;
            if (Math.abs(waited - WAIT) < 600) continue;
            const reason = !model.guardOn
              ? "GuardSafeWalletInvalid()"
              : !model.legacyOn
                ? "ModuleSafeWalletInvalid()"
                : model.noted !== (await nonceNow())
                  ? "GuardBehindSafeWallet()"
                  : waited < WAIT
                    ? "NotEnoughContitionalActive()"
                    : null;
            assert.equal(await router.checkActiveLegacy(1), reason === null, `checkActiveLegacy: ${where}`);
            if (reason === null) {
              answeredTrue += 1;
              await router.connect(outsider).callStatic.activeLegacy(1);
            } else {
              await expectRevert(router.connect(outsider).callStatic.activeLegacy(1), reason);
            }
          }

          // A walk that never came to a ready legacy would have left the answer "true" untested.
          assert.ok(answeredTrue > 0, `seed ${seed} never reached a legacy that can be activated`);

          // The walk ends the way a legacy does: set up, one last transaction of the Safe, the wait, a stranger activates.
          if (!model.guardOn) await exec(batch([onSafe("setGuard", [guard.address]), ping]));
          if (!model.legacyOn) await exec(onSafe("enableModule", [legacy.address]));
          const last = await exec({ to: safe.address });
          assert.equal(await clock(guard), last.at);
          assert.equal(await upToDate(guard, safe), true);
          assert.equal(await router.checkActiveLegacy(1), false);
          await increase(WAIT);
          assert.equal(await router.checkActiveLegacy(1), true);
          const after = await activate(ctx);
          assert.ok(after.owners.includes(heir1.address) && after.owners.includes(heir2.address));
          assert.equal(after.threshold, 2);
          assert.equal(await router.checkActiveLegacy(1), false);
        });
      }
    });
  });
}

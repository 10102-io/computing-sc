/**
 * Shared fixture for the 2026-11 train specs (docs/plans/train-2026-11.md):
 * the EOA router with a signer standing in for the UpgradeTimelock, the new
 * clone implementation and LegacyPullVaultV2 wired through it (as the timelock
 * batch does), a real-shaped token set (a no-return USDT, a false-returning
 * token, WETH9) and a Uniswap mock that pays ETH.
 */
import { ethers, artifacts } from "hardhat";

import { currentTime } from "../utils/time";
import { genMessage } from "../../scripts/utils/genMsg";
import { deployProxy } from "../utils/proxy";
import { wireRouters } from "./wiring";

export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const DAY = 86400;

export const PERMIT_BATCH_TYPES = {
  PermitBatch: [
    { name: "details", type: "PermitDetails[]" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
};

export const EMPTY_BUNDLE = {
  permitBatch: { details: [], spender: ethers.constants.AddressZero, sigDeadline: 0 },
  signature: "0x",
};

export const ZERO_DIST = { user: ethers.constants.AddressZero, percent: 0 };

export function revertedWith(err: any, signature: string): boolean {
  const selector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(signature)).slice(0, 10).toLowerCase();
  const blob = (
    (err?.message ?? "") +
    " " +
    JSON.stringify(err ?? "") +
    " " +
    (err?.data ?? "") +
    " " +
    (err?.error?.message ?? "")
  ).toLowerCase();
  return blob.includes(signature.toLowerCase()) || blob.includes(selector);
}

export async function expectRevert(p: Promise<any>, signature: string): Promise<void> {
  let caught: any;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  if (!caught) throw new Error(`expected revert ${signature}, call succeeded`);
  if (!revertedWith(caught, signature)) throw new Error(`expected ${signature}, got: ${caught?.message}`);
}

export interface TrainOptions {
  /** Claim fee in basis points set on Payment before creates (default 25). */
  feeBps?: number;
  /** Clone implementation contract name (default the wave A clone). */
  implName?: string;
  /** Extra constructor args for the clone implementation. */
  implArgs?: (ctx: { nftAllowlist?: string }) => any[];
  /** Deploy an NftCollectionWhiteList and pass it to implArgs. */
  withNftAllowlist?: boolean;
}

export async function deployTrain(opts: TrainOptions = {}) {
  const [treasury, dev, timelock, safe, owner, bene, bene2, attacker, attestor, other, bene3] = await ethers.getSigners();

  const mockArtifact = await artifacts.readArtifact("MockPermit2");
  await ethers.provider.send("hardhat_setCode", [PERMIT2_ADDRESS, mockArtifact.deployedBytecode]);
  const permit2 = await ethers.getContractAt("MockPermit2", PERMIT2_ADDRESS);

  const ERC20 = await ethers.getContractFactory("ERC20Token");
  const usdc = await ERC20.deploy("USDC", "USDC", 6);
  const usdtStd = await ERC20.deploy("USDT", "USDT", 6);
  const usdt = await (await ethers.getContractFactory("MockNoReturnERC20")).deploy("Tether USD", "USDT", 6);
  const falseToken = await (await ethers.getContractFactory("MockFalseReturnERC20")).deploy();
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();

  const uni = await (await ethers.getContractFactory("MockUniswapV2Router")).deploy(weth.address);
  await treasury.sendTransaction({ to: uni.address, value: ethers.utils.parseEther("100") });

  const Payment = await ethers.getContractFactory("Payment");
  const payment = await Payment.deploy();
  await payment.grantRole(await payment.OPERATOR(), treasury.address);
  const feeBps = opts.feeBps ?? 25;
  if (feeBps > 0) await payment.connect(treasury).setClaimFee(feeBps, true);

  const premiumSetting = await deployProxy("PremiumSetting", [], "initialize", dev);
  const premiumRegistry = await deployProxy(
    "PremiumRegistry",
    [
      usdtStd.address,
      usdc.address,
      "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
      "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
      "0x694AA1769357215DE4FAC081bf1f309aDC325306",
      premiumSetting.address,
      payment.address,
    ],
    "initialize",
    dev
  );
  const verifierTerm = await deployProxy("EIP712LegacyVerifier", [dev.address]);
  const legacyDeployer = await deployProxy("LegacyDeployer");

  const router = await deployProxy(
    "TransferEOALegacyRouter",
    [legacyDeployer.address, premiumSetting.address, verifierTerm.address, payment.address, uni.address, weth.address],
    "initialize",
    undefined,
    [timelock.address]
  );
  await router.connect(timelock).initializeV4(dev.address, ethers.constants.AddressZero);

  const multisigLegacyRouter = await deployProxy("MultisigLegacyRouter", [
    legacyDeployer.address,
    premiumSetting.address,
    verifierTerm.address,
  ]);

  await wireRouters({
    admin: dev,
    legacyDeployerAdmin: treasury,
    premiumSetting,
    premiumRegistry,
    legacyDeployer,
    verifierTerm,
    transferEOALegacyRouter: router,
    multisigLegacyRouter,
  });

  let nftAllowlist: any;
  if (opts.withNftAllowlist) {
    nftAllowlist = await (await ethers.getContractFactory("NftCollectionWhiteList")).deploy(dev.address);
  }
  const implName = opts.implName ?? "TransferEOALegacy";
  const Impl = await ethers.getContractFactory(implName);
  const impl = await Impl.deploy(...(opts.implArgs ? opts.implArgs({ nftAllowlist: nftAllowlist?.address }) : []));

  const vault = await (await ethers.getContractFactory("LegacyPullVaultV2")).deploy(router.address, timelock.address, impl.address);
  await router.connect(timelock).setLegacyImplementation(impl.address);
  await router.connect(timelock).setPullVault(vault.address);
  await router.connect(timelock).setActivityAttestor(attestor.address);

  // Premium for the owner (layers, auto-renew, v3 options are premium-gated).
  await ethers.provider.send("hardhat_impersonateAccount", [premiumRegistry.address]);
  await ethers.provider.send("hardhat_setBalance", [premiumRegistry.address, "0x1000000000000000000"]);
  const registrySigner = await ethers.getSigner(premiumRegistry.address);
  await premiumSetting.connect(registrySigner).updatePremiumTime(owner.address, 100 * 365 * DAY);

  await usdc.mint(owner.address, 1_000_000_000);
  await usdt.mint(owner.address, 1_000_000_000);
  await falseToken.mint(owner.address, ethers.utils.parseEther("1000"));

  const network = await ethers.provider.getNetwork();
  const permit2Domain = { name: "Permit2", chainId: network.chainId, verifyingContract: PERMIT2_ADDRESS };

  return {
    treasury, dev, timelock, safe, owner, bene, bene2, bene3, attacker, attestor, other,
    router, impl, vault, permit2, permit2Domain, payment, premiumSetting, premiumRegistry, verifierTerm,
    legacyDeployer, usdc, usdt, falseToken, weth, uni, nftAllowlist, implName, feeBps,
  };
}

export async function signPermitBatch(signer: any, domain: any, tokens: string[], spender: string, opts: any = {}) {
  const now = await currentTime();
  const details = tokens.map((t) => ({
    token: t,
    amount: opts.amount ?? ethers.BigNumber.from(2).pow(160).sub(1),
    expiration: opts.expiration ?? now + 10 * 365 * DAY,
    nonce: opts.nonce ?? 0,
  }));
  const permitBatch = { details, spender, sigDeadline: opts.sigDeadline ?? now + 1800 };
  const signature = await signer._signTypedData(domain, PERMIT_BATCH_TYPES, permitBatch);
  return { permitBatch, signature };
}

export interface CreateOptions {
  bundle?: any;
  trigger?: number;
  layer2?: any;
  layer3?: any;
  delayLayer2?: number;
  delayLayer3?: number;
  maxFeeBps?: number;
  contractName?: string;
}

export async function createLegacyV2(router: any, ownerSigner: any, distributions: any[], o: CreateOptions = {}) {
  const extraConfig = {
    lackOfOutgoingTxRange: o.trigger ?? DAY,
    delayLayer2: o.delayLayer2 ?? 0,
    delayLayer3: o.delayLayer3 ?? 0,
  };
  const predicted: string = await router.getNextLegacyAddress(ownerSigner.address);
  const ts = await currentTime();
  const sig = await ownerSigner.signMessage(await genMessage(ts));
  const args = [distributions, extraConfig, o.layer2 ?? ZERO_DIST, o.layer3 ?? ZERO_DIST, o.bundle ?? EMPTY_BUNDLE, ts, sig] as const;
  const tx =
    o.maxFeeBps === undefined
      ? await router.connect(ownerSigner).createLegacyV2(...args)
      : await router.connect(ownerSigner).createLegacyV2WithMaxFee(...args, o.maxFeeBps);
  await tx.wait();
  const legacy = await ethers.getContractAt(o.contractName ?? "TransferEOALegacy", predicted);
  const legacyId = (await legacy.getLegacyInfo())[0];
  return { legacy, legacyId, predicted, tx };
}

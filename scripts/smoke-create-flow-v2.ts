/**
 * Create-flow v2 Sepolia smoke test — exercises the two new paths end-to-end
 * against the REAL canonical Permit2 (no mocks):
 *
 *   Leg A: EOA createLegacyV2 with a signed Permit2 AllowanceTransfer batch
 *          (spender = the CREATE2-predicted clone). Verifies the V2 event and
 *          the registered Permit2 allowance.
 *   Leg B: createTimelockedGiftWithPermit2 to a fresh ETH-less wallet, then a
 *          gas-sponsored withdrawFor relayed by the deployer. Verifies the
 *          recipient received the tokens without ever holding ETH.
 *
 *   npx hardhat run scripts/smoke-create-flow-v2.ts --network sepolia
 */
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts, saveContract } from "./utils";
import { genMessage } from "./utils/genMsg";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MAX_UINT160 = ethers.BigNumber.from(2).pow(160).sub(1);

const PERMIT_BATCH_TYPES = {
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

const WITHDRAW_AUTH_TYPES = {
  WithdrawAuth: [
    { name: "recipient", type: "address" },
    { name: "timelockId", type: "uint256" },
    { name: "skipSwap", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const PERMIT2_ABI = [
  "function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];

async function main() {
  const network = hre.network.name;
  const [deployer] = await ethers.getSigners();
  const chainId = hre.network.config.chainId!;
  const contracts = getContracts()[network];
  console.log(`Network: ${network} | Deployer/relayer: ${deployer.address}`);

  // The historical Sepolia test USDT/USDC are owner-minted by old team keys
  // the deployer doesn't hold, so the rehearsal uses its own public-mint token
  // (LegacyToken.mint is unrestricted). Deployed once, recorded in the
  // manifest as ERC20Token_R2USD, and whitelisted so it also shows up in the
  // frontend asset list for the manual QA pass.
  let usdt: any;
  if (contracts["ERC20Token_R2USD"]) {
    usdt = await ethers.getContractAt("LegacyToken", contracts["ERC20Token_R2USD"].address);
    console.log(`Reusing rehearsal token: ${usdt.address}`);
  } else {
    console.log("Deploying rehearsal token (LegacyToken, public mint)…");
    const Token = await ethers.getContractFactory("LegacyToken");
    usdt = await Token.deploy("Rehearsal USD", "R2USD");
    await usdt.deployed();
    console.log(`R2USD deployed: ${usdt.address}`);
    saveContract(network, "ERC20Token_R2USD", usdt.address);

    // Whitelist so the UI's asset list picks it up (best-effort; the plain
    // ERC-20 lock/legacy paths don't require it on-chain).
    try {
      const wl = await ethers.getContractAt("TokenWhiteList", contracts["TokenWhiteList"].address);
      await (await wl.addToken(usdt.address)).wait();
      console.log("R2USD whitelisted.");
    } catch (e: any) {
      console.warn(`Whitelist add failed (non-fatal): ${(e.message ?? "").slice(0, 100)}`);
    }
  }
  const decimals = await usdt.decimals();
  const unit = ethers.BigNumber.from(10).pow(decimals);
  const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, ethers.provider);

  let bal = await usdt.balanceOf(deployer.address);
  if (bal.lt(unit.mul(10))) {
    console.log("Minting 100 R2USD to deployer…");
    await (await usdt.mint(deployer.address, unit.mul(100))).wait();
    bal = await usdt.balanceOf(deployer.address);
  }
  console.log(`Deployer R2USD balance: ${ethers.utils.formatUnits(bal, decimals)}`);

  // One-time base approval to Permit2.
  const baseAllowance = await usdt.allowance(deployer.address, PERMIT2);
  if (baseAllowance.lt(ethers.constants.MaxUint256.div(2))) {
    console.log("approve(Permit2, max)…");
    await (await usdt.approve(PERMIT2, ethers.constants.MaxUint256)).wait();
  } else {
    console.log("Permit2 base approval already in place.");
  }

  const now = Math.floor(Date.now() / 1000);
  const beneficiary = ethers.Wallet.createRandom();
  const recipient = ethers.Wallet.createRandom();
  console.log(`Fresh beneficiary (leg A): ${beneficiary.address}`);
  console.log(`Fresh gift recipient (leg B, never funded): ${recipient.address}`);

  // ───────────────────────── Leg A: EOA createLegacyV2 ─────────────────────────
  console.log("\n=== Leg A: createLegacyV2 + Permit2 batch ===");
  const eoaRouter = await ethers.getContractAt("TransferEOALegacyRouter", contracts["TransferEOALegacyRouter"].address);
  const predicted: string = await eoaRouter.getNextLegacyAddress(deployer.address);
  console.log(`Predicted clone: ${predicted}`);

  const [, , nonceA] = await permit2.allowance(deployer.address, usdt.address, predicted);
  const permit2Domain = { name: "Permit2", chainId, verifyingContract: PERMIT2 };
  const permitBatch = {
    details: [{ token: usdt.address, amount: MAX_UINT160, expiration: now + 100 * 365 * 86400, nonce: nonceA }],
    spender: predicted,
    sigDeadline: now + 1800,
  };
  const batchSig = await deployer._signTypedData(permit2Domain, PERMIT_BATCH_TYPES, permitBatch);

  const ts = now;
  const tosSig = await deployer.signMessage(await genMessage(ts));

  const distributions = [{ user: beneficiary.address, percent: 1_000_000 }]; // 100%
  const extraConfig = { lackOfOutgoingTxRange: 30 * 86400, delayLayer2: 0, delayLayer3: 0 };
  const zero = { user: ethers.constants.AddressZero, percent: 0 };

  const txA = await eoaRouter.createLegacyV2(
    distributions, extraConfig, zero, zero,
    { permitBatch, signature: batchSig },
    ts, tosSig
  );
  console.log(`createLegacyV2 tx: ${txA.hash}`);
  const rcA = await txA.wait();

  const v2Topic = eoaRouter.interface.getEventTopic("TransferEOALegacyCreatedV2");
  const v2Log = rcA.logs.find((l: any) => l.topics[0] === v2Topic);
  if (!v2Log) throw new Error("TransferEOALegacyCreatedV2 not emitted!");
  const parsed = eoaRouter.interface.parseLog(v2Log);
  console.log(`V2 event: legacyId=${parsed.args.legacyId} legacyAddress=${parsed.args.legacyAddress}`);
  if (parsed.args.legacyAddress.toLowerCase() !== predicted.toLowerCase()) {
    throw new Error("Predicted clone address mismatch!");
  }

  const [amt, exp] = await permit2.allowance(deployer.address, usdt.address, predicted);
  console.log(`Permit2 allowance(owner, USDT, clone): amount=${amt.eq(MAX_UINT160) ? "MAX" : amt.toString()} expiration=${exp}`);
  if (!amt.eq(MAX_UINT160)) throw new Error("Permit2 allowance not registered!");
  console.log(`Gas used (create + batch registration, no approve txs): ${rcA.gasUsed.toString()}`);

  // ─────────────── Leg B: gift timelock + gas-sponsored withdrawFor ───────────────
  console.log("\n=== Leg B: createTimelockedGiftWithPermit2 + sponsored withdrawFor ===");
  const tlRouter = await ethers.getContractAt("TimeLockRouter", contracts["TimeLockRouter"].address);

  const [, , nonceB] = await permit2.allowance(deployer.address, usdt.address, tlRouter.address);
  const giftBatch = {
    details: [{ token: usdt.address, amount: MAX_UINT160, expiration: now + 86400, nonce: nonceB }],
    spender: tlRouter.address,
    sigDeadline: now + 1800,
  };
  const giftSig = await deployer._signTypedData(permit2Domain, PERMIT_BATCH_TYPES, giftBatch);

  const giftAmount = unit.mul(5);
  const NO_SWAP = { storageToken: ethers.constants.AddressZero, amountOutMin: 0, deadline: 0 };
  const txB = await tlRouter.createTimelockedGiftWithPermit2(
    {
      timelockETHSwap: NO_SWAP,
      timelockERC20: [{ tokenAddress: usdt.address, amount: giftAmount }],
      timelockERC721: [],
      timelockERC1155: [],
      duration: 60,
      recipient: recipient.address,
      name: "rehearsal gift",
      giftName: "for the rehearsal",
    },
    { permitBatch: giftBatch, signature: giftSig }
  );
  console.log(`createTimelockedGiftWithPermit2 tx: ${txB.hash}`);
  await txB.wait();
  const timelockId = await tlRouter.timelockCounter();
  console.log(`Gift timelock id: ${timelockId.toString()} (unlocks in 60s)`);

  console.log("Waiting 75s for the lock to mature…");
  await new Promise((r) => setTimeout(r, 75_000));

  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const sponsorNonce = await tlRouter.sponsorNonce(recipient.address);
  const tlDomain = {
    name: "10102 Timelock Sponsored",
    version: "1",
    chainId,
    verifyingContract: tlRouter.address,
  };
  const authSig = await recipient._signTypedData(tlDomain, WITHDRAW_AUTH_TYPES, {
    recipient: recipient.address,
    timelockId,
    skipSwap: true,
    nonce: sponsorNonce,
    deadline,
  });

  const txC = await tlRouter.withdrawFor(timelockId, true, {
    recipient: recipient.address,
    nonce: sponsorNonce,
    deadline,
    signature: authSig,
  });
  console.log(`withdrawFor tx (relayer pays gas): ${txC.hash}`);
  const rcC = await txC.wait();

  const recipientBal = await usdt.balanceOf(recipient.address);
  const recipientEth = await ethers.provider.getBalance(recipient.address);
  console.log(`Recipient USDT: ${ethers.utils.formatUnits(recipientBal, decimals)} | Recipient ETH: ${ethers.utils.formatEther(recipientEth)}`);
  if (!recipientBal.eq(giftAmount)) throw new Error("Gift not delivered!");
  if (!recipientEth.isZero()) throw new Error("Recipient unexpectedly holds ETH?");

  const wdTopic = tlRouter.interface.getEventTopic("TimelockWithdrawnFor");
  if (!rcC.logs.some((l: any) => l.topics[0] === wdTopic)) throw new Error("TimelockWithdrawnFor not emitted!");

  console.log("\n=== SMOKE TEST PASSED ===");
  console.log(`Leg A legacy (clone): ${predicted}`);
  console.log(`Leg B gift delivered gaslessly to ${recipient.address}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

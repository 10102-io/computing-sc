/**
 * Live rehearsal of the destination-wallet sponsored claim (round-2026-09.md
 * B1) against the deployed TimeLockRouter on the current network.
 *
 *   npx hardhat run scripts/smoke-payto.ts --network sepolia
 *   $env:PAYTO_ETH="1"; npx hardhat run scripts/smoke-payto.ts --network mainnet   # 0.001 ETH gift
 *
 * Seals a small gift (the public-mint R2USD token where it exists, else an
 * ETH gift stored as WETH: PAYTO_ETH=1, amount PAYTO_ETH_WEI, default 0.001
 * ETH) to a fresh, never-funded recipient key, waits for it to mature, then
 * relays `withdrawFor` with `payTo` set to a second fresh address. Asserts:
 * the destination holds the asset (ETH gifts are unwrapped), the recipient
 * holds none, `TimelockWithdrawnTo` and the vault's `FundsRedirected` fire,
 * and the router advertises EIP-712 domain version "2". Also proves a
 * signature over the version-1 struct is rejected by the live router.
 */
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

const WITHDRAW_AUTH_TYPES = {
  WithdrawAuth: [
    { name: "recipient", type: "address" },
    { name: "payTo", type: "address" },
    { name: "timelockId", type: "uint256" },
    { name: "skipSwap", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
const LEGACY_TYPES = {
  WithdrawAuth: [
    { name: "recipient", type: "address" },
    { name: "timelockId", type: "uint256" },
    { name: "skipSwap", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

async function main() {
  const network = hre.network.name;
  const [deployer] = await ethers.getSigners();
  const contracts = getContracts()[network];
  const router = await ethers.getContractAt("TimeLockRouter", contracts["TimeLockRouter"].address);
  const vault = await ethers.getContractAt("TimelockERC20", contracts["TimelockERC20"].address);
  console.log(`Network ${network} | deployer/relayer ${deployer.address} | router ${router.address}`);

  const d = await router.eip712Domain();
  console.log(`eip712Domain: name="${d.name}" version="${d.version}" chainId=${d.chainId} verifyingContract=${d.verifyingContract}`);
  if (d.version !== "2") throw new Error(`Router advertises version ${d.version}; the payTo upgrade is not live here.`);
  const domain = { name: d.name, version: d.version, chainId: d.chainId.toNumber(), verifyingContract: router.address };

  // Asset: the public-mint rehearsal token where it exists (Sepolia), else
  // a small ETH gift stored as WETH (mainnet: PAYTO_ETH_WEI, default 0.001
  // ETH), claimed with the unwrap so the destination receives ETH.
  const tokenAddr = contracts["ERC20Token_R2USD"]?.address;
  const useEth = !tokenAddr || process.env.PAYTO_ETH === "1";
  let token: any = null;
  let amount = ethers.BigNumber.from(process.env.PAYTO_ETH_WEI ?? ethers.utils.parseEther("0.001").toString());
  let decimals = 18;
  if (!useEth) {
    token = await ethers.getContractAt("LegacyToken", tokenAddr);
    decimals = await token.decimals();
    const unit = ethers.BigNumber.from(10).pow(decimals);
    amount = unit.mul(3);
    if ((await token.balanceOf(deployer.address)).lt(amount)) {
      console.log("Minting R2USD…");
      await (await token.mint(deployer.address, unit.mul(100))).wait();
    }
    if ((await token.allowance(deployer.address, router.address)).lt(amount)) {
      console.log("approve(router)…");
      await (await token.approve(router.address, ethers.constants.MaxUint256)).wait();
    }
  }

  const recipient = ethers.Wallet.createRandom().connect(ethers.provider);
  const destination = ethers.Wallet.createRandom();
  console.log(`Fresh recipient (never funded): ${recipient.address}`);
  console.log(`Fresh destination:              ${destination.address}`);

  const NO_SWAP = { storageToken: ethers.constants.AddressZero, amountOutMin: 0, deadline: 0 };
  let tx;
  if (useEth) {
    const uni = await ethers.getContractAt(["function WETH() view returns (address)"], await router.uniswapRouter());
    const weth: string = await uni.WETH();
    console.log(`ETH gift of ${ethers.utils.formatEther(amount)} ETH stored as WETH ${weth}`);
    tx = await router.createTimelockedGift(
      {
        timelockETHSwap: { storageToken: weth, amountOutMin: 0, deadline: Math.floor(Date.now() / 1000) + 3600 },
        timelockERC20: [],
        timelockERC721: [],
        timelockERC1155: [],
        duration: 60,
        recipient: recipient.address,
        name: "payTo rehearsal",
        giftName: "to your own wallet",
      },
      { value: amount }
    );
  } else {
    tx = await router.createTimelockedGift({
      timelockETHSwap: NO_SWAP,
      timelockERC20: [{ tokenAddress: token.address, amount }],
      timelockERC721: [],
      timelockERC1155: [],
      duration: 60,
      recipient: recipient.address,
      name: "payTo rehearsal",
      giftName: "to your own wallet",
    });
  }
  console.log(`createTimelockedGift tx ${tx.hash}`);
  await tx.wait();
  const id = await router.timelockCounter();
  console.log(`Gift id ${id.toString()}; waiting 75s for maturity…`);
  await new Promise((r) => setTimeout(r, 75_000));

  const nonce = await router.sponsorNonce(recipient.address);
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  // 1. A version-1 style signature must fail loudly on the live router.
  const legacySig = await recipient._signTypedData({ ...domain, version: "1" }, LEGACY_TYPES, {
    recipient: recipient.address, timelockId: id, skipSwap: true, nonce, deadline,
  });
  try {
    await router.callStatic.withdrawFor(id, true, { recipient: recipient.address, payTo: ethers.constants.AddressZero, nonce, deadline, signature: legacySig });
    throw new Error("version-1 signature was accepted; abort");
  } catch (e: any) {
    if (!/InvalidSponsorSignature/.test(e.message ?? "") && !/0x[0-9a-f]{8}/.test(e.message ?? "")) throw e;
    console.log("version-1 signature rejected, as expected");
  }

  // 2. The real claim: recipient signs once, funds land at the destination.
  // ETH gifts are claimed with the unwrap (skipSwap=false) so the
  // destination receives ETH, not WETH.
  const skipSwap = !useEth;
  const value = { recipient: recipient.address, payTo: destination.address, timelockId: id, skipSwap, nonce, deadline };
  const signature = await recipient._signTypedData(domain, WITHDRAW_AUTH_TYPES, value);
  const claim = await router.withdrawFor(id, skipSwap, { recipient: recipient.address, payTo: destination.address, nonce, deadline, signature });
  console.log(`withdrawFor tx ${claim.hash}`);
  const rc = await claim.wait();

  const balanceOf = (addr: string) => (useEth ? ethers.provider.getBalance(addr) : token.balanceOf(addr));
  const [destBal, recBal] = await Promise.all([balanceOf(destination.address), balanceOf(recipient.address)]);
  console.log(`destination ${ethers.utils.formatUnits(destBal, decimals)} | recipient ${ethers.utils.formatUnits(recBal, decimals)} (${useEth ? "ETH" : "R2USD"})`);
  if (!destBal.eq(amount)) throw new Error("destination did not receive the gift");
  if (!recBal.isZero()) throw new Error("recipient unexpectedly holds the asset");

  const toTopic = router.interface.getEventTopic("TimelockWithdrawnTo");
  const toLog = rc.logs.find((l: any) => l.topics[0] === toTopic);
  if (!toLog) throw new Error("TimelockWithdrawnTo not emitted");
  const parsed = router.interface.parseLog(toLog);
  if (parsed.args.payTo.toLowerCase() !== destination.address.toLowerCase()) throw new Error("TimelockWithdrawnTo.payTo mismatch");
  const redirectTopic = vault.interface.getEventTopic("FundsRedirected");
  if (!rc.logs.some((l: any) => l.address.toLowerCase() === vault.address.toLowerCase() && l.topics[0] === redirectTopic)) {
    throw new Error("vault FundsRedirected not emitted");
  }
  if ((await ethers.provider.getBalance(recipient.address)).gt(0)) throw new Error("recipient unexpectedly holds ETH");

  console.log("\n=== PAYTO SMOKE PASSED ===");
  console.log(`gift ${id.toString()} claimed by ${recipient.address}, paid to ${destination.address}, gas by ${deployer.address}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

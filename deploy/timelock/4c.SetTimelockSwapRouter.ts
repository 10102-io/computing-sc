import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getExternalAddresses } from "../../scripts/utils";
import { AddressZero } from "@ethersproject/constants";

/**
 * Sets the real Uniswap V2 router on TimeLockRouter and TimelockERC20, configures setTimelock,
 * and adds external USDC/USDT to TokenWhiteList. Runs on Sepolia and mainnet (any network with
 * uniswapRouter configured in external-addresses). Skipped on localhost/hardhat (use 4b.SetMockSwapRouter).
 *
 * IDEMPOTENT + SELF-HEALING:
 *  - Each setter is a no-op when chain state already matches the target.
 *  - When TimeLockRouter.tokenWhitelist is being rotated to a NEW contract,
 *    this script enumerates the OLD whitelist via TokenAdded/TokenRemoved
 *    event logs and re-adds every still-active token onto the NEW contract
 *    before swapping the pointer. This prevents the silent regression we
 *    hit on mainnet during the 2026-05-18 rollout (WETH + stETH lost when
 *    a metadata-drift redeploy of the non-proxy TokenWhiteList rotated
 *    the router onto an empty whitelist).
 *  - The non-proxy TokenWhiteList deploy script now has
 *    `skipIfAlreadyDeployed: true`, so this rotation path should never
 *    fire again unintentionally — but defense in depth.
 */

/**
 * Enumerate the set of currently-whitelisted tokens on a TokenWhiteList
 * contract by scanning its TokenAdded / TokenRemoved event history.
 * Returns the net set (added but not subsequently removed).
 */
async function enumerateActiveTokens(
  hre: HardhatRuntimeEnvironment,
  whitelistAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<string[]> {
  const { ethers } = hre;
  const addedTopic = ethers.utils.id("TokenAdded(address)");
  const removedTopic = ethers.utils.id("TokenRemoved(address)");
  const net = new Map<string, boolean>();
  const chunkSize = 50_000;
  for (let from = fromBlock; from <= toBlock; from += chunkSize) {
    const to = Math.min(toBlock, from + chunkSize - 1);
    const logs = await ethers.provider.getLogs({
      address: whitelistAddress,
      fromBlock: from,
      toBlock: to,
      topics: [[addedTopic, removedTopic]],
    });
    for (const l of logs) {
      const token = ethers.utils.getAddress("0x" + l.data.slice(-40));
      net.set(token.toLowerCase(), l.topics[0] === addedTopic);
    }
  }
  return [...net.entries()].filter(([, active]) => active).map(([t]) => t);
}

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, network, ethers } = hre;

  const externalAddrs = getExternalAddresses(network.name);
  const { uniswapRouter, usdc, usdt } = externalAddrs;
  if (!uniswapRouter || uniswapRouter === AddressZero) {
    throw new Error("uniswapRouter not configured in external-addresses.ts for this network");
  }

  const timeLockRouterDeploy = await deployments.get("TimeLockRouter");
  if (!timeLockRouterDeploy?.address) {
    throw new Error("TimeLockRouter not found. Deploy TimeLockRouter first.");
  }

  const tokenWhiteListDeploy = await deployments.get("TokenWhiteList");
  if (!tokenWhiteListDeploy?.address) {
    throw new Error("TokenWhiteList not found. Deploy TokenWhiteList first.");
  }

  const timelockERC20Deploy = await deployments.get("TimelockERC20");
  const timelockERC721Deploy = await deployments.get("TimelockERC721");
  const timelockERC1155Deploy = await deployments.get("TimelockERC1155");
  if (!timelockERC20Deploy?.address) {
    throw new Error("TimelockERC20 not found. Deploy TimelockERC20 first.");
  }

  const timeLockRouter = await ethers.getContractAt(
    "TimeLockRouter",
    timeLockRouterDeploy.address
  );

  // ── setTimelock(ERC20, ERC721, ERC1155) — only if a wired address drifts ──
  let needTimelockSet = true;
  try {
    const [curERC20, curERC721, curERC1155] = await Promise.all([
      timeLockRouter.timelockERC20Contract(),
      timeLockRouter.timelockERC721Contract(),
      timeLockRouter.timelockERC1155Contract(),
    ]);
    needTimelockSet =
      curERC20.toLowerCase() !== timelockERC20Deploy.address.toLowerCase() ||
      curERC721.toLowerCase() !== timelockERC721Deploy.address.toLowerCase() ||
      curERC1155.toLowerCase() !== timelockERC1155Deploy.address.toLowerCase();
  } catch {
    // getters may not exist on older impls; fall back to always-set
  }
  if (needTimelockSet) {
    const txSetTimelock = await timeLockRouter.setTimelock(
      timelockERC20Deploy.address,
      timelockERC721Deploy.address,
      timelockERC1155Deploy.address
    );
    await txSetTimelock.wait();
    console.log("TimeLockRouter.setTimelock(ERC20, ERC721, ERC1155) configured");
  } else {
    console.log("TimeLockRouter.setTimelock already up-to-date — skipped");
  }

  // ── setTokenWhitelist — with self-healing token migration ──
  let currentWhitelist: string = AddressZero;
  try {
    currentWhitelist = await timeLockRouter.tokenWhitelist();
  } catch {
    // older impls / proxy not initialized — treat as zero
  }
  const target = tokenWhiteListDeploy.address;
  const isRotation =
    currentWhitelist !== AddressZero &&
    currentWhitelist.toLowerCase() !== target.toLowerCase();

  if (isRotation) {
    console.log(`!! TokenWhiteList rotation detected on TimeLockRouter:`);
    console.log(`   current: ${currentWhitelist}`);
    console.log(`   target:  ${target}`);
    console.log(`   Enumerating active tokens on the OLD whitelist…`);
    const latest = await ethers.provider.getBlockNumber();
    // 5M blocks ~= 2 years on mainnet (12s); plenty of headroom and bounded.
    const oldTokens = await enumerateActiveTokens(
      hre,
      currentWhitelist,
      Math.max(0, latest - 5_000_000),
      latest
    );
    console.log(`   Found ${oldTokens.length} active token(s) on old whitelist`);
    if (oldTokens.length > 0) {
      const newWl = await ethers.getContractAt("TokenWhiteList", target);
      for (const t of oldTokens) {
        if (!(await newWl.isWhitelisted(t))) {
          const tx = await newWl.addToken(t);
          await tx.wait();
          console.log(`     migrated ${t}`);
        } else {
          console.log(`     ${t} already present on new whitelist — skipped`);
        }
      }
    }
  }

  if (currentWhitelist.toLowerCase() !== target.toLowerCase()) {
    const txWhitelist = await timeLockRouter.setTokenWhitelist(target);
    await txWhitelist.wait();
    console.log(`TimeLockRouter.setTokenWhitelist set to: ${target}`);
  } else {
    console.log(`TimeLockRouter.setTokenWhitelist already ${target} — skipped`);
  }

  // ── setUniswapRouter on TimeLockRouter (no-op if already set) ──
  let curUniswap: string = AddressZero;
  try { curUniswap = await timeLockRouter.uniswapRouter(); } catch {}
  if (curUniswap.toLowerCase() !== uniswapRouter.toLowerCase()) {
    const txRouter = await timeLockRouter.setUniswapRouter(uniswapRouter);
    await txRouter.wait();
    console.log(`TimeLockRouter.setUniswapRouter(UniswapV2) set to: ${uniswapRouter}`);
  } else {
    console.log(`TimeLockRouter.setUniswapRouter already ${uniswapRouter} — skipped`);
  }

  // ── setUniswapRouter on TimelockERC20 ──
  const timelockERC20 = await ethers.getContractAt(
    "TimelockERC20",
    timelockERC20Deploy.address
  );
  let curUniswapERC20: string = AddressZero;
  try { curUniswapERC20 = await timelockERC20.uniswapRouter(); } catch {}
  if (curUniswapERC20.toLowerCase() !== uniswapRouter.toLowerCase()) {
    const txERC20 = await timelockERC20.setUniswapRouter(uniswapRouter);
    await txERC20.wait();
    console.log(`TimelockERC20.setUniswapRouter(UniswapV2) set to: ${uniswapRouter}`);
  } else {
    console.log(`TimelockERC20.setUniswapRouter already ${uniswapRouter} — skipped`);
  }

  // ── seed external USDC / USDT (idempotent) ──
  const whitelist = await ethers.getContractAt("TokenWhiteList", tokenWhiteListDeploy.address);
  if (usdc && usdc !== AddressZero) {
    if (!(await whitelist.isWhitelisted(usdc))) {
      const txUsdc = await whitelist.addToken(usdc);
      await txUsdc.wait();
      console.log("TokenWhiteList: added USDC", usdc);
    }
  }
  if (usdt && usdt !== AddressZero) {
    if (!(await whitelist.isWhitelisted(usdt))) {
      const txUsdt = await whitelist.addToken(usdt);
      await txUsdt.wait();
      console.log("TokenWhiteList: added USDT", usdt);
    }
  }
};

deploy.tags = ["SetTimelockSwapRouter"];
deploy.dependencies = [
  "TimeLockRouter",
  "TimelockERC20",
  "TimelockERC721",
  "TimelockERC1155",
  "TokenWhiteList",
];
deploy.skip = async (hre: HardhatRuntimeEnvironment) => {
  const { network } = hre;
  if (network.name === "localhost" || network.name === "hardhat") return true;
  try {
    const { uniswapRouter } = getExternalAddresses(network.name);
    return !uniswapRouter || uniswapRouter === AddressZero;
  } catch {
    return true;
  }
};

export default deploy;

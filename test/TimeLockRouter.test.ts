import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect, assert } from "chai";
import { deployProxy } from "./utils/proxy";

describe("TimeLockRouter", function () {
  async function deployFixture() {
    const [owner, other] = await ethers.getSigners();

    const router = await deployProxy("TimeLockRouter", [owner.address], "initialize", owner);

    const TokenWhiteListFactory = await ethers.getContractFactory("TokenWhiteList");
    const whitelist = await TokenWhiteListFactory.deploy(owner.address);

    const ERC20Factory = await ethers.getContractFactory("ERC20Token");
    const wethToken = await ERC20Factory.deploy("Wrapped Ether", "WETH", 18);
    const outputToken = await ERC20Factory.deploy("Output Token", "OUT", 18);

    const MockRouterFactory = await ethers.getContractFactory("MockUniswapV2Router");
    const mockRouter = await MockRouterFactory.deploy(wethToken.address);

    return { router, whitelist, wethToken, outputToken, mockRouter, owner, other };
  }

  describe("getEthToTokenAmountOut", function () {
    it("reverts with SwapNotConfigured when uniswap router is not set", async function () {
      const { router, outputToken } = await loadFixture(deployFixture);
      const ethAmountWei = ethers.utils.parseEther("1");

      let reverted = false;
      try {
        await router.getEthToTokenAmountOut(ethAmountWei, outputToken.address);
      } catch (e: unknown) {
        const err = e as { message?: string };
        reverted = err?.message?.includes("SwapNotConfigured") ?? false;
      }
      assert.isTrue(reverted, "getEthToTokenAmountOut should revert with SwapNotConfigured when router not set");
    });

    it("returns expected token amount when router is set", async function () {
      const { router, outputToken, mockRouter, owner } = await loadFixture(deployFixture);
      await router.connect(owner).setUniswapRouter(mockRouter.address);

      const ethAmountWei = ethers.utils.parseEther("1");
      // Mock: 1 ETH -> 2000e18 tokens (multiplier 2000e18)
      await mockRouter.setEthToTokenMultiplier(ethers.utils.parseEther("2000").toString());

      const amountOut = await router.getEthToTokenAmountOut(ethAmountWei, outputToken.address);
      expect(amountOut).to.equal(ethers.utils.parseEther("2000"));
    });

    it("uses path [WETH, outputToken]", async function () {
      const { router, outputToken, mockRouter, owner } = await loadFixture(deployFixture);
      await router.connect(owner).setUniswapRouter(mockRouter.address);
      await mockRouter.setEthToTokenMultiplier(ethers.utils.parseEther("1").toString());

      const amountOut = await router.getEthToTokenAmountOut(ethers.utils.parseEther("2"), outputToken.address);
      expect(amountOut).to.equal(ethers.utils.parseEther("2"));
    });
  });

  describe("getTokenToEthAmountOut", function () {
    it("reverts with SwapNotConfigured when uniswap router is not set", async function () {
      const { router, outputToken } = await loadFixture(deployFixture);
      const tokenAmount = ethers.utils.parseEther("100");

      let reverted = false;
      try {
        await router.getTokenToEthAmountOut(tokenAmount, outputToken.address);
      } catch (e: unknown) {
        const err = e as { message?: string };
        reverted = err?.message?.includes("SwapNotConfigured") ?? false;
      }
      assert.isTrue(reverted, "getTokenToEthAmountOut should revert with SwapNotConfigured when router not set");
    });

    it("returns expected ETH amount in wei when router is set", async function () {
      const { router, outputToken, mockRouter, owner } = await loadFixture(deployFixture);
      await router.connect(owner).setUniswapRouter(mockRouter.address);

      const tokenAmount = ethers.utils.parseEther("1000");
      // Mock: 1000 tokens -> 0.5 ETH => multiplier 5e14 (1000e18 * 5e14 / 1e18 = 5e17 = 0.5e18)
      const multiplier = ethers.BigNumber.from(10).pow(14).mul(5);
      await mockRouter.setTokenToEthMultiplier(multiplier.toString());

      const ethOut = await router.getTokenToEthAmountOut(tokenAmount, outputToken.address);
      expect(ethOut).to.equal(ethers.utils.parseEther("0.5"));
    });

    it("uses path [token, WETH]", async function () {
      const { router, outputToken, mockRouter, owner } = await loadFixture(deployFixture);
      await router.connect(owner).setUniswapRouter(mockRouter.address);
      await mockRouter.setTokenToEthMultiplier(ethers.utils.parseEther("1").toString());

      const tokenAmount = ethers.utils.parseEther("3");
      const ethOut = await router.getTokenToEthAmountOut(tokenAmount, outputToken.address);
      expect(ethOut).to.equal(ethers.utils.parseEther("3"));
    });
  });
});

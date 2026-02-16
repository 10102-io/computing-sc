import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect, assert } from "chai";
import { deployProxy } from "./utils/proxy";

const LOCK_STATUS_LIVE = 2;
const ONE_ETH = ethers.utils.parseEther("1");

describe("TimelockERC20", function () {
  async function deployFixture() {
    const [owner] = await ethers.getSigners();

    const timelock = await deployProxy(
      "TimelockERC20",
      [owner.address, owner.address],
      "initialize",
      owner
    );

    const ERC20Factory = await ethers.getContractFactory("ERC20Token");
    const wethToken = await ERC20Factory.deploy("Wrapped Ether", "WETH", 18);
    const lockToken = await ERC20Factory.deploy("Lock Token", "LOCK", 18);

    const MockRouterFactory = await ethers.getContractFactory("MockUniswapV2Router");
    const mockRouter = await MockRouterFactory.deploy(wethToken.address);

    await timelock.connect(owner).setUniswapRouter(mockRouter.address);

    return { timelock, wethToken, lockToken, mockRouter, owner };
  }

  describe("withdraw token-to-ETH slippage protection", function () {
    it("succeeds when swap output meets minAmountOut (95% of quoted)", async function () {
      const { timelock, lockToken, mockRouter, owner } = await loadFixture(deployFixture);

      const lockAmount = ONE_ETH;
      await lockToken.mint(timelock.address, lockAmount);

      await mockRouter.setTokenToEthMultiplier(ethers.utils.parseEther("1").toString());
      await owner.sendTransaction({ to: mockRouter.address, value: ONE_ETH });

      const id = 1;
      const duration = 86400;
      await timelock
        .connect(owner)
        .createTimelock(
          id,
          [lockToken.address],
          [lockAmount],
          duration,
          "Lock",
          owner.address,
          LOCK_STATUS_LIVE,
          lockToken.address
        );

      await ethers.provider.send("evm_increaseTime", [duration + 1]);
      await ethers.provider.send("evm_mine", []);

      const recipientBefore = await ethers.provider.getBalance(owner.address);
      const tx = await timelock.connect(owner).withdraw(id, owner.address);
      const receipt = await tx.wait();
      const recipientAfter = await ethers.provider.getBalance(owner.address);
      const gasCost = receipt.gasUsed.mul(receipt.effectiveGasPrice);

      expect(recipientAfter.sub(recipientBefore).add(gasCost)).to.equal(ONE_ETH);
    });

    it("reverts when swap would return less than minAmountOut (slippage attack)", async function () {
      const { timelock, lockToken, mockRouter, owner } = await loadFixture(deployFixture);

      const lockAmount = ONE_ETH;
      await lockToken.mint(timelock.address, lockAmount);

      await mockRouter.setTokenToEthMultiplier(ethers.utils.parseEther("1").toString());
      const expectedEthOut = ONE_ETH;
      const minAmountOut = expectedEthOut.mul(95).div(100);
      await owner.sendTransaction({
        to: mockRouter.address,
        value: minAmountOut.sub(ethers.utils.parseEther("0.001")),
      });

      const id = 2;
      const duration = 86400;
      await timelock
        .connect(owner)
        .createTimelock(
          id,
          [lockToken.address],
          [lockAmount],
          duration,
          "Lock",
          owner.address,
          LOCK_STATUS_LIVE,
          lockToken.address
        );

      await ethers.provider.send("evm_increaseTime", [duration + 1]);
      await ethers.provider.send("evm_mine", []);

      let reverted = false;
      let messageIncludesSlippage = false;
      try {
        await timelock.connect(owner).withdraw(id, owner.address);
      } catch (e: unknown) {
        reverted = true;
        const err = e as { message?: string };
        messageIncludesSlippage = (err?.message ?? "").includes("insufficient output");
      }
      assert.isTrue(reverted, "withdraw should revert when swap output < minAmountOut");
      assert.isTrue(messageIncludesSlippage, "revert reason should mention insufficient output");
    });
  });
});

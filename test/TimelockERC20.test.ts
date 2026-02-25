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
          true
        );

      await ethers.provider.send("evm_increaseTime", [duration + 1]);
      await ethers.provider.send("evm_mine", []);

      const recipientBefore = await ethers.provider.getBalance(owner.address);
      const tx = await timelock.connect(owner).withdraw(id, owner.address, false);
      const receipt = await tx.wait();
      const recipientAfter = await ethers.provider.getBalance(owner.address);

      const gasCost = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);

      expect(BigInt(recipientAfter) - BigInt(recipientBefore) + gasCost).to.equal(ONE_ETH);
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
          true
        );

      await ethers.provider.send("evm_increaseTime", [duration + 1]);
      await ethers.provider.send("evm_mine", []);

      let reverted = false;
      let messageIncludesSlippage = false;
      try {
        await timelock.connect(owner).withdraw(id, owner.address, false);
      } catch (e: unknown) {
        reverted = true;
        const err = e as { message?: string };
        messageIncludesSlippage = (err?.message ?? "").includes("insufficient output");
      }
      assert.isTrue(reverted, "withdraw should revert when swap output < minAmountOut");
      assert.isTrue(messageIncludesSlippage, "revert reason should mention insufficient output");
    });

    it("withdraws storage token as token when skipSwap is true", async function () {
      const { timelock, lockToken, owner } = await loadFixture(deployFixture);

      const lockAmount = ONE_ETH;
      await lockToken.mint(timelock.address, lockAmount);

      const id = 3;
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
          true
        );

      await ethers.provider.send("evm_increaseTime", [duration + 1]);
      await ethers.provider.send("evm_mine", []);

      const recipientTokenBefore = await lockToken.balanceOf(owner.address);
      const recipientEthBefore = await ethers.provider.getBalance(owner.address);

      const tx = await timelock.connect(owner).withdraw(id, owner.address, true);
      const receipt = await tx.wait();
      const toBn = (v: bigint | { toString(): string }) =>
        typeof v === "bigint" ? v : BigInt(v.toString());
      const gasCost = toBn(receipt.gasUsed) * toBn(receipt.effectiveGasPrice);

      const recipientTokenAfter = await lockToken.balanceOf(owner.address);
      const recipientEthAfter = await ethers.provider.getBalance(owner.address);

      expect(toBn(recipientTokenAfter) - toBn(recipientTokenBefore)).to.equal(toBn(lockAmount));
      expect(toBn(recipientEthBefore) - toBn(recipientEthAfter)).to.equal(gasCost);
    });

    it("only swaps the last token to ETH when multiple tokens are locked", async function () {
      const { timelock, lockToken, mockRouter, owner } = await loadFixture(deployFixture);

      const ERC20Factory = await ethers.getContractFactory("ERC20Token");
      const otherToken = await ERC20Factory.deploy("Other Token", "OTHER", 18);

      const otherAmount = ONE_ETH.mul(2);
      const lastAmount = ONE_ETH;

      await otherToken.mint(timelock.address, otherAmount);
      await lockToken.mint(timelock.address, lastAmount);

      await mockRouter.setTokenToEthMultiplier(ethers.utils.parseEther("1").toString());
      await owner.sendTransaction({ to: mockRouter.address, value: lastAmount });

      const id = 4;
      const duration = 86400;
      await timelock.connect(owner).createTimelock(
        id,
        [otherToken.address, lockToken.address],
        [otherAmount, lastAmount],
        duration,
        "MultiLock",
        owner.address,
        LOCK_STATUS_LIVE,
        true
      );

      await ethers.provider.send("evm_increaseTime", [duration + 1]);
      await ethers.provider.send("evm_mine", []);

      const toBn = (v: bigint | { toString(): string }) =>
        typeof v === "bigint" ? v : BigInt(v.toString());

      const otherBefore = await otherToken.balanceOf(owner.address);
      const lastBefore = await lockToken.balanceOf(owner.address);
      const ethBefore = await ethers.provider.getBalance(owner.address);

      const tx = await timelock.connect(owner).withdraw(id, owner.address, false);
      const receipt = await tx.wait();
      const gasCost = toBn(receipt.gasUsed) * toBn(receipt.effectiveGasPrice);

      const otherAfter = await otherToken.balanceOf(owner.address);
      const lastAfter = await lockToken.balanceOf(owner.address);
      const ethAfter = await ethers.provider.getBalance(owner.address);

      // Non-last token transferred directly as ERC20
      expect(toBn(otherAfter) - toBn(otherBefore)).to.equal(toBn(otherAmount));
      // Last token was swapped to ETH, not transferred as token
      expect(toBn(lastAfter)).to.equal(toBn(lastBefore));
      // ETH balance increased by the swap proceeds
      expect(toBn(ethAfter) - toBn(ethBefore) + gasCost).to.equal(toBn(lastAmount));
    });

    it("skipSwap=true transfers all tokens directly including the last one when multiple tokens are locked", async function () {
      const { timelock, lockToken, owner } = await loadFixture(deployFixture);

      const ERC20Factory = await ethers.getContractFactory("ERC20Token");
      const otherToken = await ERC20Factory.deploy("Other Token", "OTHER", 18);

      const otherAmount = ONE_ETH.mul(2);
      const lastAmount = ONE_ETH;

      await otherToken.mint(timelock.address, otherAmount);
      await lockToken.mint(timelock.address, lastAmount);

      const id = 5;
      const duration = 86400;
      await timelock.connect(owner).createTimelock(
        id,
        [otherToken.address, lockToken.address],
        [otherAmount, lastAmount],
        duration,
        "MultiLockSkip",
        owner.address,
        LOCK_STATUS_LIVE,
        true
      );

      await ethers.provider.send("evm_increaseTime", [duration + 1]);
      await ethers.provider.send("evm_mine", []);

      const toBn = (v: bigint | { toString(): string }) =>
        typeof v === "bigint" ? v : BigInt(v.toString());

      const otherBefore = await otherToken.balanceOf(owner.address);
      const lastBefore = await lockToken.balanceOf(owner.address);
      const ethBefore = await ethers.provider.getBalance(owner.address);

      const tx = await timelock.connect(owner).withdraw(id, owner.address, true);
      const receipt = await tx.wait();
      const gasCost = toBn(receipt.gasUsed) * toBn(receipt.effectiveGasPrice);

      const otherAfter = await otherToken.balanceOf(owner.address);
      const lastAfter = await lockToken.balanceOf(owner.address);
      const ethAfter = await ethers.provider.getBalance(owner.address);

      // All tokens transferred directly, no swap
      expect(toBn(otherAfter) - toBn(otherBefore)).to.equal(toBn(otherAmount));
      expect(toBn(lastAfter) - toBn(lastBefore)).to.equal(toBn(lastAmount));
      // Only gas deducted, no ETH received from swap
      expect(toBn(ethBefore) - toBn(ethAfter)).to.equal(gasCost);
    });
  });
});

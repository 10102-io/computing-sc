import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { deployProxy } from "./utils/proxy";
import { expectRevert } from "./fixtures/eoaTrain";

// TimeLockRouter, wave A (docs/plans/train-2026-11.md): DEFERRED
// router-create-hardening (empty creates and zero-minimum swaps revert) and
// autopilot-unlock-at (`createTimelockUntil`, an absolute unlock date).

const ZERO = ethers.constants.AddressZero;
const NO_SWAP = { storageToken: ZERO, amountOutMin: 0, deadline: 0 };
const ONE_ETH = ethers.utils.parseEther("1");

describe("Train 2026-11 — TimeLockRouter (wave A)", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [admin, user, recipient] = await ethers.getSigners();
    const router = await deployProxy("TimeLockRouter", [admin.address], "initialize", admin);
    const tlERC20 = await deployProxy("TimelockERC20", [admin.address, router.address], "initialize", admin);
    const tlERC721 = await deployProxy("TimelockERC721", [admin.address, router.address], "initialize", admin);
    const tlERC1155 = await deployProxy("TimelockERC1155", [admin.address, router.address], "initialize", admin);
    await router.connect(admin).setTimelock(tlERC20.address, tlERC721.address, tlERC1155.address);

    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdc = await ERC20.deploy("USDC", "USDC", 6);
    await usdc.mint(user.address, 1_000_000_000);
    await usdc.connect(user).approve(router.address, ethers.constants.MaxUint256);

    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const storage = await ERC20.deploy("Staked", "STK", 18);
    const dex = await (await ethers.getContractFactory("MockUniswapV2Router")).deploy(weth.address);
    await storage.mint(dex.address, ONE_ETH.mul(1000));
    await router.connect(admin).setUniswapRouter(dex.address);
    await tlERC20.connect(admin).setUniswapRouter(dex.address);

    const nft721 = await (await ethers.getContractFactory("MockERC721")).deploy();
    await nft721.mint(user.address, 1);
    await nft721.connect(user).setApprovalForAll(router.address, true);

    return { admin, user, recipient, router, tlERC20, tlERC721, usdc, weth, storage, dex, nft721 };
  }

  const regular = (extra: any = {}) => ({
    timelockETHSwap: NO_SWAP,
    timelockERC20: [],
    timelockERC721: [],
    timelockERC1155: [],
    duration: 86400,
    name: "tl",
    ...extra,
  });

  describe("router-create-hardening", function () {
    it("an empty regular, soft or gift create reverts, with or without ETH attached", async function () {
      const { user, recipient, router } = await loadFixture(deployFixture);
      await expectRevert(router.connect(user).createTimelock(regular()), "EmptyTimelock()");
      await expectRevert(router.connect(user).createTimelock(regular(), { value: ONE_ETH }), "EmptyTimelock()");
      const soft = { timelockETHSwap: NO_SWAP, timelockERC20: [], timelockERC721: [], timelockERC1155: [], bufferTime: 86400, name: "s" };
      await expectRevert(router.connect(user).createSoftTimelock(soft, { value: ONE_ETH }), "EmptyTimelock()");
      const gift = { ...regular(), recipient: recipient.address, giftName: "g" };
      await expectRevert(router.connect(user).createTimelockedGift(gift, { value: ONE_ETH }), "EmptyTimelock()");
      assert.equal((await router.timelockCounter()).toString(), "0", "no id spent");
      assert.equal((await ethers.provider.getBalance(router.address)).toString(), "0", "no ETH stranded");
    });

    it("a non-WETH swap with a zero minimum reverts; a quoted minimum and the WETH wrap both work", async function () {
      const { user, router, storage, weth, tlERC20 } = await loadFixture(deployFixture);
      const now = await currentTime();
      await expectRevert(
        router.connect(user).createTimelock(regular({ timelockETHSwap: { storageToken: storage.address, amountOutMin: 0, deadline: now + 3600 } }), { value: ONE_ETH }),
        "ZeroAmountOutMin()"
      );
      await router.connect(user).createTimelock(regular({ timelockETHSwap: { storageToken: storage.address, amountOutMin: 1, deadline: now + 3600 } }), { value: ONE_ETH });
      await router.connect(user).createTimelock(regular({ timelockETHSwap: { storageToken: weth.address, amountOutMin: 0, deadline: now + 3600 } }), { value: ONE_ETH });
      assert((await storage.balanceOf(tlERC20.address)).gt(0));
      assert.equal((await weth.balanceOf(tlERC20.address)).toString(), ONE_ETH.toString());
    });

    it("unchanged paths: ERC-20 only and ERC-721 only creates still work", async function () {
      const { user, router, usdc, nft721 } = await loadFixture(deployFixture);
      await router.connect(user).createTimelock(regular({ timelockERC20: [{ tokenAddress: usdc.address, amount: 1000 }] }));
      await router.connect(user).createTimelock(regular({ timelockERC721: [{ tokenAddress: nft721.address, id: 0 }] }));
      assert.equal((await router.timelockCounter()).toString(), "2");
    });
  });

  describe("autopilot-unlock-at: createTimelockUntil", function () {
    it("the lock opens at unlockAt exactly, whenever the transaction lands", async function () {
      const { user, router, tlERC20, usdc } = await loadFixture(deployFixture);
      const unlockAt = (await currentTime()) + 30 * 86400;
      await increase(3 * 86400); // a delayed transaction must not shift the date
      await router.connect(user).createTimelockUntil(regular({ duration: 0, timelockERC20: [{ tokenAddress: usdc.address, amount: 1000 }] }), unlockAt);
      const info = await tlERC20.timelocks(1);
      assert.equal(info.unlockTime.toString(), String(unlockAt));

      await ethers.provider.send("evm_setNextBlockTimestamp", [unlockAt - 1]);
      await expectRevert(router.connect(user)["withdraw(uint256)"](1), "StillLocked()");
      await ethers.provider.send("evm_setNextBlockTimestamp", [unlockAt]);
      await router.connect(user)["withdraw(uint256)"](1);
      assert.equal((await usdc.balanceOf(user.address)).toString(), "1000000000");
    });

    it("the date has one source: a nonzero duration, a past date and an empty lock all revert", async function () {
      const { user, router, usdc } = await loadFixture(deployFixture);
      const now = await currentTime();
      const erc20 = [{ tokenAddress: usdc.address, amount: 1000 }];
      await expectRevert(router.connect(user).createTimelockUntil(regular({ duration: 86400, timelockERC20: erc20 }), now + 86400), "DurationWithUnlockAt()");
      await expectRevert(router.connect(user).createTimelockUntil(regular({ duration: 0, timelockERC20: erc20 }), now), "UnlockAtInvalid()");
      await expectRevert(router.connect(user).createTimelockUntil(regular({ duration: 0 }), now + 86400), "EmptyTimelock()");
    });

    it("createTimelock with a relative duration is unchanged", async function () {
      const { user, router, tlERC20, usdc } = await loadFixture(deployFixture);
      await router.connect(user).createTimelock(regular({ timelockERC20: [{ tokenAddress: usdc.address, amount: 1000 }] }));
      const t = (await ethers.provider.getBlock("latest")).timestamp;
      assert.equal((await tlERC20.timelocks(1)).unlockTime.toString(), String(t + 86400));
    });

    it("respects the create pause like every create path", async function () {
      const { admin, user, router, usdc } = await loadFixture(deployFixture);
      await router.connect(admin).setCreatePaused(true);
      const now = await currentTime();
      await expectRevert(
        router.connect(user).createTimelockUntil(regular({ duration: 0, timelockERC20: [{ tokenAddress: usdc.address, amount: 1 }] }), now + 86400),
        "CreationPaused()"
      );
    });
  });
});

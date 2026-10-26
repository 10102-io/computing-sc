import { ethers, network } from "hardhat";
import { BigNumber, ethers as ethersI } from "ethers";
import { assert } from "console";

import { currentTime, increase, increaseTo } from "./utils/time";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";


import { expect, use } from "chai";
import { formatEther, parseEther } from "ethers/lib/utils";
import { seconds } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time/duration";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";



describe("FormatUnits library", async function () {

    async function deployFixture() {
        const FormatUnitsTestWrapper = await ethers.getContractFactory("FormatUnitsTestWrapper");
        const formatUnitsSC = await FormatUnitsTestWrapper.deploy();
        return {formatUnitsSC}
    } 

    it ("should deploy fixture successfully", async function () {
        await deployFixture();
    })
    it("formats with decimals", async function () {
    
    const {formatUnitsSC} = await deployFixture();
      const result = await formatUnitsSC.callFormat(
        parseEther("1.2345"), // 1.2345 ETH
        18
      );
      expect(result).to.eql("1.234500");
    });

  });
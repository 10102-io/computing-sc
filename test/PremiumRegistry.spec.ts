import Web3 from "web3";
import { ethers, network } from "hardhat";
import { ethers as ethersI } from "ethers";
import { assert } from "console";

import { currentTime, increase, increaseTo } from "./utils/time";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";


import { expect, use } from "chai";
import { formatEther, formatUnits, parseEther, parseUnits } from "ethers";
import { seconds } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time/duration";
const web3 = new Web3(process.env.RPC!);
const user_pk = (process.env.PK || process.env.DEPLOYER_PRIVATE_KEY)?.trim();
const privateKey = user_pk?.startsWith('0x') ? user_pk : `0x${user_pk}`;

const user = web3.eth.accounts.privateKeyToAccount(privateKey!).address;
const wallet = web3.eth.accounts.privateKeyToAccount(privateKey!);




async function genMessage(

    legacyAddress: string,
    timestamp: number): Promise<string> {

    const message = `I agree to legacy at address ${legacyAddress.toLowerCase()} at timestamp ${timestamp}`;
    return message;
}

describe("Premium Setting", async function () {
    this.timeout(150000);

    const ONE_YEAR_PRICE = 1000;
    const FIVE_YEARS_PRICE = 2500;
    const LIFETIME_PRICE = 5000;

    const ONE_YEAR = 86400 * 365;
    const FIVE_YEARS = 86400 * 365 * 5;
    const LIFETIME = ethers.MaxUint256;

    function emailMapping(addr: string, email: string, name: string) {
        return { addr, email, name };
    }

    async function deployFixture() {
        const [treasury, user1, user2, user3] = await ethers.getSigners(); // Get the first signer (default account)
        //deploy mock tokens 
        const ERC20 = await ethers.getContractFactory("ERC20Token");
        const usdt = await ERC20.deploy("USDT", "USDT", 6);
        const usdc = await ERC20.deploy("USDC", "USDC", 6);

        const Setting = await ethers.getContractFactory("PremiumSetting");
        const setting = await Setting.deploy();
        await setting.connect(treasury).initialize();

        const Payment = await ethers.getContractFactory("Payment");
        const payment = await Payment.deploy();

        const Registry = await ethers.getContractFactory("PremiumRegistry");
        const registry = await Registry.deploy();
        await registry.connect(treasury).initialize(
            usdt.target,
            usdc.target,
            "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
            "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
            "0x694AA1769357215DE4FAC081bf1f309aDC325306",
            setting.target,
            payment.target

        )

   
 

        //mint token for users
        await usdt.mint(user1.address, 100000 * 10 ** 6); // 100K usdt
        await usdc.mint(user1.address, 100000 * 10 ** 6); // 100K usdc

        await usdt.mint(user2.address, 100000 * 10 ** 6); // 100K usdt
        await usdc.mint(user2.address, 100000 * 10 ** 6); // 100K usdc

        await usdt.mint(user3.address, 100000 * 10 ** 6); // 100K usdt
        await usdc.mint(user3.address, 100000 * 10 ** 6); // 100K usdc

        // Fund the account with ETH before impersonating
        await network.provider.send("hardhat_setBalance", [
            "0x944a402a91c3d6663f5520bfe23c1c1ee77bca92",
            "0x1000000000000000000" // 1 ETH
        ]);

        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: ["0x944a402a91c3d6663f5520bfe23c1c1ee77bca92"],
        });

        const dev = await ethers.getSigner("0x944a402a91c3d6663f5520bfe23c1c1ee77bca92");
        await usdt.mint(dev.address, 100000 * 10 ** 6); // 100K usdt
        await usdc.mint(dev.address, 100000 * 10 ** 6); // 100K usdc

        const VerifierTerm = await ethers.getContractFactory("EIP712LegacyVerifier");
        const verifierTerm = await VerifierTerm.deploy();
        await verifierTerm.initialize(dev.address);

        //legacy
        const MultisignLegacyRouter = await ethers.getContractFactory("MultisigLegacyRouter");
        const multisignLegacyRouter = await MultisignLegacyRouter.deploy();
        await multisignLegacyRouter.initialize(setting.address, verifierTerm.address);    


        //set up
        await setting.setParams(registry.target, treasury.address, treasury.address, multisignLegacyRouter.target);
        await verifierTerm.connect(dev).setRouterAddresses(multisignLegacyRouter.target, multisignLegacyRouter.target, multisignLegacyRouter.target);


        return {
            usdt,
            usdc,
            registry,
            setting,
            treasury,
            user1,
            user2,
            user3,
            dev,
            multisignLegacyRouter,
            payment
        }
    }

    describe("Deployemnt", async function () {
        it("should deploy fixture successfully", async function () {
            const { usdt, usdc, registry, treasury, setting } = await loadFixture(deployFixture);
            expect(await registry.owner()).to.be.eql(treasury.address);
        })
    })

    describe("[Admin] Manage plan", async function () {
        it("should setup plans successfully", async function () {
            const { usdt, usdc, registry, setting, treasury } = await loadFixture(deployFixture);
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]

            )
            expect(await registry.getPlanPriceUSD(0)).to.be.eq(ONE_YEAR_PRICE);
            expect(await registry.getPlanPriceUSD(1)).to.be.eq(FIVE_YEARS_PRICE);
            expect(await registry.getPlanPriceUSD(2)).to.be.eq(LIFETIME_PRICE);
            expect(await registry.getPlanDuration(0)).to.be.eq(ONE_YEAR);
            expect(await registry.getPlanDuration(1)).to.be.eq(FIVE_YEARS);
            expect(await registry.getPlanDuration(2)).to.be.eq(LIFETIME);


        })

        it("should update plan", async function () {
            const { usdt, usdc, registry, setting, treasury } = await loadFixture(deployFixture);
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )
            expect(await registry.getPlanPriceUSD(0)).to.be.eq(ONE_YEAR_PRICE);
            expect(await registry.getPlanDuration(0)).to.be.eq(ONE_YEAR);

            await registry.updatePlans([0], [ONE_YEAR * 2], [ONE_YEAR_PRICE * 2], ["TWO YEAR"], [""], [""]);

            expect(await registry.getPlanPriceUSD(0)).to.be.eq(ONE_YEAR_PRICE * 2);
            expect(await registry.getPlanDuration(0)).to.be.eq(ONE_YEAR * 2);
        })

        it("should update plan price and duration", async function () {
            const { usdt, usdc, registry, setting, treasury } = await loadFixture(deployFixture);
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )
            expect(await registry.getPlanPriceUSD(0)).to.be.eq(ONE_YEAR_PRICE);
            expect(await registry.getPlanDuration(0)).to.be.eq(ONE_YEAR);

            await registry.updatePlansPriceAndDuration([0], [ONE_YEAR * 2], [ONE_YEAR_PRICE * 4]);

            expect(await registry.getPlanPriceUSD(0)).to.be.eq(ONE_YEAR_PRICE * 4);
            expect(await registry.getPlanDuration(0)).to.be.eq(ONE_YEAR * 2);
        })

        it("should remove plan", async function () {
            const { usdt, usdc, registry, setting, treasury } = await loadFixture(deployFixture);
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]

            )
            await registry.removePlans([0]);

            try {
                await registry.getPlanPriceUSD(0)
            } catch (e) {
                expect(e?.toString()).to.contains("Plan has been removed");
            }

            try {
                await registry.getPlanDuration(0)
            } catch (e) {
                expect(e?.toString()).to.contains("Plan has been removed");
            }

            //update after remove should fail
            try {
                await registry.updatePlans([0], [ONE_YEAR * 2], [ONE_YEAR_PRICE * 2], ["TWO YEAR"], [""], [""]);
            } catch (e) {
                expect(e?.toString()).to.contains("Plan has been removed");
            }
        })


    })

    describe("should calculate plan prices with decimals 2",async function () {
        it("should setup plans successfully", async function () {
            const { usdt, usdc, registry, setting, treasury } = await loadFixture(deployFixture);
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [10, 50, 100],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]

            )
            console.log(formatUnits( await registry.getPlanPriceUSDC(0), 6));
            console.log(formatUnits( await registry.getPlanPriceUSDC(1), 6));
            console.log(formatUnits( await registry.getPlanPriceUSDC(2), 6));
            console.log(formatUnits( await registry.getPlanPriceUSDT(0), 6));
            console.log(formatUnits( await registry.getPlanPriceUSDT(1), 6));
            console.log(formatUnits( await registry.getPlanPriceUSDT(2), 6));
            console.log(formatEther( await registry.getPlanPriceETH(0)));
            console.log(formatEther( await registry.getPlanPriceETH(1)));
            console.log(formatEther( await registry.getPlanPriceETH(2)));




        })
    })

    describe("[User] Subcribe plans", async function () {
        it("should user subcribe with USDC", async function () {
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3 } = await loadFixture(deployFixture);

            // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )

            // user subcribe for plan
            await usdc.connect(user1).approve(registry.target, ethers.MaxUint256);
            const planPriceUSDC = await registry.getPlanPriceUSDC(0);
            console.log({ planPriceUSDC });
            await registry.connect(user1).subcribeWithUSDC(0);
            expect(await usdc.balanceOf(user1.address)).to.be.eq((100000n * 10n ** 6n - BigInt(planPriceUSDC)));
            expect(await setting.premiumExpired(user1.address)).to.be.gt(0n);
            // await expect(setting.connect(user1).setEmails()).to.not.reverted;
            // try {
            //     await setting.connect(user2).setEmails(); //non-premium user
            // } catch (e) {
            //     expect(e?.toString()).to.contains("Premium only");
            // }
        })

        it("should user subcribe with ETH", async function () {
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3 } = await loadFixture(deployFixture);
            // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]

            )

            //user subcribe plans

            const planPriceETH = await registry.getPlanPriceETH(0);
            console.log({ planPriceETH });
            const ethBalBefore = await ethers.provider.getBalance(user1.address);
            await registry.connect(user1).subcribeWithETH(0, {
                value: planPriceETH
            });
            const ethBalAfter = await ethers.provider.getBalance(user1.address);
            expect(ethBalBefore - ethBalAfter).to.be.gte(planPriceETH) // gas consumed in tx 
            expect(await setting.premiumExpired(user1.address)).to.be.gt(0n);

            // await expect(setting.connect(user1).setEmails()).to.not.reverted;
            // try {
            //     await setting.connect(user2).setEmails(); //non-premium user
            // } catch (e) {
            //     expect(e?.toString()).to.contains("Premium only");
            // }
        })

        it("should user subcribe Lifetime", async function () {
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3 } = await loadFixture(deployFixture);
            // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]

            )

            //user subcribe plans
            await usdc.connect(user1).approve(registry.target, ethers.MaxUint256);
            const planPriceUSDC = await registry.getPlanPriceETH(0);
            console.log({ planPriceUSDC });
            await registry.connect(user1).subcribeWithUSDC(2);
            expect(await setting.premiumExpired(user1.address)).to.be.gt(0n);

            // await expect(setting.connect(user1).setEmails()).to.not.reverted;
            // try {
            //     await setting.connect(user2).setEmails(); //non-premium user
            // } catch (e) {
            //     expect(e?.toString()).to.contains("Premium only");
            // }
        })

        it("should transfer purchase to payment", async function () { 
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3, payment } = await loadFixture(deployFixture);
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]

            )

            //user 1 subcribe with usdc
            await usdc.connect(user1).approve(registry.target, ethers.MaxUint256);
            const planPriceUSDC = await registry.getPlanPriceUSDC(0);
            console.log({ planPriceUSDC });
            await registry.connect(user1).subcribeWithUSDC(0);
            expect(await usdc.balanceOf(payment.address)).to.be.eq(planPriceUSDC);

            //user 2 subcribe with usdt
            await usdt.connect(user2).approve(registry.target, ethers.MaxUint256);
            const planPriceUSDT = await registry.getPlanPriceUSDT(0);
            console.log({ planPriceUSDT });
            await registry.connect(user2).subcribeWithUSDT(0);
            expect(await usdt.balanceOf(payment.address)).to.be.eq(planPriceUSDT);

            //user 3 subcribe with eth
            const planPriceETH = await registry.getPlanPriceETH(0);
            console.log({ planPriceETH });
            await registry.connect(user3).subcribeWithETH(0, {
                value: planPriceETH
            });
            const paymentEthBalance = await ethers.provider.getBalance(payment.address);
            expect(paymentEthBalance).to.be.eq(planPriceETH);
        })


        it("should reject subcribe removed plan", async function () {
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3 } = await loadFixture(deployFixture);

            // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )

            //admin remove a plan
            await registry.removePlans([0]);


            //user subcribe removed plan
            try {
                await registry.connect(user1).subcribeWithETH(0, {
                    value: parseEther("1000")
                });
            }
            catch (e) {
                expect(e?.toString()).to.contains("Plan has been removed");
            }


        })
    })

    describe("[User] Set config email reminder", async function () {
        it("should user set cofig successfully", async function () {
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev } = await loadFixture(deployFixture);
            const name = "Dat";
            const ownerEmail = "user1@example.com";
            const timePriorActivation = 3600;
            const emptyLegacyAddresses: any[] = [];
            const emptyLegacyData: any[] = [];
            const legacyAddresses = ["0xd1999d5a27378970420779b0722118f20858f198"];

            const legacyData = [
                {
                    cosigners: [],
                    beneficiaries: [
                        emailMapping("0x8e4e77cee39f54b7445441ac35a6f6fa4f541b00", "bene1@example.com", "dat"),
                    ],
                    secondLine: emailMapping("0xc3a20f9d15cfd2224038eccc8186c216366c4bfd", "second1@example.com", "dat"),
                    thirdLine: emailMapping("0x9189cd497326a4d94236a028094247a561d895c9", "third1@example.com", "dat"),
                },
            ];


            // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )

            // user subcribe for plan
            await usdc.connect(dev).approve(registry.target, ethers.MaxUint256);
            await registry.connect(dev).subcribeWithUSDC(0);

            // set config
            await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, legacyAddresses, legacyData);

            console.log(await setting.userConfigs(dev.address));

            console.log(await setting.getCosignerData(legacyAddresses[0]));
            console.log(await setting.getBeneficiaryData(legacyAddresses[0]));
            console.log(await setting.getSecondLineData(legacyAddresses[0]));
            console.log(await setting.getThirdLineData(legacyAddresses[0]));

        })

        it("should user set cofig SAFE successfully", async function () {
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev } = await loadFixture(deployFixture);
            const name = "Dat";
            const ownerEmail = "user1@example.com";
            const timePriorActivation = 3600;
            const emptyLegacyAddresses: any[] = [];
            const emptyLegacyData: any[] = [];
            const legacyAddresses = ["0x462367039ba0de3b73c4da68027a1b4eccb3e4e4"];

            const legacyData = [
                {
                    cosigners: [emailMapping("0x944a402a91c3d6663f5520bfe23c1c1ee77bca92", "dat.tran2@sotatek.com", "dat"),
                    emailMapping("0x85230a4fc826149cd7cbf3ad404420a28596d6cc", "khongbiet@gmail.com", "dat")
                    ],
                    beneficiaries: [],
                    secondLine: emailMapping("0x4c56f3deb880aad93e89895b6885823f4debb47d", "second1@example.com", "dat"),
                    thirdLine: emailMapping("0xc3a20f9d15cfd2224038eccc8186c216366c4bfd", "third1@example.com", "dat"),

                },
            ];


            // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )

            // user subcribe for plan
            await usdc.connect(dev).approve(registry.target, ethers.MaxUint256);
            await registry.connect(dev).subcribeWithUSDC(0);

            // set config
            await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, legacyAddresses, legacyData);

            console.log(await setting.userConfigs(dev.address));

            console.log(await setting.getCosignerData(legacyAddresses[0]));
            console.log(await setting.getBeneficiaryData(legacyAddresses[0]));
            console.log(await setting.getSecondLineData(legacyAddresses[0]));
            console.log(await setting.getThirdLineData(legacyAddresses[0]));

        })

        it("should user clear config", async function () {
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev } = await loadFixture(deployFixture);
            const name = "Dat";
            const ownerEmail = "user1@example.com";
            const timePriorActivation = 3600;
            const emptyLegacyAddresses: any[] = [];
            const emptyLegacyData: any[] = [];
            const legacyAddresses = ["0xd1999d5a27378970420779b0722118f20858f198"];

            const legacyData = [
                {
                    cosigners: [],
                    beneficiaries: [
                        emailMapping("0x8e4e77cee39f54b7445441ac35a6f6fa4f541b00", "bene1@example.com", "dat"),
                    ],
                    secondLine: emailMapping("0xc3a20f9d15cfd2224038eccc8186c216366c4bfd", "second1@example.com", "dat"),
                    thirdLine: emailMapping("0x9189cd497326a4d94236a028094247a561d895c9", "third1@example.com", "dat"),
                },
            ];



            // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )

            // user subcribe for plan
            await usdc.connect(dev).approve(registry.target, ethers.MaxUint256);
            await registry.connect(dev).subcribeWithUSDC(0);

            // set config
            await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, legacyAddresses, legacyData);

            console.log(await setting.userConfigs(user1.address));

            console.log(await setting.getCosignerData(legacyAddresses[0]));
            console.log(await setting.getBeneficiaryData(legacyAddresses[0]));
            console.log(await setting.getSecondLineData(legacyAddresses[0]));
            console.log(await setting.getThirdLineData(legacyAddresses[0]));

            await setting.connect(dev).clearLegacyConfig(legacyAddresses);

            console.log(await setting.getCosignerData(legacyAddresses[0]));
            console.log(await setting.getBeneficiaryData(legacyAddresses[0]));
            console.log(await setting.getSecondLineData(legacyAddresses[0]));
            console.log(await setting.getThirdLineData(legacyAddresses[0]));
        })


        it("should user set cofig successfully", async function () {
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev } = await loadFixture(deployFixture);
            const name = "Dat";
            const ownerEmail = "user1@example.com";
            const timePriorActivation = 3600;
            const emptyLegacyAddresses: any[] = [];
            const emptyLegacyData: any[] = [];
            const legacyAddresses = ["0xd1999d5a27378970420779b0722118f20858f198"];

            const legacyData = [
                {
                    cosigners: [],
                    beneficiaries: [
                        emailMapping("0x8e4e77cee39f54b7445441ac35a6f6fa4f541b00", "bene1@example.com", "dat"),
                    ],
                    secondLine: emailMapping("0xc3a20f9d15cfd2224038eccc8186c216366c4bfd", "second1@example.com", "dat"),
                    thirdLine: emailMapping("0x9189cd497326a4d94236a028094247a561d895c9", "third1@example.com", "dat"),
                },
            ];


            // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )

            // user subcribe for plan
            await usdc.connect(dev).approve(registry.target, ethers.MaxUint256);
            await registry.connect(dev).subcribeWithUSDC(0);

            // set config
            await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, legacyAddresses, legacyData);

            console.log(await setting.userConfigs(dev.address));

            console.log(await setting.getCosignerData(legacyAddresses[0]));
            console.log(await setting.getBeneficiaryData(legacyAddresses[0]));
            console.log(await setting.getSecondLineData(legacyAddresses[0]));
            console.log(await setting.getThirdLineData(legacyAddresses[0]));

        })

        it("should user set cofig multisign successfully", async function () {
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev } = await loadFixture(deployFixture);
            const name = "Dat";
            const ownerEmail = "user1@example.com";
            const timePriorActivation = 3600;
            const emptyLegacyAddresses: any[] = [];
            const emptyLegacyData: any[] = [];
            const legacyAddresses = ["0x48e9365f1956e4ba6f4ffe75dfa5b28063888c71"];

            const legacyData = [
                {
                    cosigners: [],
                    beneficiaries: [
                        emailMapping("0x85230a4fc826149cd7cbf3ad404420a28596d6cc", "bene1@example.com", "dat"),
                    ],
                    secondLine: emailMapping("0x0000000000000000000000000000000000000000", "", ""),
                    thirdLine: emailMapping("0x0000000000000000000000000000000000000000", "", "dat"),
                },
            ];


            // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )

            // user subcribe for plan
            await usdc.connect(dev).approve(registry.target, ethers.MaxUint256);
            await registry.connect(dev).subcribeWithUSDC(0);

            // set config
            await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, legacyAddresses, legacyData);

            console.log(await setting.userConfigs(dev.address));

            console.log(await setting.getCosignerData(legacyAddresses[0]));
            console.log(await setting.getBeneficiaryData(legacyAddresses[0]));
            console.log(await setting.getSecondLineData(legacyAddresses[0]));
            console.log(await setting.getThirdLineData(legacyAddresses[0]));

        })

    })

    describe("[User] Set watchers", async function () {
        it("should user set watcher", async function () {
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev } = await loadFixture(deployFixture);
            const name = "Dat";
            const ownerEmail = "user1@example.com";
            const timePriorActivation = 3600;
            const emptyLegacyAddresses: any[] = [];
            const emptyLegacyData: any[] = [];
            const legacyAddresses = ["0x55def28959f9f711f8768685cfbe7555df2575f3"];



            // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )

            // user subcribe for plan
            await usdc.connect(dev).approve(registry.target, ethers.MaxUint256);
            await registry.connect(dev).subcribeWithUSDC(0);

            // set config
            await setting.connect(dev).setWatchers(legacyAddresses[0], ["Dat"], ["0xd1999d5a27378970420779b0722118f20858f198"], [true]);
            await setting.connect(dev).clearWatcher(legacyAddresses);

        })

        it("should user set watcher for multisign legacy", async function () {
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev, multisignLegacyRouter } = await loadFixture(deployFixture);

            //create legacy
            const mainConfig = {
                name: "abc",
                note: "nothing",
                nickNames: ["dadad", "dadad"],
                beneficiaries: ["0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b", "0xa0e95ACC5ec544f040b89261887C0BBa113981AD"]
            };

            const extraConfig = {
                minRequiredSignatures: 1,
                lackOfOutgoingTxRange: 1,
            };

            const safeWallet = "0x1F845245929a537A88F70247C2A143F4E6a338B9";
            const legacyAddress = await multisignLegacyRouter.getNextLegacyAddress(dev.address);
            const currentTimestamp = (await currentTime());
            const message = await genMessage(legacyAddress, currentTimestamp);
            const signature = wallet.sign(message).signature;
    
            await multisignLegacyRouter.connect(dev).createLegacy(
                safeWallet,
                mainConfig,
                extraConfig,
                currentTimestamp,
                signature
            );

              // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )

            // user subcribe for plan
            await usdc.connect(dev).approve(registry.target, ethers.MaxUint256);
            await registry.connect(dev).subcribeWithUSDC(0);

            // set config
            await setting.connect(dev).setWatchers(legacyAddress, ["Dat"], ["0xd1999d5a27378970420779b0722118f20858f198"], [true]);


        })
        it("should user set watcher for multisig legacy 2", async function () {
            // 0x280128deed24faa75d57e9af118d8aac53b4a060
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev, multisignLegacyRouter } = await loadFixture(deployFixture);
              // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )

            // user subcribe for plan
            let legacyAddress = "0x48e9365f1956e4ba6f4ffe75dfa5b28063888c71";
            await usdc.connect(dev).approve(registry.target, ethers.MaxUint256);
            await registry.connect(dev).subcribeWithUSDC(0);
            await setting.connect(dev).setWatchers(legacyAddress, ["Dat"], ["0xd1999d5a27378970420779b0722118f20858f198"], [true]);
        })

        it("should user clear watcher ", async function () {
            // 0x280128deed24faa75d57e9af118d8aac53b4a060
            const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev, multisignLegacyRouter } = await loadFixture(deployFixture);
              // admin set up plans
            await registry.createPlans(
                [ONE_YEAR, FIVE_YEARS, LIFETIME],
                [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
                ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
                ["", "", ""],
                ["", "", ""]
            )

            // user subcribe for plan
            let legacyAddress = "0x48e9365f1956e4ba6f4ffe75dfa5b28063888c71";
            await usdc.connect(dev).approve(registry.target, ethers.MaxUint256);
            await registry.connect(dev).subcribeWithUSDC(0);
            await setting.connect(dev).setWatchers(legacyAddress, ["Dat"], ["0xd1999d5a27378970420779b0722118f20858f198"], [true]);
            await setting.connect(dev).clearWatcher([legacyAddress]);
        })
    })


    // it("should router sync beneficiaries emails", async function () {
    //     const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev } = await loadFixture(deployFixture);
    //     const name = "Dat";
    //     const ownerEmail = "user1@example.com";
    //     const timePriorActivation = 3600;
    //      const legacyAddresses = ["0xd1999d5a27378970420779b0722118f20858f198"];

    //     const legacyData = [
    //         {
    //             cosigners: [],
    //             beneficiaries: [
    //                 emailMapping("0x8e4e77cee39f54b7445441ac35a6f6fa4f541b00", "bene1@example.com"),
    //             ],
    //             secondLine: emailMapping("0xc3a20f9d15cfd2224038eccc8186c216366c4bfd", "second1@example.com"),
    //             thirdLine: emailMapping("0x9189cd497326a4d94236a028094247a561d895c9", "third1@example.com"),
    //         },
    //     ];


    //     // admin set up plans
    //     await registry.createPlans(
    //         [ONE_YEAR, FIVE_YEARS, LIFETIME],
    //         [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
    //         ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
    //         ["", "", ""],
    //         ["", "", ""]
    //     )

    //     const newDistributions = [{ user: user3.address, percent: 100 }]

    //     // user subcribe for plan
    //     await usdc.connect(dev).approve(registry.target, ethers.MaxUint256);
    //     await registry.connect(dev).subcribeWithUSDC(0);

    //     // set config
    //     await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, legacyAddresses, legacyData);
    //     let beneficiaryEmails = await setting.getBeneficiaryData(user1.address)


    //     //router update bene emails
    //     console.log({ beneficiaryEmails });
    //     await setting.connect(treasury).syncBeneficiariesEmails(user1.address, user1.address, newDistributions)

    //     beneficiaryEmails = await setting.getBeneficiaryEmails(user1.address)
    //     console.log({ beneficiaryEmails });

    // })

    //     it("should router reset layers emails", async function () {
    //         const { usdt, usdc, registry, setting, treasury, user1, user2, user3 } = await loadFixture(deployFixture);

    //         const ownerEmail = "user1@example.com";
    //         const timePriorActivation = 3600;
    //         const legacyAddresses = [user1.address, user2.address];

    //         const legacyData = [
    //             {
    //                 cosigners: [emailMapping(user2.address, "cosigner1@example.com")],
    //                 beneficiaries: [
    //                     emailMapping(user3.address, "bene1@example.com"),
    //                     emailMapping(treasury.address, "bene2@example.com")
    //                 ],
    //                 secondLine: emailMapping(user2.address, "second1@example.com"),
    //                 thirdLine: emailMapping(user3.address, "third1@example.com"),
    //                 watchers: [emailMapping(treasury.address, "watcher1@example.com")]
    //             },
    //             {
    //                 cosigners: [],
    //                 beneficiaries: [emailMapping(user2.address, "bene3@example.com")],
    //                 secondLine: emailMapping(user3.address, "second2@example.com"),
    //                 thirdLine: emailMapping(treasury.address, "third2@example.com"),
    //                 watchers: []
    //             }
    //         ];

    //         // admin set up plans
    //         await registry.createPlans(
    //             [ONE_YEAR, FIVE_YEARS, LIFETIME],
    //             [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
    //             ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
    //             ["", "", ""],
    //             ["", "", ""]

    //         )
    //         const newDistributions = [{ user: user3.address, percent: 100 }]

    //         // user subcribe for plan
    //         await usdc.connect(user1).approve(registry.target, ethers.MaxUint256);
    //         await registry.connect(user1).subcribeWithUSDC(0);

    //         // set config
    //         await setting.connect(user1).setReminderConfigs(ownerEmail, timePriorActivation, legacyAddresses, legacyData);
    //         let secondLineEmail = await setting.getSecondLineEmail(user1.address);
    //         console.log({ secondLineEmail });

    //         //router reset layer emails
    //         await setting.connect(treasury).resetLayerEmail(user1.address, user1.address, 2);
    //         secondLineEmail = await setting.getSecondLineEmail(user1.address);
    //         console.log({ secondLineEmail });

    //         //router reset
    //         let thirdLineEmail = await setting.getSecondLineEmail(user1.address);
    //         console.log({ thirdLineEmail });
    //         await setting.connect(treasury).resetLayerEmail(user1.address, user1.address, 3);
    //         thirdLineEmail = await setting.getSecondLineEmail(user1.address);
    //         console.log({ thirdLineEmail });
    //     })
    // })

})

// WucU6sHlFfMHUN-MX7BFTPhVvkkrNwIV
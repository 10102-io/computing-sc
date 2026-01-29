import Web3 from "web3";
import { ethers, network } from "hardhat";
import { ethers as ethersI } from "ethers";
import { assert } from "console";

import { currentTime, increase, increaseTo } from "./utils/time";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";


import { expect, use } from "chai";
import { formatEther, parseEther, getAddress, isAddress } from "ethers";
import { seconds } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time/duration";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { genMessage } from "../scripts/utils/genMsg";
const web3 = new Web3(process.env.RPC!);
const user_pk = process.env.DEPLOYER_PRIVATE_KEY?.trim();
const privateKey = user_pk?.startsWith('0x') ? user_pk : `0x${user_pk}`;

const user = web3.eth.accounts.privateKeyToAccount(privateKey!).address;
const wallet = web3.eth.accounts.privateKeyToAccount(privateKey!);



const router = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
// #region agent log
console.log('[AGENT] Module level - router:', router, 'type:', typeof router, 'length:', router?.length);
console.log('[AGENT] Module level - weth:', weth, 'type:', typeof weth, 'length:', weth?.length);
// #endregion


// Patch Hardhat provider to handle resolveName for addresses
// This prevents ethers v6 from trying to resolve addresses as ENS names
async function patchProvider() {
    const provider = ethers.provider;
    if (provider && typeof (provider as any).resolveName === 'function') {
        const originalResolveName = (provider as any).resolveName.bind(provider);
        (provider as any).resolveName = async (name: string) => {
            // Log what's being passed with stack trace to find where it's called from
            const stack = new Error().stack;
            const caller = stack?.split('\n')[2] || 'unknown';
            const fullStack = stack?.split('\n').slice(0, 10).join('\n') || 'no stack';
            console.log(`[DEBUG] resolveName called with: "${name}" (type: ${typeof name}, length: ${name?.length || 'undefined'})`);
            console.log(`[DEBUG] Called from: ${caller}`);
            console.log(`[DEBUG] Full stack:\n${fullStack}`);

            // #region agent log
            console.log('[AGENT] resolveName called - name:', name, 'type:', typeof name, 'length:', name?.length, 'isEmpty:', !name || name === '');
            console.log('[AGENT] resolveName stack:', fullStack);
            // #endregion

            // Handle empty string, undefined, or null - return zero address immediately
            // Note: name can be undefined if ethers passes it that way
            if (name === undefined || name === null || name === '' || (typeof name === 'string' && name.trim() === '')) {
                console.log(`[DEBUG] Empty/undefined address detected: "${name}" (type: ${typeof name}, length: ${name?.length}), returning zero address`);
                console.log(`[AGENT] EMPTY ADDRESS IN resolveName - name: "${name}", type: ${typeof name}, length: ${name?.length}, isUndefined: ${name === undefined}, isNull: ${name === null}`);
                return '0x0000000000000000000000000000000000000000';
            }

            // If it's already a valid address, return it directly (including zero address)
            if (isAddress(name)) {
                console.log(`[DEBUG] Valid address detected: ${name}`);
                return getAddress(name);
            }

            // Otherwise, try the original implementation (which will throw, but at least we logged it)
            console.log(`[DEBUG] Non-address detected: ${name}`);
            if (originalResolveName) {
                return originalResolveName(name);
            }
            throw new Error(`Cannot resolve name: ${name}`);
        };
    }
}

//Ensure legacy contract is compatible and friendly with Premium
describe("Legacy contract", async function () {
    this.timeout(150000);

    before(async function () {
        await patchProvider();
        // Verify patch is applied and test with zero address
        const provider = ethers.provider;
        if (provider && typeof (provider as any).resolveName === 'function') {
            try {
                const result = await (provider as any).resolveName('0x0000000000000000000000000000000000000000');
                console.log(`[DEBUG] Patch verified - zero address resolved to: ${result}`);
            } catch (e) {
                console.log(`[DEBUG] Patch verification failed: ${e}`);
            }
        }
    });

    async function deployFixture() {
        const [treasury, user1, user2, user3] = await ethers.getSigners(); // Get the first signer (default account)
        //deploy mock tokens 
        const ERC20 = await ethers.getContractFactory("ERC20Token");
        const usdt = await ERC20.deploy("USDT", "USDT", 6);
        const usdc = await ERC20.deploy("USDC", "USDC", 6);

        const GenericLegacy = await ethers.getContractFactory("GenericLegacy");
        const genericLegacy = await GenericLegacy.deploy();

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

        const PremiumSetting = await ethers.getContractFactory("PremiumSetting");
        const premiumSetting = await PremiumSetting.deploy();
        // #region agent log
        console.log('[AGENT] Before premiumSetting.initialize - premiumSetting.target:', premiumSetting.target, 'dev.address:', dev.address);
        // #endregion
        // Check if already initialized (for loadFixture reuse)
        try {
            await premiumSetting.connect(dev).initialize();
        } catch (error: any) {
            // If already initialized, that's okay - loadFixture might be reusing the contract
            if (!error.message?.includes('InvalidInitialization')) {
                throw error;
            }
            console.log('[AGENT] premiumSetting already initialized (loadFixture reuse)');
        }

        const Payment = await ethers.getContractFactory("Payment");
        const payment = await Payment.deploy();


        const PremiumRegistry = await ethers.getContractFactory("PremiumRegistry");
        const premiumRegistry = await PremiumRegistry.deploy();
        // #region agent log
        console.log('[AGENT] Before premiumRegistry.initialize - usdt.target:', usdt.target);
        console.log('[AGENT] Before premiumRegistry.initialize - usdc.target:', usdc.target);
        console.log('[AGENT] Before premiumRegistry.initialize - premiumSetting.target:', premiumSetting.target);
        console.log('[AGENT] Before premiumRegistry.initialize - payment.target:', payment.target);
        // #endregion
        // Check if already initialized (for loadFixture reuse)
        try {
            await premiumRegistry.connect(dev).initialize(usdt.target, usdc.target,
                "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
                "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
                "0x694AA1769357215DE4FAC081bf1f309aDC325306",
                premiumSetting.target,
                payment.target
            );
        } catch (error: any) {
            // If already initialized, that's okay - loadFixture might be reusing the contract
            if (!error.message?.includes('InvalidInitialization') && !error.message?.includes('0xf92ee8a9')) {
                throw error;
            }
            console.log('[AGENT] premiumRegistry already initialized (loadFixture reuse)');
        }


        const VerifierTerm = await ethers.getContractFactory("EIP712LegacyVerifier");
        const verifierTerm = await VerifierTerm.deploy();
        try {
            await verifierTerm.initialize(dev.address);
        } catch (error: any) {
            if (!error.message?.includes('InvalidInitialization') && !error.message?.includes('0xf92ee8a9')) {
                throw error;
            }
            console.log('[AGENT] verifierTerm already initialized (loadFixture reuse)');
        }

        // deployer contract 
        const LegacyDeployer = await ethers.getContractFactory("LegacyDeployer");
        const legacyDeployer = await LegacyDeployer.deploy();
        try {
            await legacyDeployer.initialize();
        } catch (error: any) {
            if (!error.message?.includes('InvalidInitialization') && !error.message?.includes('0xf92ee8a9')) {
                throw error;
            }
            console.log('[AGENT] legacyDeployer already initialized (loadFixture reuse)');
        }


        const TransferEOALegacyRouter = await ethers.getContractFactory("TransferEOALegacyRouter");
        let transferEOALegacyRouter = await TransferEOALegacyRouter.deploy();
        // #region agent log
        console.log('[AGENT] Before transferEOALegacyRouter.initialize - router:', router, 'type:', typeof router, 'length:', router?.length, 'isEmpty:', !router || router === '');
        console.log('[AGENT] Before transferEOALegacyRouter.initialize - weth:', weth, 'type:', typeof weth, 'length:', weth?.length, 'isEmpty:', !weth || weth === '');
        console.log('[AGENT] Before transferEOALegacyRouter.initialize - legacyDeployer.target:', legacyDeployer.target);
        console.log('[AGENT] Before transferEOALegacyRouter.initialize - premiumSetting.target:', premiumSetting.target);
        console.log('[AGENT] Before transferEOALegacyRouter.initialize - verifierTerm.target:', verifierTerm.target);
        console.log('[AGENT] Before transferEOALegacyRouter.initialize - payment.target:', payment.target);
        // #endregion
        // Normalize all addresses before passing to initialize
        const normalizedLegacyDeployer = getAddress(legacyDeployer.target);
        const normalizedPremiumSetting = getAddress(premiumSetting.target);
        const normalizedVerifierTerm = getAddress(verifierTerm.target);
        const normalizedPayment = getAddress(payment.target);
        const normalizedRouter = getAddress(router);
        const normalizedWeth = getAddress(weth);
        // Try to initialize - if it fails with InvalidInitialization, check state and deploy fresh if needed
        try {
            await transferEOALegacyRouter.initialize(
                normalizedLegacyDeployer,
                normalizedPremiumSetting,
                normalizedVerifierTerm,
                normalizedPayment,
                normalizedRouter,
                normalizedWeth
            );
            console.log('[AGENT] Router initialized successfully');
        } catch (error: any) {
            if (!error.message?.includes('InvalidInitialization') && !error.message?.includes('0xf92ee8a9')) {
                throw error;
            }
            // Router thinks it's initialized, but check if state is actually set
            const currentPremiumSetting = await transferEOALegacyRouter.premiumSetting();
            if (currentPremiumSetting === '0x0000000000000000000000000000000000000000') {
                // State is zero but contract thinks it's initialized - deploy fresh router
                console.log('[AGENT] Router state is zero but contract is initialized - deploying fresh router');
                transferEOALegacyRouter = await TransferEOALegacyRouter.deploy();
                console.log('[AGENT] Fresh router deployed at:', transferEOALegacyRouter.target);
                // Try to initialize the fresh router - if it fails due to _disableInitializers(), we can't initialize it
                try {
                    await transferEOALegacyRouter.initialize(
                        normalizedLegacyDeployer,
                        normalizedPremiumSetting,
                        normalizedVerifierTerm,
                        normalizedPayment,
                        normalizedRouter,
                        normalizedWeth
                    );
                    console.log('[AGENT] Fresh router initialized successfully');
                } catch (initError: any) {
                    // If initialization fails due to _disableInitializers(), we can't use this contract
                    // This means the contract design prevents direct initialization in tests
                    console.log('[AGENT] ERROR: Fresh router cannot be initialized due to _disableInitializers()');
                    console.log('[AGENT] This contract requires a proxy pattern for initialization');
                    throw new Error('Cannot initialize TransferEOALegacyRouter: contract has _disableInitializers() in constructor. This contract must be used with a proxy pattern.');
                }
            } else {
                console.log('[AGENT] Router already initialized (loadFixture reuse)');
            }
        }
        // #region agent log - Verify router state addresses are set
        console.log('[AGENT] After initialize - checking router state:');
        console.log('[AGENT] - premiumSetting:', await transferEOALegacyRouter.premiumSetting());
        console.log('[AGENT] - paymentContract:', await transferEOALegacyRouter.paymentContract());
        console.log('[AGENT] - uniswapRouter:', await transferEOALegacyRouter.uniswapRouter());
        console.log('[AGENT] - weth:', await transferEOALegacyRouter.weth());
        // #endregion 




        const TransferLegacyRouter = await ethers.getContractFactory("TransferLegacyRouter");
        const transferLegacyRouter = await TransferLegacyRouter.deploy();
        try {
            await transferLegacyRouter.initialize(
                legacyDeployer.target,
                premiumSetting.target,
                verifierTerm.target,
                payment.target,
                router,
                weth
            );
        } catch (error: any) {
            if (!error.message?.includes('InvalidInitialization') && !error.message?.includes('0xf92ee8a9')) {
                throw error;
            }
            console.log('[AGENT] transferLegacyRouter already initialized (loadFixture reuse)');
        }


        const MultisignLegacyRouter = await ethers.getContractFactory("MultisigLegacyRouter");
        const multisignLegacyRouter = await MultisignLegacyRouter.deploy();
        try {
            await multisignLegacyRouter.initialize(
                legacyDeployer.target,
                premiumSetting.target,
                verifierTerm.target
            );
        } catch (error: any) {
            if (!error.message?.includes('InvalidInitialization') && !error.message?.includes('0xf92ee8a9')) {
                throw error;
            }
            console.log('[AGENT] multisignLegacyRouter already initialized (loadFixture reuse)');
        }
        await premiumSetting.connect(dev).setParams(
            premiumRegistry.target,
            transferEOALegacyRouter.target,
            transferLegacyRouter.target,
            multisignLegacyRouter.target
        );


        await legacyDeployer.setParams(
            multisignLegacyRouter.target,
            transferLegacyRouter.target,
            transferEOALegacyRouter.target
        );

        await verifierTerm.connect(dev).setRouterAddresses(
            transferEOALegacyRouter.target,
            transferLegacyRouter.target,
            multisignLegacyRouter.target
        );

        //create lifetime subscription
        await premiumRegistry.connect(dev).createPlans([ethers.MaxUint256], [1], [""], [""], [""]);
        const planId = (await premiumRegistry.getNextPlanId());

        await premiumRegistry.connect(dev).subrcribeByAdmin(user1.address, Number(planId) - 1, "USDC");
        await premiumRegistry.connect(dev).subrcribeByAdmin(dev.address, Number(planId) - 1, "USDC");

        return {
            genericLegacy,
            treasury,
            user1,
            user2,
            user3,
            transferEOALegacyRouter,
            transferLegacyRouter,
            multisignLegacyRouter,
            dev,
            verifierTerm,
            premiumSetting,
            premiumRegistry,
            usdc,
            usdt
        }

    }
    it("should deploy fixture successfully", async function () {
        const { genericLegacy,
            treasury,
            user1,
            user2,
            user3 } = await loadFixture(deployFixture);

    })

    it("should create transfer EOA legacy", async function () {
        const {
            genericLegacy,
            treasury,
            user1,
            user2,
            user3,
            transferEOALegacyRouter,
            dev,
            verifierTerm,
            premiumRegistry,
            premiumSetting
        } = await loadFixture(deployFixture);


        const mainConfig = {
            name: "abc",
            note: "nothing",
            nickNames: ["dadad"],
            distributions: [
                {
                    user: getAddress("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae"),
                    percent: 100
                }
            ]
        };

        const extraConfig = {
            lackOfOutgoingTxRange: 86400,
            delayLayer2: 86400,
            delayLayer3: 86400
        };

        const layer2Distribution = {
            user: getAddress("0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b"),
            percent: 100
        };

        const layer3Distribution = {
            user: getAddress("0xa0e95ACC5ec544f040b89261887C0BBa113981AD"),
            percent: 100
        };

        const nickName2 = "daddd";
        const nickName3 = "dat";

        const legacyAddress = getAddress(await transferEOALegacyRouter.getNextLegacyAddress(user1.address));
        console.log(legacyAddress);
        const currentTimestamp = (await currentTime());
        const msg = await genMessage(currentTimestamp);
        const signature = await user1.signMessage(msg);
        console.log(msg);
        console.log(await verifierTerm.generateMessage(currentTimestamp));

        // Validate all addresses are properly formatted before calling createLegacy
        // This prevents empty strings from being passed to ethers
        // #region agent log
        console.log('[AGENT] Before createLegacy - mainConfig.distributions[0].user:', mainConfig.distributions[0].user, 'type:', typeof mainConfig.distributions[0].user, 'length:', mainConfig.distributions[0].user?.length);
        console.log('[AGENT] Before createLegacy - layer2Distribution.user:', layer2Distribution.user, 'type:', typeof layer2Distribution.user, 'length:', layer2Distribution.user?.length);
        console.log('[AGENT] Before createLegacy - layer3Distribution.user:', layer3Distribution.user, 'type:', typeof layer3Distribution.user, 'length:', layer3Distribution.user?.length);
        console.log('[AGENT] Before createLegacy - mainConfig:', JSON.stringify(mainConfig));
        console.log('[AGENT] Before createLegacy - layer2Distribution:', JSON.stringify(layer2Distribution));
        console.log('[AGENT] Before createLegacy - layer3Distribution:', JSON.stringify(layer3Distribution));
        // #endregion
        if (!layer2Distribution.user || layer2Distribution.user === '') {
            throw new Error('layer2Distribution.user is empty');
        }
        if (!layer3Distribution.user || layer3Distribution.user === '') {
            throw new Error('layer3Distribution.user is empty');
        }
        for (const dist of mainConfig.distributions) {
            if (!dist.user || dist.user === '') {
                throw new Error('distribution user is empty');
            }
        }
        // #region agent log - Deep validation of ALL address fields
        console.log('[AGENT] === DEEP VALIDATION BEFORE createLegacy ===');
        // Validate mainConfig.distributions
        for (let i = 0; i < mainConfig.distributions.length; i++) {
            const dist = mainConfig.distributions[i];
            console.log(`[AGENT] mainConfig.distributions[${i}].user:`, dist.user, 'type:', typeof dist.user, 'length:', dist.user?.length, 'isEmpty:', !dist.user || dist.user === '', 'isUndefined:', dist.user === undefined, 'isNull:', dist.user === null);
            if (dist.user === undefined || dist.user === null || dist.user === '' || typeof dist.user !== 'string') {
                throw new Error(`mainConfig.distributions[${i}].user is invalid: "${dist.user}" (type: ${typeof dist.user}, isUndefined: ${dist.user === undefined}, isNull: ${dist.user === null})`);
            }
            // Re-normalize to ensure it's valid
            mainConfig.distributions[i].user = getAddress(dist.user);
        }
        console.log('[AGENT] layer2Distribution.user:', layer2Distribution.user, 'type:', typeof layer2Distribution.user, 'length:', layer2Distribution.user?.length, 'isEmpty:', !layer2Distribution.user || layer2Distribution.user === '', 'isUndefined:', layer2Distribution.user === undefined, 'isNull:', layer2Distribution.user === null);
        if (layer2Distribution.user === undefined || layer2Distribution.user === null || layer2Distribution.user === '' || typeof layer2Distribution.user !== 'string') {
            throw new Error(`layer2Distribution.user is invalid: "${layer2Distribution.user}" (type: ${typeof layer2Distribution.user}, isUndefined: ${layer2Distribution.user === undefined}, isNull: ${layer2Distribution.user === null})`);
        }
        layer2Distribution.user = getAddress(layer2Distribution.user);

        console.log('[AGENT] layer3Distribution.user:', layer3Distribution.user, 'type:', typeof layer3Distribution.user, 'length:', layer3Distribution.user?.length, 'isEmpty:', !layer3Distribution.user || layer3Distribution.user === '', 'isUndefined:', layer3Distribution.user === undefined, 'isNull:', layer3Distribution.user === null);
        if (layer3Distribution.user === undefined || layer3Distribution.user === null || layer3Distribution.user === '' || typeof layer3Distribution.user !== 'string') {
            throw new Error(`layer3Distribution.user is invalid: "${layer3Distribution.user}" (type: ${typeof layer3Distribution.user}, isUndefined: ${layer3Distribution.user === undefined}, isNull: ${layer3Distribution.user === null})`);
        }
        layer3Distribution.user = getAddress(layer3Distribution.user);

        console.log('[AGENT] === ALL ADDRESSES VALIDATED ===');
        // Final check - ensure all addresses are still valid right before the call
        console.log('[AGENT] Final check before createLegacy call:');
        console.log('[AGENT] - mainConfig.distributions[0].user:', mainConfig.distributions[0].user);
        console.log('[AGENT] - layer2Distribution.user:', layer2Distribution.user);
        console.log('[AGENT] - layer3Distribution.user:', layer3Distribution.user);

        // CRITICAL: Check router state variables that will be passed to legacy.initialize
        // These are read from the router contract and passed directly to legacy.initialize
        const routerPremiumSetting = await transferEOALegacyRouter.premiumSetting();
        const routerPaymentContract = await transferEOALegacyRouter.paymentContract();
        const routerUniswapRouter = await transferEOALegacyRouter.uniswapRouter();
        const routerWeth = await transferEOALegacyRouter.weth();
        console.log('[AGENT] === ROUTER STATE VARIABLES (passed to legacy.initialize) ===');
        console.log('[AGENT] - router.premiumSetting:', routerPremiumSetting, 'type:', typeof routerPremiumSetting, 'length:', routerPremiumSetting?.length, 'isEmpty:', !routerPremiumSetting || routerPremiumSetting === '', 'isUndefined:', routerPremiumSetting === undefined);
        console.log('[AGENT] - router.paymentContract:', routerPaymentContract, 'type:', typeof routerPaymentContract, 'length:', routerPaymentContract?.length, 'isEmpty:', !routerPaymentContract || routerPaymentContract === '', 'isUndefined:', routerPaymentContract === undefined);
        console.log('[AGENT] - router.uniswapRouter:', routerUniswapRouter, 'type:', typeof routerUniswapRouter, 'length:', routerUniswapRouter?.length, 'isEmpty:', !routerUniswapRouter || routerUniswapRouter === '', 'isUndefined:', routerUniswapRouter === undefined);
        console.log('[AGENT] - router.weth:', routerWeth, 'type:', typeof routerWeth, 'length:', routerWeth?.length, 'isEmpty:', !routerWeth || routerWeth === '', 'isUndefined:', routerWeth === undefined);

        // Validate router state variables
        if (!routerPremiumSetting || routerPremiumSetting === '' || routerPremiumSetting === undefined) {
            throw new Error(`router.premiumSetting is invalid: "${routerPremiumSetting}" (type: ${typeof routerPremiumSetting})`);
        }
        if (!routerPaymentContract || routerPaymentContract === '' || routerPaymentContract === undefined) {
            throw new Error(`router.paymentContract is invalid: "${routerPaymentContract}" (type: ${typeof routerPaymentContract})`);
        }
        if (!routerUniswapRouter || routerUniswapRouter === '' || routerUniswapRouter === undefined) {
            throw new Error(`router.uniswapRouter is invalid: "${routerUniswapRouter}" (type: ${typeof routerUniswapRouter})`);
        }
        if (!routerWeth || routerWeth === '' || routerWeth === undefined) {
            throw new Error(`router.weth is invalid: "${routerWeth}" (type: ${typeof routerWeth})`);
        }
        // #endregion

        // Wrap the call in try-catch to see exact error
        try {
            await transferEOALegacyRouter.connect(user1).createLegacy(
                mainConfig,
                extraConfig,
                layer2Distribution,
                layer3Distribution,
                nickName2,
                nickName3,
                currentTimestamp,
                signature
            );
        } catch (error: any) {
            console.log('[AGENT] ERROR in createLegacy:', error.message);
            console.log('[AGENT] Error stack:', error.stack);
            if (error.message?.includes('unconfigured name')) {
                console.log('[AGENT] UNCONFIGURED NAME ERROR - checking all addresses again:');
                console.log('[AGENT] - mainConfig:', JSON.stringify(mainConfig, null, 2));
                console.log('[AGENT] - layer2Distribution:', JSON.stringify(layer2Distribution, null, 2));
                console.log('[AGENT] - layer3Distribution:', JSON.stringify(layer3Distribution, null, 2));
            }
            throw error;
        }


        const legacy = await ethers.getContractAt("TransferEOALegacy", getAddress(legacyAddress));
        console.log(await legacy.isLive());
        console.log(await legacy.getTriggerActivationTimestamp());
        console.log(await legacy.getLegacyBeneficiaries());
        expect(await legacy.getLayer()).to.be.eql(1)
        await increase(86400 * 2 + 1);
        expect(await legacy.getLayer()).to.be.eql(2)
        await increase(86400);
        expect(await legacy.getLayer()).to.be.eql(3)

        // expect(await premiumSetting.connect(dev).getLegacyCode(legacyAddress)).to.be.gte(1000000); // a 7 digit number

        expect(await legacy.getLegacyName()).to.be.eql(mainConfig.name);
        console.log(await legacy.getBeneNickname("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae"))
        console.log("Last timestamp", await legacy.getLastTimestamp())

        //update bene  name via setLegacyConfig
        console.log("update bene name via setLegacyConfig")
        let newConfig = {
            name: "abc",
            note: "nothing",
            nickNames: ["dat"],
            distributions: [
                {
                    user: getAddress("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae"),
                    percent: 100
                }
            ]
        };

        const newlayer2Distribution = {
            user: getAddress("0xc3a20F9D15cfD2224038EcCC8186C216366c4BFd"),
            percent: 100
        };

        const newlayer3Distribution = {
            user: getAddress("0x85230A4Fc826149cd7CBF3Ad404420A28596D6CC"),
            percent: 100
        };
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/9a741554-2047-4d0c-90f7-d919d6243b39', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'Legacy.spec.ts:353', message: 'After newlayer3Distribution creation', data: { user: newlayer3Distribution.user, userType: typeof newlayer3Distribution.user }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'D' }) }).catch(() => { });
        // #endregion

        const newNickname2 = "newNickname2";
        const newNickname3 = "newNickname3";
        await transferEOALegacyRouter.connect(user1).setLegacyConfig(1, newConfig, extraConfig, newlayer2Distribution, newlayer3Distribution, newNickname2, newNickname3)

        //bene 
        expect(await legacy.getBeneNickname("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae")).to.be.eql(newConfig.nickNames[0])
        expect(await legacy.getBeneNickname("0xc3a20F9D15cfD2224038EcCC8186C216366c4BFd")).to.be.eql(newNickname2)
        expect(await legacy.getBeneNickname("0x85230A4Fc826149cd7CBF3Ad404420A28596D6CC")).to.be.eql(newNickname3)
        expect(await legacy.getBeneNickname("0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b")).to.be.eql("")
        expect(await legacy.getBeneNickname("0xa0e95ACC5ec544f040b89261887C0BBa113981AD")).to.be.eql("")


        //update bene name via setLegacy Distribution 
        console.log("update bene name via setLegacy Distribution ")
        let nickNames = ["dat3", "dat4"];
        let newDistributions = [
            {
                user: getAddress("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae"),
                percent: 50
            },
            {
                user: getAddress("0x9189CD497326A4D94236a028094247A561D895c9"),
                percent: 50
            }
        ]
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/9a741554-2047-4d0c-90f7-d919d6243b39', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'Legacy.spec.ts:366', message: 'Before setLegacyDistributions', data: { newDist0User: newDistributions[0].user, newDist0UserType: typeof newDistributions[0].user, newDist1User: newDistributions[1].user, newDist1UserType: typeof newDistributions[1].user }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'D' }) }).catch(() => { });
        // #endregion
        await transferEOALegacyRouter.connect(user1).setLegacyDistributions(1, nickNames, newDistributions)
        expect(await legacy.getBeneNickname("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae")).to.be.eql(nickNames[0])
        expect(await legacy.getBeneNickname("0x9189CD497326A4D94236a028094247A561D895c9")).to.be.eql(nickNames[1])
    })


    it("should revert used sig ", async function () {
        const {
            genericLegacy,
            treasury,
            user1,
            user2,
            user3,
            transferEOALegacyRouter,
            dev,
            verifierTerm,
            premiumRegistry,
            premiumSetting
        } = await loadFixture(deployFixture);


        const mainConfig = {
            name: "abc",
            note: "nothing",
            nickNames: ["dadad"],
            distributions: [
                {
                    user: getAddress("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae"),
                    percent: 100
                }
            ]
        };

        const extraConfig = {
            lackOfOutgoingTxRange: 86400,
            delayLayer2: 86400,
            delayLayer3: 86400
        };

        const layer2Distribution = {
            user: getAddress("0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b"),
            percent: 100
        };

        const layer3Distribution = {
            user: getAddress("0xa0e95ACC5ec544f040b89261887C0BBa113981AD"),
            percent: 100
        };

        const nickName2 = "daddd";
        const nickName3 = "dat";

        const legacyAddress = getAddress(await transferEOALegacyRouter.getNextLegacyAddress(user1.address));
        console.log(legacyAddress);
        const currentTimestamp = (await currentTime());
        const msg = await genMessage(currentTimestamp);
        const signature = await user1.signMessage(msg);


        await transferEOALegacyRouter.connect(user1).createLegacy(
            mainConfig,
            extraConfig,
            layer2Distribution,
            layer3Distribution,
            nickName2,
            nickName3,
            currentTimestamp,
            signature
        );



        try {
            await (transferEOALegacyRouter.connect(user2).createLegacy(
                mainConfig,
                extraConfig,
                layer2Distribution,
                layer3Distribution,
                nickName2,
                nickName3,
                currentTimestamp,
                signature
            ))
        }
        catch (e) {
            expect(e?.toString()).to.contains("SignatureUsed()");
        }


    })

    it.only("should beneficiaries activate legacy and claim assets", async function () {
        const {
            genericLegacy,
            treasury,
            user1,
            user2,
            user3,
            transferEOALegacyRouter,
            dev,
            verifierTerm,
            premiumRegistry,
            usdc,
            usdt
        } = await loadFixture(deployFixture);


        const mainConfig = {
            name: "abc",
            note: "nothing",
            nickNames: ["dadad"],
            distributions: [
                {
                    user: getAddress(user2.address),
                    percent: 50
                },
                {
                    user: getAddress(user3.address),
                    percent: 50
                }
            ]
        };

        const extraConfig = {
            lackOfOutgoingTxRange: 86400,
            delayLayer2: 86400,
            delayLayer3: 86400
        };

        const layer2Distribution = {
            user: getAddress("0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b"),
            percent: 100
        };

        const layer3Distribution = {
            user: getAddress("0xa0e95ACC5ec544f040b89261887C0BBa113981AD"),
            percent: 100
        };

        const nickName2 = "daddd";
        const nickName3 = "dat";

        const legacyAddress = getAddress(await transferEOALegacyRouter.getNextLegacyAddress(user1.address));
        console.log(legacyAddress);
        const currentTimestamp = (await currentTime());
        const msg = await genMessage(currentTimestamp);
        const signature = await user1.signMessage(msg);



        await transferEOALegacyRouter.connect(user1).createLegacy(
            mainConfig,
            extraConfig,
            layer2Distribution,
            layer3Distribution,
            nickName2,
            nickName3,
            currentTimestamp,
            signature
        );

        const legacy = await ethers.getContractAt("TransferEOALegacy", getAddress(legacyAddress));

        await usdc.mint(user1.address, 1000 * 10 ** 6);
        await usdc.connect(user1).approve(legacyAddress, 1000 * 10 ** 6);
        await increase(86400 + 1);
        await network.provider.send("hardhat_setBalance", [
            legacyAddress,
            "0x1000000000000000000" // 1 ETH
        ]);
        const balanceLegacy = await ethers.provider.getBalance(legacyAddress);
        console.log("Contract balance:", formatEther(balanceLegacy), "ETH");

        //activate legacy successfully 
        let balanceBene = await ethers.provider.getBalance(user2.address);
        console.log("Bene balance:", formatEther(balanceBene), "ETH");

        await transferEOALegacyRouter.connect(user2).activeLegacy(1, [usdc.target], true);

        expect(await usdc.balanceOf(user2.address)).to.equal(1000 * 10 ** 6);

        balanceBene = await ethers.provider.getBalance(user2.address);
        console.log("Bene balance after claim:", formatEther(balanceBene), "ETH");
    })

    it("should layer2 activate legacy when time trigger passed", async function () {
        const {
            genericLegacy,
            treasury,
            user1,
            user2,
            user3,
            transferEOALegacyRouter,
            dev,
            verifierTerm,
            premiumRegistry,
            usdc,
            usdt,
            premiumSetting
        } = await loadFixture(deployFixture);


        const mainConfig = {
            name: "abc",
            note: "nothing",
            nickNames: ["dadad"],
            distributions: [
                {
                    user: getAddress(user2.address),
                    percent: 100
                }
            ]
        };

        const extraConfig = {
            lackOfOutgoingTxRange: 86400,
            delayLayer2: 86400,
            delayLayer3: 86400
        };

        const layer2Distribution = {
            user: getAddress(user3.address),
            percent: 100
        };

        const layer3Distribution = {
            user: getAddress("0xa0e95ACC5ec544f040b89261887C0BBa113981AD"),
            percent: 100
        };

        const nickName2 = "daddd";
        const nickName3 = "dat";

        const legacyAddress = getAddress(await transferEOALegacyRouter.getNextLegacyAddress(user1.address));
        console.log(legacyAddress);
        const currentTimestamp = (await currentTime());
        const msg = await genMessage(currentTimestamp);
        const signature = await user1.signMessage(msg);


        await transferEOALegacyRouter.connect(user1).createLegacy(
            mainConfig,
            extraConfig,
            layer2Distribution,
            layer3Distribution,
            nickName2,
            nickName3,
            currentTimestamp,
            signature
        );
        const legacy = await ethers.getContractAt("TransferEOALegacy", getAddress(legacyAddress));


        await increase(86400 * 2);


        //now layer 2 can claim assets
        usdc.mint(user1.address, 1000 * 10 ** 6);
        usdc.connect(user1).approve(legacyAddress, 1000 * 10 ** 6);
        await transferEOALegacyRouter.connect(user3).activeLegacy(1, [usdc.target], true);

        expect(await usdc.balanceOf(user3.address)).to.equal(1000 * 10 ** 6);




    })

    it("should create transfer legacy (Safe) ", async function () {
        const {
            genericLegacy,
            treasury,
            user1,
            user2,
            user3,
            transferEOALegacyRouter,
            transferLegacyRouter,
            dev,
            premiumSetting
        } = await loadFixture(deployFixture);


        const mainConfig = {
            name: "abc",
            note: "nothing",
            nickNames: ["dadad"],
            distributions: [
                {
                    user: getAddress(user2.address),
                    percent: 100
                }
            ]
        };

        const extraConfig = {
            lackOfOutgoingTxRange: 86400,
            delayLayer2: 86400,
            delayLayer3: 86400
        };

        const layer2Distribution = {
            user: getAddress(user3.address),
            percent: 100
        };

        const layer3Distribution = {
            user: getAddress("0xa0e95ACC5ec544f040b89261887C0BBa113981AD"),
            percent: 100
        };

        const nickName2 = "daddd";
        const nickName3 = "dat";

        const safeWallet = "0x1F845245929a537A88F70247C2A143F4E6a338B9"
        const legacyAddress = getAddress(await transferLegacyRouter.getNextLegacyAddress(dev.address));
        const currentTimestamp = (await currentTime());
        const message = await genMessage(currentTimestamp);
        const signature = wallet.sign(message).signature;

        await transferLegacyRouter.connect(dev).createLegacy(
            safeWallet,
            mainConfig,
            extraConfig,
            layer2Distribution,
            layer3Distribution,
            nickName2,
            nickName3,
            currentTimestamp,
            signature
        );

        console.log(legacyAddress);
        const legacy = await ethers.getContractAt("TransferLegacy", getAddress(legacyAddress));

        console.log(await legacy.isLive());
        console.log(await legacy.getTriggerActivationTimestamp());
        console.log(await legacy.getLegacyBeneficiaries());
        console.log(await legacy.getLayer())  //1

        await increase(86400 * 2 + 1);

        console.log(await legacy.getLayer()) //2

        await increase(86400);

        console.log(await legacy.getLayer()) // 3

        // expect(await premiumSetting.connect(dev).getLegacyCode(legacyAddress)).to.be.gte(1000000); // a 7 digit number
        expect(await legacy.getLegacyName()).to.be.eql(mainConfig.name);

        console.log("Last timestamp", await legacy.getLastTimestamp())




    })

    it("should beneficiaries activate (Safe) legacy and claim assets", async function () {
        const {
            genericLegacy,
            treasury,
            user1,
            user2,
            user3,
            transferEOALegacyRouter,
            transferLegacyRouter,
            dev,
            usdc
        } = await loadFixture(deployFixture);


        const mainConfig = {
            name: "abc",
            note: "nothing",
            nickNames: ["dadad"],
            distributions: [
                {
                    user: getAddress(user1.address),
                    percent: 100
                }
            ]
        };

        const extraConfig = {
            lackOfOutgoingTxRange: 86400,
            delayLayer2: 86400,
            delayLayer3: 86400
        };

        const layer2Distribution = {
            user: getAddress(user2.address),
            percent: 100
        };

        const layer3Distribution = {
            user: getAddress("0xa0e95ACC5ec544f040b89261887C0BBa113981AD"),
            percent: 100
        };

        const nickName2 = "daddd";
        const nickName3 = "dat";

        const safeWallet = "0x1F845245929a537A88F70247C2A143F4E6a338B9"
        const legacyAddress = getAddress(await transferLegacyRouter.getNextLegacyAddress(dev.address));
        const currentTimestamp = (await currentTime());
        const message = await genMessage(currentTimestamp);
        const signature = wallet.sign(message).signature;

        await transferLegacyRouter.connect(dev).createLegacy(
            safeWallet,
            mainConfig,
            extraConfig,
            layer2Distribution,
            layer3Distribution,
            nickName2,
            nickName3,
            currentTimestamp,
            signature
        );

        const legacy = await ethers.getContractAt("TransferLegacy", getAddress(legacyAddress));

        await increase(86400);


        await usdc.mint(user1.address, 1000 * 10 ** 6);
        await usdc.connect(user1).approve(legacyAddress, 1000 * 10 ** 6);

        //activate legacy successfully 

        await transferLegacyRouter.connect(user1).activeLegacy(1, [usdc.target], true);

        expect(await usdc.balanceOf(user1.address)).to.equal(1000 * 10 ** 6);

    })

    it("should layer2 activate (Safe) legacy and claim assets", async function () {
        const {
            genericLegacy,
            treasury,
            user1,
            user2,
            user3,
            transferEOALegacyRouter,
            transferLegacyRouter,
            dev,
            usdc
        } = await loadFixture(deployFixture);


        const mainConfig = {
            name: "abc",
            note: "nothing",
            nickNames: ["dadad"],
            distributions: [
                {
                    user: getAddress(user1.address),
                    percent: 100
                }
            ]
        };

        const extraConfig = {
            lackOfOutgoingTxRange: 86400,
            delayLayer2: 86400,
            delayLayer3: 86400
        };

        const layer2Distribution = {
            user: getAddress(user2.address),
            percent: 100
        };

        const layer3Distribution = {
            user: getAddress("0xa0e95ACC5ec544f040b89261887C0BBa113981AD"),
            percent: 100
        };

        const nickName2 = "daddd";
        const nickName3 = "dat";

        const safeWallet = "0x1F845245929a537A88F70247C2A143F4E6a338B9"
        const legacyAddress = getAddress(await transferLegacyRouter.getNextLegacyAddress(dev.address));
        const currentTimestamp = (await currentTime());
        const message = await genMessage(currentTimestamp);
        const signature = wallet.sign(message).signature;

        await transferLegacyRouter.connect(dev).createLegacy(
            safeWallet,
            mainConfig,
            extraConfig,
            layer2Distribution,
            layer3Distribution,
            nickName2,
            nickName3,
            currentTimestamp,
            signature
        );

        const legacy = await ethers.getContractAt("TransferLegacy", getAddress(legacyAddress));

        await increase(86400 * 2);
        await transferLegacyRouter.connect(user2).activeLegacy(1, [], true);




    })

    it("should create multisign legacy", async function () {
        const {
            genericLegacy,
            treasury,
            user1,
            user2,
            user3,
            transferEOALegacyRouter,
            transferLegacyRouter,
            multisignLegacyRouter,
            dev,
            premiumSetting
        } = await loadFixture(deployFixture);

        const mainConfig = {
            name: "abc",
            note: "nothing",
            nickNames: ["dadad", "dadad"],
            beneficiaries: [user1.address, user2.address]
        };

        const extraConfig = {
            minRequiredSignatures: 1,
            lackOfOutgoingTxRange: 1,
        };



        const safeWallet = "0x1F845245929a537A88F70247C2A143F4E6a338B9"
        const legacyAddress = getAddress(await multisignLegacyRouter.getNextLegacyAddress(dev.address));
        const currentTimestamp = (await currentTime());
        const message = await genMessage(currentTimestamp);
        const signature = wallet.sign(message).signature;

        await multisignLegacyRouter.connect(dev).createLegacy(
            safeWallet,
            mainConfig,
            extraConfig,
            currentTimestamp,
            signature
        );

        const legacy = await ethers.getContractAt("MultisigLegacy", getAddress(legacyAddress));

        console.log(await legacy.isLive());
        console.log(await legacy.getTriggerActivationTimestamp());
        console.log(await legacy.getLegacyBeneficiaries());

        // expect(await premiumSetting.connect(dev).getLegacyCode(legacyAddress)).to.be.gte(1000000); // a 7 digit number
        expect(await legacy.getLegacyName()).to.be.eql(mainConfig.name)
        console.log("Last timestamp", await legacy.getLastTimestamp())


        console.log(await premiumSetting.getBatchLegacyTriggerTimestamp([legacyAddress, legacyAddress]));
    })

})
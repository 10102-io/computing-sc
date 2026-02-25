import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { assert } from "chai";

import { AddressZero } from "@ethersproject/constants";

type InterfaceWithParseLog = {
    parseLog: (log: { topics: string[]; data: string }) => { name: string; args: unknown[] } | null;
};

describe("TokenWhiteList", function () {
    async function deployFixture() {
        const [admin, operator, other] = await ethers.getSigners();

        const TokenWhiteListFactory = await ethers.getContractFactory("TokenWhiteList");
        const whitelist = await TokenWhiteListFactory.deploy(admin.address);

        const ERC20Factory = await ethers.getContractFactory("ERC20Token");
        const tokenA = await ERC20Factory.deploy("Token A", "TKA", 18);
        const tokenB = await ERC20Factory.deploy("Token B", "TKB", 6);

        return { whitelist, tokenA, tokenB, admin, operator, other };
    }

    function toAddress(value: unknown): string {
        if (typeof value === "string") return value.toLowerCase();
        if (value && typeof value === "object" && "address" in value) return String((value as { address: string }).address).toLowerCase();
        return String(value).toLowerCase();
    }

    async function getContractAddress(contract: { address?: string; getAddress?: () => Promise<string> }): Promise<string> {
        if (contract.address) return contract.address;
        if (typeof contract.getAddress === "function") return contract.getAddress();
        throw new Error("Cannot get contract address");
    }

    describe("deployment", function () {
        it("grants DEFAULT_ADMIN_ROLE to initial admin", async function () {
            const { whitelist, admin } = await loadFixture(deployFixture);
            const defaultAdminRole = await whitelist.DEFAULT_ADMIN_ROLE();
            assert.isTrue(await whitelist.hasRole(defaultAdminRole, admin.address));
        });
    });

    describe("roles", function () {
        it("allows admin to grant DEFAULT_ADMIN_ROLE to another account", async function () {
            const { whitelist, admin, operator } = await loadFixture(deployFixture);
            const defaultAdminRole = await whitelist.DEFAULT_ADMIN_ROLE();
            await whitelist.connect(admin).grantRole(defaultAdminRole, operator.address);
            assert.isTrue(await whitelist.hasRole(defaultAdminRole, operator.address));
        });

        it("account with granted DEFAULT_ADMIN_ROLE can add and remove tokens", async function () {
            const { whitelist, tokenA, admin, operator } = await loadFixture(deployFixture);
            const defaultAdminRole = await whitelist.DEFAULT_ADMIN_ROLE();
            await whitelist.connect(admin).grantRole(defaultAdminRole, operator.address);

            await whitelist.connect(operator).addToken(tokenA.address);
            assert.isTrue(await whitelist.isWhitelisted(tokenA.address));

            await whitelist.connect(operator).removeToken(tokenA.address);
            assert.isFalse(await whitelist.isWhitelisted(tokenA.address));
        });
    });

    describe("addToken", function () {
        it("allows admin to add an ERC20 token and emits TokenAdded", async function () {
            const { whitelist, tokenA, admin } = await loadFixture(deployFixture);

            const tx = await whitelist.connect(admin).addToken(tokenA.address);
            const receipt = await tx.wait();
            const iface = whitelist.interface;
            const whitelistAddr = await getContractAddress(whitelist);
            const log = receipt!.logs.find((l: { address: string }) => toAddress(l.address) === toAddress(whitelistAddr));
            assert.ok(log !== undefined && log !== null, "TokenAdded event not found");
            const logData = { topics: (log as { topics: string[] }).topics as string[], data: (log as { data: string }).data };
            const parsed = (iface as unknown as InterfaceWithParseLog).parseLog(logData);
            assert.equal(parsed?.name, "TokenAdded");
            assert.equal(toAddress(parsed?.args[0]), toAddress(tokenA.address));

            assert.isTrue(await whitelist.isWhitelisted(tokenA.address));
        });

        it("reverts when caller does not have DEFAULT_ADMIN_ROLE", async function () {
            const { whitelist, tokenA, other } = await loadFixture(deployFixture);

            let reverted = false;
            try {
                await whitelist.connect(other).addToken(tokenA.address);
            } catch {
                reverted = true;
            }
            assert.isTrue(reverted);
        });

        it("reverts when token is not an ERC20 contract", async function () {
            const { whitelist, admin, other } = await loadFixture(deployFixture);
            const nonContractAddress = other.address;

            let reverted = false;
            try {
                await whitelist.connect(admin).addToken(nonContractAddress);
            } catch {
                reverted = true;
            }
            assert.isTrue(reverted, "addToken should revert when address is not an ERC20 contract");
        });

        it("reverts when token is already whitelisted", async function () {
            const { whitelist, tokenA, admin } = await loadFixture(deployFixture);

            await whitelist.connect(admin).addToken(tokenA.address);

            let reverted = false;
            try {
                await whitelist.connect(admin).addToken(tokenA.address);
            } catch {
                reverted = true;
            }
            assert.isTrue(reverted);
        });

        it("appends token to tokenList and updates whitelist lookup", async function () {
            const { whitelist, tokenA, tokenB, admin } = await loadFixture(deployFixture);

            await whitelist.connect(admin).addToken(tokenA.address);
            await whitelist.connect(admin).addToken(tokenB.address);

            assert.equal(toAddress(await whitelist.tokenList(0)), toAddress(tokenA.address));
            assert.equal(toAddress(await whitelist.tokenList(1)), toAddress(tokenB.address));
            assert.isTrue(await whitelist.isWhitelisted(tokenA.address));
            assert.isTrue(await whitelist.isWhitelisted(tokenB.address));
        });
    });

    describe("removeToken", function () {
        it("allows admin to remove a whitelisted token and emits TokenRemoved", async function () {
            const { whitelist, tokenA, admin } = await loadFixture(deployFixture);
            await whitelist.connect(admin).addToken(tokenA.address);

            const tx = await whitelist.connect(admin).removeToken(tokenA.address);
            const receipt = await tx.wait();
            const iface = whitelist.interface;
            const whitelistAddr = await getContractAddress(whitelist);
            const log = receipt!.logs.find((l: { address: string }) => toAddress(l.address) === toAddress(whitelistAddr));
            assert.ok(log !== undefined && log !== null, "TokenRemoved event not found");
            const logData = { topics: (log as { topics: string[] }).topics as string[], data: (log as { data: string }).data };
            const parsed = (iface as unknown as InterfaceWithParseLog).parseLog(logData);
            assert.equal(parsed?.name, "TokenRemoved");
            assert.equal(toAddress(parsed?.args[0]), toAddress(tokenA.address));

            assert.isFalse(await whitelist.isWhitelisted(tokenA.address));
        });

        it("reverts when caller does not have DEFAULT_ADMIN_ROLE", async function () {
            const { whitelist, tokenA, admin, other } = await loadFixture(deployFixture);
            await whitelist.connect(admin).addToken(tokenA.address);

            let reverted = false;
            try {
                await whitelist.connect(other).removeToken(tokenA.address);
            } catch {
                reverted = true;
            }
            assert.isTrue(reverted);
        });

        it("does nothing when token is not whitelisted (no revert, no event)", async function () {
            const { whitelist, tokenA, admin } = await loadFixture(deployFixture);

            const tx = await whitelist.connect(admin).removeToken(tokenA.address);
            const receipt = await tx.wait();
            const whitelistAddr = await getContractAddress(whitelist);
            const logs = receipt!.logs.filter((l: { address: string }) => toAddress(l.address) === toAddress(whitelistAddr));
            assert.equal(logs.length, 0);
        });

        it("does not remove token from tokenList (array unchanged)", async function () {
            const { whitelist, tokenA, tokenB, admin } = await loadFixture(deployFixture);
            await whitelist.connect(admin).addToken(tokenA.address);
            await whitelist.connect(admin).addToken(tokenB.address);

            await whitelist.connect(admin).removeToken(tokenA.address);

            assert.equal(toAddress(await whitelist.tokenList(0)), toAddress(tokenA.address));
            assert.equal(toAddress(await whitelist.tokenList(1)), toAddress(tokenB.address));
            assert.isFalse(await whitelist.isWhitelisted(tokenA.address));
            assert.isTrue(await whitelist.isWhitelisted(tokenB.address));
        });
    });

    describe("getWhitelist", function () {
        it("returns empty array when no tokens added", async function () {
            const { whitelist } = await loadFixture(deployFixture);

            const list = await whitelist.getWhitelist();

            assert.equal(list.length, 0);
        });

        it("returns only currently whitelisted tokens", async function () {
            const { whitelist, tokenA, tokenB, admin } = await loadFixture(deployFixture);
            await whitelist.connect(admin).addToken(tokenA.address);
            await whitelist.connect(admin).addToken(tokenB.address);
            await whitelist.connect(admin).removeToken(tokenA.address);

            const list = await whitelist.getWhitelist();

            assert.equal(list.length, 2);
            const whitelistedAddresses = list.filter((a: string) => toAddress(a) !== AddressZero);
            assert.deepEqual(whitelistedAddresses.map(toAddress), [toAddress(tokenB.address)]);
        });

        it("returns all added tokens when none removed", async function () {
            const { whitelist, tokenA, tokenB, admin } = await loadFixture(deployFixture);
            await whitelist.connect(admin).addToken(tokenA.address);
            await whitelist.connect(admin).addToken(tokenB.address);

            const list = await whitelist.getWhitelist();

            assert.equal(list.length, 2);
            const whitelistedAddresses = list.filter((a: string) => toAddress(a) !== AddressZero);
            assert.includeMembers(whitelistedAddresses.map(toAddress), [toAddress(tokenA.address), toAddress(tokenB.address)]);
            assert.equal(whitelistedAddresses.length, 2);
        });
    });

    describe("isWhitelisted", function () {
        it("returns false for unknown token", async function () {
            const { whitelist, tokenA } = await loadFixture(deployFixture);

            assert.isFalse(await whitelist.isWhitelisted(tokenA.address));
        });

        it("returns true after add, false after remove", async function () {
            const { whitelist, tokenA, admin } = await loadFixture(deployFixture);

            assert.isFalse(await whitelist.isWhitelisted(tokenA.address));

            await whitelist.connect(admin).addToken(tokenA.address);
            assert.isTrue(await whitelist.isWhitelisted(tokenA.address));

            await whitelist.connect(admin).removeToken(tokenA.address);
            assert.isFalse(await whitelist.isWhitelisted(tokenA.address));
        });
    });
});

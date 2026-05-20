import { ethers } from "hardhat";

// Check ownership/state of all relevant contracts after the partial redeploy, so we know
// exactly what we still need to rewire (and whether the OLD PremiumSetting is still usable).

const EXPECTED_ADMIN = "0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630";
const OLD_DEV = "0xaDE3Aa2d388FAB12D92DBff62c2BB7D4D00FBc80";

const OLD_PREMIUM_SETTING = "0xEA267a1F6D554dD416d26c60eFef9234ebfde95e";
const NEW_PREMIUM_SETTING = "0x8a87bA5f4Af63B2c80d3ddc5B9cb2B789F08FA15";
const OLD_DEFAULT_PROXY_ADMIN = "0x26e78E0A15ebBC48065Ed0527D74F28D1B53a1B6";
const NEW_DEFAULT_PROXY_ADMIN = "0x87006D0F171332AFfe9c7D2DA6e9Da1f1ABDE1AA";

const NEW_PAYMENT = "0x01C6a8dF590E706B8482B11c977757F5d52FCc3c";
const NEW_TOKEN_WHITELIST = "0x521D48eA3763Eed6A32B89fA8f7F6D5ad21108a1";
const NEW_PREMIUM_REGISTRY = "0x2A2280e3c90F09A3045CEDB95C628DEE58C62361";
const NEW_BANNER = "0x9055140Be419cC91e3C48EA005658D1D11C245b7";

const TIME_LOCK_ROUTER = "0x04FB4160c519578E310ee9cC7b966B88291E5F20";
const TRANSFER_LEGACY_ROUTER = "0x0389ba9a54AeF2dA4F91bDd9Ef9fb37ACB73ED63";
const TRANSFER_EOA_LEGACY_ROUTER = "0xf9DCB3FE1D2E0a0F94b42902fd64db1E1F4e2a32";
const MULTISIG_LEGACY_ROUTER = "0x48d4bdfE44C4a5A9ea6EAf00edEA8D31fA92CFD3";
const LEGACY_DEPLOYER = "0x35AAD44F04e3d2A29f5257C8F00Fe0DCe17cE4eb";

const PREMIUM_MAIL_ROUTER = "0x6F5F15E9b23D3f62E2FEb61d70E1EcBC72C45F5E"; // may vary
const PREMIUM_AUTOMATION_MANAGER = "0x88f08Cf6cD4bF6f915bA7a2eA1a2C2c79d31f66b"; // may vary

async function readOwner(name: string, address: string) {
  try {
    const c = await ethers.getContractAt("OwnableUpgradeable", address);
    const owner = await c.owner();
    const isYou = owner.toLowerCase() === EXPECTED_ADMIN.toLowerCase();
    const isOld = owner.toLowerCase() === OLD_DEV.toLowerCase();
    const tag = isYou ? "YOU" : isOld ? "OLD_DEV" : "OTHER";
    console.log(`  ${name.padEnd(32)} owner = ${owner} [${tag}]`);
  } catch (e: any) {
    console.log(`  ${name.padEnd(32)} owner UNREADABLE (${e.message?.slice(0, 60)})`);
  }
}

async function readProxyAdmin(name: string, proxyAddress: string) {
  try {
    // EIP1967 admin slot
    const slot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
    const raw = await ethers.provider.getStorage(proxyAddress, slot);
    const admin = "0x" + raw.slice(26);
    console.log(`  ${name.padEnd(32)} proxyAdmin = ${admin}`);
  } catch (e: any) {
    console.log(`  ${name.padEnd(32)} proxyAdmin UNREADABLE`);
  }
}

async function readRef(name: string, address: string, method: string, sig: string[]) {
  try {
    const c = await ethers.getContractAt(sig, address);
    const val = await (c as any)[method]();
    console.log(`  ${name.padEnd(32)} ${method}() = ${val}`);
    return val;
  } catch (e: any) {
    console.log(`  ${name.padEnd(32)} ${method}() UNREADABLE (${e.message?.slice(0, 60)})`);
    return null;
  }
}

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Signer:", await signer.getAddress());
  console.log("");
  console.log("=== OWNERSHIP ===");
  await readOwner("OLD PremiumSetting", OLD_PREMIUM_SETTING);
  await readOwner("NEW PremiumSetting", NEW_PREMIUM_SETTING);
  await readOwner("OLD DefaultProxyAdmin", OLD_DEFAULT_PROXY_ADMIN);
  await readOwner("NEW DefaultProxyAdmin", NEW_DEFAULT_PROXY_ADMIN);
  await readOwner("NEW Banner", NEW_BANNER);
  await readOwner("NEW PremiumRegistry", NEW_PREMIUM_REGISTRY);
  await readOwner("NEW Payment (ownable?)", NEW_PAYMENT);
  await readOwner("NEW TokenWhiteList (ownable?)", NEW_TOKEN_WHITELIST);
  await readOwner("TimeLockRouter", TIME_LOCK_ROUTER);
  await readOwner("TransferLegacyRouter", TRANSFER_LEGACY_ROUTER);
  await readOwner("TransferEOALegacyRouter", TRANSFER_EOA_LEGACY_ROUTER);
  await readOwner("MultisigLegacyRouter", MULTISIG_LEGACY_ROUTER);
  await readOwner("LegacyDeployer", LEGACY_DEPLOYER);

  console.log("\n=== PROXY ADMINS ===");
  await readProxyAdmin("NEW Banner", NEW_BANNER);
  await readProxyAdmin("NEW PremiumRegistry", NEW_PREMIUM_REGISTRY);
  await readProxyAdmin("OLD PremiumSetting", OLD_PREMIUM_SETTING);
  await readProxyAdmin("NEW PremiumSetting", NEW_PREMIUM_SETTING);

  console.log("\n=== OLD PremiumSetting WIRING ===");
  const sig = [
    "function premiumRegistry() view returns (address)",
    "function transferLegacyContractRouter() view returns (address)",
    "function transferLegacyEOAContractRouter() view returns (address)",
    "function multisigLegacyContractRouter() view returns (address)",
    "function premiumAutomationManager() view returns (address)",
    "function premiumSendMail() view returns (address)",
  ];
  await readRef("OLD PremiumSetting", OLD_PREMIUM_SETTING, "premiumRegistry", sig);
  await readRef("OLD PremiumSetting", OLD_PREMIUM_SETTING, "transferLegacyContractRouter", sig);
  await readRef("OLD PremiumSetting", OLD_PREMIUM_SETTING, "transferLegacyEOAContractRouter", sig);
  await readRef("OLD PremiumSetting", OLD_PREMIUM_SETTING, "multisigLegacyContractRouter", sig);
  await readRef("OLD PremiumSetting", OLD_PREMIUM_SETTING, "premiumAutomationManager", sig);
  await readRef("OLD PremiumSetting", OLD_PREMIUM_SETTING, "premiumSendMail", sig);

  console.log("\n=== ROUTER -> PremiumSetting / Payment refs ===");
  const rSig = [
    "function premiumSetting() view returns (address)",
    "function paymentContract() view returns (address)",
    "function tokenWhitelist() view returns (address)",
  ];
  await readRef("TimeLockRouter", TIME_LOCK_ROUTER, "tokenWhitelist", rSig);
  await readRef("TransferLegacyRouter", TRANSFER_LEGACY_ROUTER, "premiumSetting", rSig);
  await readRef("TransferLegacyRouter", TRANSFER_LEGACY_ROUTER, "paymentContract", rSig);
  await readRef("TransferEOALegacyRouter", TRANSFER_EOA_LEGACY_ROUTER, "premiumSetting", rSig);
  await readRef("TransferEOALegacyRouter", TRANSFER_EOA_LEGACY_ROUTER, "paymentContract", rSig);
  await readRef("MultisigLegacyRouter", MULTISIG_LEGACY_ROUTER, "premiumSetting", rSig);

  console.log("\n=== NEW PremiumRegistry internal refs ===");
  const prSig = [
    "function premiumSetting() view returns (address)",
    "function payment() view returns (address)",
  ];
  await readRef("NEW PremiumRegistry", NEW_PREMIUM_REGISTRY, "premiumSetting", prSig);
  await readRef("NEW PremiumRegistry", NEW_PREMIUM_REGISTRY, "payment", prSig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

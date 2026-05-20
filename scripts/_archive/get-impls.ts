import { ethers } from "hardhat";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const ADDRS: Record<string, string> = {
  WIRED_Payment: "0xd4bf99da7fBcb0A2Fd80754cB5CC9c7CDc9e8D78",
  WIRED_TokenWhiteList: "0xE7e5011263e862f964F608C26654edAD25497B8F",
  WIRED_PremiumRegistry: "0xC3c59ab1a146Da758fEf1f68Bd5F14189e5d0246",
  NEW_Banner: "0x9055140Be419cC91e3C48EA005658D1D11C245b7",
  OLD_PremiumSetting: "0xEA267a1F6D554dD416d26c60eFef9234ebfde95e",
  WIRED_USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  WIRED_USDT: "0x02f62735EaF5fFB56B629bC529e72801713f27cd",
  OLD_DefaultProxyAdmin: "0x26e78E0A15ebBC48065Ed0527D74F28D1B53a1B6",
};

async function main() {
  for (const [name, addr] of Object.entries(ADDRS)) {
    const implRaw = await (ethers.provider as any).getStorageAt(addr, IMPL_SLOT);
    const adminRaw = await (ethers.provider as any).getStorageAt(addr, ADMIN_SLOT);
    const impl = "0x" + implRaw.slice(26);
    const admin = "0x" + adminRaw.slice(26);
    const code = await ethers.provider.getCode(addr);
    const isProxy = impl !== "0x0000000000000000000000000000000000000000";
    console.log(
      `${name.padEnd(30)} ${addr} impl=${impl} admin=${admin} isProxy=${isProxy} codeSize=${(code.length - 2) / 2}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

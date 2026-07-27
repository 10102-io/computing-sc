/** Decode-level probe: are the v2 functions really live on the routers? */
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

async function main() {
  const contracts = getContracts()[hre.network.name];

  const eoa = await ethers.getContractAt("TransferEOALegacyRouter", contracts["TransferEOALegacyRouter"].address);
  try {
    const d = await eoa.eip712Domain();
    console.log(`EOA router eip712Domain: LIVE -> name="${d.name}" version="${d.version}"`);
  } catch (e: any) {
    console.log(`EOA router eip712Domain: NOT LIVE (${(e.message ?? "").slice(0, 80)})`);
  }

  const tl = await ethers.getContractAt("TimeLockRouter", contracts["TimeLockRouter"].address);
  try {
    const s = await tl.sponsoredDomainSeparator();
    console.log(`TimeLockRouter sponsoredDomainSeparator: LIVE -> ${s}`);
  } catch (e: any) {
    console.log(`TimeLockRouter sponsoredDomainSeparator: NOT LIVE (${(e.message ?? "").slice(0, 80)})`);
  }

  // createLegacyV2 selector probe via getError on a static call with garbage
  const iface = new ethers.utils.Interface(["function sponsorNonce(address) view returns (uint256)"]);
  for (const [label, addr] of [
    ["EOA router", contracts["TransferEOALegacyRouter"].address],
    ["TimeLockRouter", contracts["TimeLockRouter"].address]
  ] as const) {
    try {
      const raw = await ethers.provider.call({
        to: addr,
        data: iface.encodeFunctionData("sponsorNonce", [ethers.constants.AddressZero])
      });
      console.log(`${label} sponsorNonce(0): raw=${raw}`);
    } catch (e: any) {
      console.log(`${label} sponsorNonce(0): reverted (${(e.message ?? "").slice(0, 60)})`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

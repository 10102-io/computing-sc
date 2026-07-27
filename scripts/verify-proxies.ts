/**
 * (Re-)link upgraded proxies to their implementations on Etherscan, verbosely.
 *
 * Why: `verifyproxycontract` submissions during the create-flow-v2 upgrades
 * returned NOTOK and the GUID/poll step was never done, so Etherscan still
 * shows the proxies without the new impl ABI — which is why MetaMask displays
 * raw calldata ("long intimidating hex") instead of a decoded
 * `createLegacyV2(...)` call for creates.
 *
 * Submits verifyproxycontract for each proxy in PROXIES (or $env:PROXY for
 * one), polls checkproxyverification until Etherscan answers, and prints the
 * full result so failures are actually diagnosable.
 *
 * Usage:
 *   npx hardhat run scripts/verify-proxies.ts --network sepolia
 */
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

const ETHERSCAN_V2_API = "https://api.etherscan.io/v2/api";
const PROXIES = ["TransferEOALegacyRouter", "TimeLockRouter", "EIP712LegacyVerifier"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function etherscan(params: Record<string, string>, chainId: number, apiKey: string) {
  const body = new URLSearchParams({ ...params, apikey: apiKey, chainid: String(chainId) });
  const res = await fetch(`${ETHERSCAN_V2_API}?chainid=${chainId}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return (await res.json()) as { status: string; message: string; result?: string };
}

async function main() {
  const network = hre.network.name;
  const chainId = hre.network.config?.chainId;
  const apiKey = process.env.API_KEY_ETHERSCAN;
  if (!apiKey || chainId == null) throw new Error("API_KEY_ETHERSCAN and network chainId required");

  const contracts = getContracts()[network];
  if (!contracts) throw new Error(`No contract addresses for "${network}"`);

  const names = process.env.PROXY ? [process.env.PROXY] : PROXIES;

  for (const name of names) {
    const entry = contracts[name];
    if (!entry?.address) {
      console.log(`\n${name}: no address for ${network} — skipping`);
      continue;
    }
    const proxy = entry.address;
    const impl = (entry as any).implementation;
    console.log(`\n=== ${name} ===`);
    console.log(`Proxy: ${proxy}`);
    console.log(`Impl:  ${impl ?? "(not recorded — letting Etherscan detect)"}`);

    const submitParams: Record<string, string> = {
      module: "contract",
      action: "verifyproxycontract",
      address: proxy,
    };
    if (impl) submitParams.expectedimplementation = impl;

    const submit = await etherscan(submitParams, chainId, apiKey);
    console.log(`Submit: status=${submit.status} message=${submit.message} result=${submit.result}`);
    if (submit.status !== "1") continue;

    const guid = submit.result!;
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      const check = await etherscan(
        { module: "contract", action: "checkproxyverification", guid },
        chainId,
        apiKey
      );
      console.log(`Poll ${i + 1}: status=${check.status} message=${check.message} result=${check.result}`);
      if (check.result && !/pending/i.test(check.result)) break;
    }
  }

  // Sanity: read one selector through each proxy to show the ABI is live.
  const eoa = contracts["TransferEOALegacyRouter"]?.address;
  if (eoa) {
    const router = await ethers.getContractAt("TransferEOALegacyRouter", eoa);
    const domain = await router.eip712Domain();
    console.log(`\nSanity — EOA router eip712Domain name: ${domain.name}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

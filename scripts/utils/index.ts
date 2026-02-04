import * as fs from "fs";
import * as path from "path";
import { Wallet } from "ethers";
import { JsonRpcProvider } from "@ethersproject/providers";

const CONTRACT_ADDRESSES_PATH = path.join(process.cwd(), "contract-addresses.json");

export interface ContractEntry {
  address: string;
  implementation?: string;
}

export type ContractAddresses = Record<string, Record<string, ContractEntry>>;

function readContractAddresses(): ContractAddresses {
  try {
    const data = fs.readFileSync(CONTRACT_ADDRESSES_PATH, "utf-8");
    return JSON.parse(data) as ContractAddresses;
  } catch {
    return {};
  }
}

function writeContractAddresses(data: ContractAddresses): void {
  fs.writeFileSync(CONTRACT_ADDRESSES_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function getContracts(): ContractAddresses {
  return readContractAddresses();
}

export function saveContract(
  networkName: string,
  contractName: string,
  address: string,
  implementation?: string
): void {
  const data = readContractAddresses();
  if (!data[networkName]) {
    data[networkName] = {};
  }
  data[networkName][contractName] = { address, ...(implementation && { implementation }) };
  writeContractAddresses(data);
}

export function getProvider(): { provider: JsonRpcProvider; wallet: Wallet } {
  const rpc = process.env.RPC;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!rpc || !pk) {
    throw new Error("Set RPC and DEPLOYER_PRIVATE_KEY in .env");
  }
  const provider = new JsonRpcProvider(rpc);
  const wallet = new Wallet(pk.trim(), provider);
  return { provider, wallet };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** RPC URL for deployments: env RPC or network config url (e.g. when using --network sepolia). */
export function getRpcUrl(networkConfig: { url?: string }): string {
  const url = process.env.RPC ?? networkConfig.url;
  if (!url) {
    throw new Error("Set RPC in .env or use a network with a url (e.g. --network sepolia)");
  }
  return url;
}

/** Etherscan v2 API URL for proxy verification (multi-chain). */
const ETHERSCAN_V2_API = "https://api.etherscan.io/v2/api";

/**
 * Link proxy to implementation on Etherscan so the proxy page shows "Proxy" and links to implementation.
 * Uses Etherscan v2 API verifyproxycontract. Requires API_KEY_ETHERSCAN in env.
 */
export async function verifyProxyOnEtherscan(
  proxyAddress: string,
  expectedImplementation: string,
  chainId: number,
  apiKey: string
): Promise<{ success: boolean; message: string }> {
  const params = new URLSearchParams({
    apikey: apiKey,
    chainid: String(chainId),
    module: "contract",
    action: "verifyproxycontract",
    contractaddress: proxyAddress,
    expectedimplementation: expectedImplementation,
  });
  const res = await fetch(ETHERSCAN_V2_API, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const json = (await res.json()) as { status: string; message: string; result?: string };
  const ok = json.status === "1" || json.message?.toLowerCase().includes("success");
  return { success: ok, message: json.message ?? JSON.stringify(json) };
}

export { genMessage } from "./genMsg";

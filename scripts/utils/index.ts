import * as fs from "fs";
import * as path from "path";
import {
  EXTERNAL_ADDRESSES,
  ExternalAddresses,
} from "../../config/external-addresses";
import { Wallet, providers } from "ethers";

const CONTRACT_ADDRESSES_PATH = path.join(process.cwd(), "contract-addresses.json");

/**
 * Returns external contract addresses for the given network.
 * When forking (e.g. hardhat with fork-block.json), set EXTERNAL_ADDRESSES_NETWORK=sepolia
 * (or the forked network) in .env to use that network's addresses instead of hardhat zeros.
 */
export function getExternalAddresses(networkName: string): ExternalAddresses {
  const override =
    networkName === "hardhat" || networkName === "localhost"
      ? process.env.EXTERNAL_ADDRESSES_NETWORK
      : undefined;
  const key = override ?? networkName;
  const addresses = EXTERNAL_ADDRESSES[key];
  if (!addresses) {
    throw new Error(
      `No external addresses for network "${networkName}"${override ? ` (override EXTERNAL_ADDRESSES_NETWORK=${override})` : ""}. ` +
      `Add an entry in config/external-addresses.ts for "${key}".`
    );
  }
  return addresses;
}

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

/** Canonical key for local chain (chainId 31337). Both hardhat and localhost map here. */
const LOCAL_CHAIN_KEY = 'localhost';

export function saveContract(
  networkName: string,
  contractName: string,
  address: string,
  implementation?: string
): void {
  const key = networkName === 'hardhat' ? LOCAL_CHAIN_KEY : networkName;
  const data = readContractAddresses();
  if (!data[key]) {
    data[key] = {};
  }
  data[key][contractName] = { address, ...(implementation && { implementation }) };
  writeContractAddresses(data);
}

export function getProvider(): { provider: providers.JsonRpcProvider; wallet: Wallet } {
  const rpc = process.env.RPC;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!rpc || !pk) {
    throw new Error("Set RPC and DEPLOYER_PRIVATE_KEY in .env");
  }
  const provider = new providers.JsonRpcProvider(rpc);
  const wallet = new Wallet(pk.trim(), provider);
  return { provider, wallet };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Networks where we deploy test ERC20 tokens (hardhat, localhost, testnets). */
export const RUN_TEST_ERC20_NETWORKS: readonly string[] = [
  "hardhat",
  "localhost",
  "sepolia",
];

export function shouldRunTestERC20(networkName: string): boolean {
  return (RUN_TEST_ERC20_NETWORKS as readonly string[]).includes(networkName);
}

/** True when the network supports Etherscan verification (skip for local chains). */
export function shouldVerify(networkName: string): boolean {
  return networkName !== "hardhat" && networkName !== "localhost";
}

/** Default gas price bump (percent) for non-local networks to avoid REPLACEMENT_UNDERPRICED. */
const GAS_PRICE_BUMP_PERCENT = 25;

/**
 * Returns current gas price with bump for non-local deploys (avoids replacement underpriced errors).
 * Uses Web3 (not ethers) for consistency with deploy scripts.
 */
export async function getBumpedGasPrice(web3: { eth: { getGasPrice: () => Promise<string | bigint> } }): Promise<string> {
  const current = await web3.eth.getGasPrice();
  const bumped = (Number(current) * (100 + GAS_PRICE_BUMP_PERCENT)) / 100;
  return String(Math.ceil(bumped));
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

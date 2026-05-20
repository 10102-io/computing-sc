import * as https from "https";

// Checks Sepolia etherscan verification status for every address currently
// wired into contract-addresses.json (sepolia section), plus every
// implementation behind a proxy. Pure read-only; uses the Etherscan v2 API.

const CHAIN_ID = 11155111;
const API_KEY = process.env.API_KEY_ETHERSCAN;
if (!API_KEY) {
  console.error(
    "Set API_KEY_ETHERSCAN in .env (same key used by hardhat-etherscan)."
  );
  process.exit(1);
}

// Pulled from contract-addresses.json sepolia section. Proxy -> impl pairs
// where implementations exist, plus plain addresses for non-proxy contracts.
const TARGETS: Array<{ name: string; address: string; impl?: string }> = [
  { name: "Payment", address: "0xd4bf99da7fBcb0A2Fd80754cB5CC9c7CDc9e8D78" },
  { name: "ERC20Token_USDC", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  { name: "ERC20Token_USDT", address: "0x02f62735EaF5fFB56B629bC529e72801713f27cd" },
  { name: "DefaultProxyAdmin", address: "0x26e78E0A15ebBC48065Ed0527D74F28D1B53a1B6" },
  { name: "EIP712LegacyVerifier", address: "0x36e4A2f7d7c3Be6Bd8179FA110eFd9548E893442", impl: "0x41E34E7E9d1E18864e807e655A6961F5217f37c0" },
  { name: "LegacyDeployer", address: "0x0D33b36836d05549Cbd18379BC488D1Db90CEB07", impl: "0xb1c54eD206f52e02B0324C82aEA676D4A8058303" },
  { name: "PremiumSetting", address: "0xEA267a1F6D554dD416d26c60eFef9234ebfde95e", impl: "0x1b544634873112843C0b68C2103f03FA4dfC7307" },
  { name: "MultisigLegacyRouter", address: "0x5a160b5fBFeAd9CCE7276E108F7dE614B922C5f5", impl: "0x72037c89F1ba5257916399B38104287009F41e05" },
  { name: "TransferLegacyRouter", address: "0x5Bd94c5ce2F9e703c911d77919856Bf6010f1b5e", impl: "0xd2ac5D33f9409d63Debfa15022ba8C23b31159e0" },
  { name: "TransferEOALegacyRouter", address: "0xF9Eb0EB6B547c67413484FBD9856684F950768A7", impl: "0x79EcE3031d6596A8aBAEC5986A2a8dca4305eC46" },
  { name: "PremiumRegistry", address: "0xC3c59ab1a146Da758fEf1f68Bd5F14189e5d0246", impl: "0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b" },
  { name: "PremiumAutomationManager", address: "0x5B2e634D1a22E74902408EA25D6E221B8A1DfcDE", impl: "0xd7Dcf3357B9d30D59eF7A6A435149d8b865F979C" },
  { name: "PremiumMailRouter", address: "0xceB74D10Db8b3050fb2FA10694d25f58d58Ac76f", impl: "0xE3500b7123Cd57C0699ea3f8c011d9e73ECb6E3b" },
  { name: "PremiumMailBeforeActivation", address: "0x7e82bc3a67B7126869Dc556B367c1907F1622328", impl: "0xBe00Cf1C975A14A4b88bFb68Fc3A7966D84bf679" },
  { name: "PremiumMailActivated", address: "0x215c1F50670cA4C7178892f986eDAf6c259454f6", impl: "0xf115cf377e6Ba89347fD816154277877faC5971F" },
  { name: "PremiumMailReadyToActivate", address: "0x6678e119171Ca872A91634Eb4F8ed0851040ADe2", impl: "0x75f2C582B411907bF6a8dD062c4DEb06124d43A4" },
  { name: "TokenWhiteList", address: "0xE7e5011263e862f964F608C26654edAD25497B8F" },
  { name: "Banner", address: "0x9055140Be419cC91e3C48EA005658D1D11C245b7", impl: "0xD4099787c0491eE85CFbb6f1D8C7f07aF8BdA84f" },
  { name: "TimeLockRouter", address: "0x04FB4160c519578E310ee9cC7b966B88291E5F20", impl: "0x296Cfff4Ad123F978a70A6fBB30d5607dfCBbA05" },
  { name: "TimelockERC20", address: "0xB7860eA69109142Bcf7ff4BC0FE52460D96a29B8", impl: "0xe64311c7F9e15C7fE3d99faa3b44FEf3801610Bc" },
  { name: "TimelockERC721", address: "0x01D55e60D5f64b9F720B31F5bd729d3c09ff965E", impl: "0x4a7D78C83097aB0030EF9fA429Dc495d25bA39b4" },
  { name: "TimelockERC1155", address: "0x0B8B48b6be196F2C5e761C3b4fF508AD5b57f7b4", impl: "0x2db53a8e8aF1456Dca01529C048F3063F93Ea553" },
];

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

async function isVerified(
  addr: string,
  attempt = 0
): Promise<{
  verified: boolean;
  name?: string;
  compiler?: string;
  raw: string;
}> {
  const url =
    `https://api.etherscan.io/v2/api?chainid=${CHAIN_ID}` +
    `&module=contract&action=getsourcecode&address=${addr}&apikey=${API_KEY}`;
  const body = await httpGet(url);
  const parsed = JSON.parse(body);
  // Etherscan returns status "0" + "NOTOK" message on rate-limit. Retry with
  // backoff up to 3 times before concluding.
  if (parsed?.status === "0" && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return isVerified(addr, attempt + 1);
  }
  const result = parsed?.result?.[0];
  if (!result) return { verified: false, raw: body };
  const source = result.SourceCode as string;
  if (!source || source.length === 0) {
    return { verified: false, raw: body };
  }
  return {
    verified: true,
    name: result.ContractName,
    compiler: result.CompilerVersion,
    raw: body,
  };
}

async function main() {
  const unverified: string[] = [];
  for (const t of TARGETS) {
    const proxy = await isVerified(t.address);
    const proxyTag = proxy.verified
      ? `verified (${proxy.name})`
      : "UNVERIFIED";
    let line = `${t.name.padEnd(30)} ${t.address}  ${proxyTag}`;
    if (!proxy.verified) unverified.push(`${t.name} proxy ${t.address}`);

    if (t.impl) {
      await new Promise((r) => setTimeout(r, 500));
      const impl = await isVerified(t.impl);
      const implTag = impl.verified
        ? `impl verified (${impl.name})`
        : "IMPL UNVERIFIED";
      line += `\n${" ".repeat(32)}impl: ${t.impl}  ${implTag}`;
      if (!impl.verified) unverified.push(`${t.name} impl ${t.impl}`);
    }
    console.log(line);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("\n---\n");
  if (unverified.length === 0) {
    console.log("All wired Sepolia contracts are verified.");
  } else {
    console.log(`Unverified (${unverified.length}):`);
    for (const u of unverified) console.log(`  - ${u}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

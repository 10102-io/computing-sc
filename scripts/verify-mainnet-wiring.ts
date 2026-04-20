import { ethers } from "hardhat";

// Read-only: check which Payment / PremiumRegistry / Banner the wired mainnet
// ecosystem actually points at. We compare two candidate sets:
//   ENV (from computing .env.example / admin .env.example):
//     Payment           0x5c0A7431d91ea7C413D8CFFa1DEE06f433695525
//     Banner            0x41722280986D3CeBb6c374157e67f21AfF7F9b69
//     PremiumRegistry   0x02db8AfFcFa3785e2f0ABB8B9c0B18F610a8E65d
//   JSON (from contract-addresses.json):
//     Payment           0x4807C7B2e6E3913b5280c711Bab7B0465d347de4
//     Banner            0x4F2fcaFaCD6FAEE5F6Aa8FD862f985420C3eBCe8
//     PremiumRegistry   0x44Ae934Ef4a30FF11f9665174dDFa9F0c93bEA27

const MULTISIG_ROUTER = "0x7c7bf503DF70eBE3520f65Cc0Ff1aF093Fa85038";
const TIME_LOCK_ROUTER = "0x2B947E3c348c81409f8e8fc5ef8F65d9dFf76A42";
const PREMIUM_SETTING = "0x5223E0D4D1f0BE6Bf5De7cA6D2Fa9BFB6447013f";

const CANDIDATES = {
  Payment: {
    env: "0x5c0A7431d91ea7C413D8CFFa1DEE06f433695525",
    json: "0x4807C7B2e6E3913b5280c711Bab7B0465d347de4",
  },
  Banner: {
    env: "0x41722280986D3CeBb6c374157e67f21AfF7F9b69",
    json: "0x4F2fcaFaCD6FAEE5F6Aa8FD862f985420C3eBCe8",
  },
  PremiumRegistry: {
    env: "0x02db8AfFcFa3785e2f0ABB8B9c0B18F610a8E65d",
    json: "0x44Ae934Ef4a30FF11f9665174dDFa9F0c93bEA27",
  },
};

async function tryCall(
  target: string,
  abiSig: string,
  label: string
): Promise<string | null> {
  try {
    const c = await ethers.getContractAt([abiSig], target);
    const fn = abiSig.match(/function\s+(\w+)/)?.[1];
    if (!fn) return null;
    const v = await (c as any)[fn]();
    console.log(`  ${label}.${fn}() = ${v}`);
    return String(v);
  } catch (e: any) {
    console.log(`  ${label}.${abiSig}: revert`);
    return null;
  }
}

async function main() {
  const net = await ethers.provider.getNetwork();
  console.log(`chain: ${net.chainId} ${net.name}`);

  console.log("\n--- MultisigLegacyRouter ---");
  await tryCall(
    MULTISIG_ROUTER,
    "function paymentContract() view returns (address)",
    "MultisigLegacyRouter"
  );
  await tryCall(
    MULTISIG_ROUTER,
    "function premiumSetting() view returns (address)",
    "MultisigLegacyRouter"
  );

  console.log("\n--- TimeLockRouter ---");
  await tryCall(
    TIME_LOCK_ROUTER,
    "function paymentContract() view returns (address)",
    "TimeLockRouter"
  );
  await tryCall(
    TIME_LOCK_ROUTER,
    "function tokenWhitelist() view returns (address)",
    "TimeLockRouter"
  );

  console.log("\n--- PremiumSetting ---");
  await tryCall(
    PREMIUM_SETTING,
    "function premiumRegistry() view returns (address)",
    "PremiumSetting"
  );

  console.log("\n--- Ownership/state check for candidates ---");
  const probes = [
    "function owner() view returns (address)",
    "function getFee() view returns (uint256)",
    "function getNextPlanId() view returns (uint256)",
  ];
  for (const [name, pair] of Object.entries(CANDIDATES)) {
    for (const [src, addr] of Object.entries(pair)) {
      const code = await ethers.provider.getCode(addr);
      console.log(`  ${name} [${src}] ${addr} ${code === "0x" ? "(no code)" : ""}`);
      if (code === "0x") continue;
      for (const sig of probes) {
        await tryCall(addr, sig, `    ${name}[${src}]`);
      }
    }
  }

  console.log("\n--- Payment wiring (PremiumSetting) ---");
  for (const sig of [
    "function payment() view returns (address)",
    "function paymentContract() view returns (address)",
    "function paymentAddress() view returns (address)",
  ]) {
    await tryCall(PREMIUM_SETTING, sig, "PremiumSetting");
  }

  console.log("\n--- Banner check: AccessControl admin ---");
  const ADMIN = "0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630";
  for (const [name, pair] of Object.entries(CANDIDATES)) {
    for (const [src, addr] of Object.entries(pair)) {
      try {
        const c = await ethers.getContractAt(
          [
            "function hasRole(bytes32,address) view returns (bool)",
            "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
          ],
          addr
        );
        const r = await (c as any).DEFAULT_ADMIN_ROLE();
        const h = await (c as any).hasRole(r, ADMIN);
        console.log(`  ${name} [${src}] DEFAULT_ADMIN_ROLE(${ADMIN}) = ${h}`);
      } catch {
        console.log(`  ${name} [${src}] no AccessControl`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

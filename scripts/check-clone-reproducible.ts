/**
 * Proves that a clone implementation's deployed bytecode is reproducible from
 * the minimal standard-JSON input Etherscan and Sourcify receive, i.e. that it
 * will verify. Recompiles the artifact's own build-info input with the cached
 * native solc and compares the runtime bytecode byte for byte; then compiles
 * the same contract inside the repo-wide input (every contract in one job, the
 * shape that produced the unverifiable April 2026 target) and reports whether
 * unrelated files shift its bytecode.
 *
 *   npx hardhat run scripts/check-clone-reproducible.ts
 *   $env:CLONE="contracts/forwarding/TransferLegacyEOAContractV3.sol:TransferEOALegacyV3"; npx hardhat run scripts/check-clone-reproducible.ts
 *
 * Read-only: compiles in a temp directory, sends nothing, reads no keys.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { artifacts } from "hardhat";

const DEFAULT = "contracts/forwarding/TransferLegacyEOAContract.sol:TransferEOALegacy";

function findSolc(version: string): string {
  const root = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".cache"), "hardhat-nodejs", "Cache", "compilers-v2");
  for (const platform of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, platform);
    const hit = fs.readdirSync(dir).find((f) => f.includes(`v${version}+`) && !f.endsWith(".does.not.work"));
    if (hit) return path.join(dir, hit);
  }
  throw new Error(`solc ${version} not found in the Hardhat compiler cache; run npx hardhat compile first.`);
}

function compile(solc: string, input: unknown): any {
  const out = execFileSync(solc, ["--standard-json"], { input: JSON.stringify(input), maxBuffer: 512 * 1024 * 1024 });
  const json = JSON.parse(out.toString());
  const errors = (json.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: any) => e.formattedMessage).join("\n"));
  return json;
}

async function main() {
  const fq = process.env.CLONE ?? DEFAULT;
  const [sourceName, contractName] = fq.split(":");
  const artifact = await artifacts.readArtifact(fq);
  const buildInfo = await artifacts.getBuildInfo(fq);
  if (!buildInfo) throw new Error(`No build info for ${fq}`);
  const solc = findSolc(buildInfo.solcVersion);
  const expected = artifact.deployedBytecode.toLowerCase();

  const sources = Object.keys(buildInfo.input.sources);
  console.log(`${fq}: ${(expected.length - 2) / 2} bytes, job of ${sources.length} sources, solc ${buildInfo.solcLongVersion}`);

  const minimal = compile(solc, buildInfo.input);
  const got = ("0x" + minimal.contracts[sourceName][contractName].evm.deployedBytecode.object).toLowerCase();
  const reproducible = got === expected;
  console.log(`  minimal input (what verification submits): ${reproducible ? "IDENTICAL" : "DIFFERENT"}`);

  // Repo-wide input: every .sol under contracts/ plus whatever they import,
  // resolved from the other build-infos Hardhat already wrote.
  const allSources: Record<string, { content: string }> = {};
  const biDir = path.join(__dirname, "..", "artifacts", "build-info");
  for (const f of fs.readdirSync(biDir)) {
    const bi = JSON.parse(fs.readFileSync(path.join(biDir, f), "utf-8"));
    for (const [name, src] of Object.entries<any>(bi.input.sources)) allSources[name] = { content: src.content };
  }
  const wide = compile(solc, { ...buildInfo.input, sources: allSources });
  const wideGot = ("0x" + wide.contracts[sourceName][contractName].evm.deployedBytecode.object).toLowerCase();
  console.log(
    `  repo-wide input (${Object.keys(allSources).length} sources): ${wideGot === expected ? "identical" : `DIFFERENT (${(wideGot.length - 2) / 2} bytes)`}`
  );

  if (!reproducible) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

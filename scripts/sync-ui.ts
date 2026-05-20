/**
 * Sync UI: reads contract-addresses.json and deployments/<network>/, writes
 * contract-addresses.generated.ts, ABI files, and subgraph networks to output/sync-ui/.
 *
 * Modes (positional / flag args after `npm run sync-ui --`):
 *   (default)  Generate output/sync-ui/ only. Print copy instructions.
 *   --check    Generate, then diff against sibling repos. Exit 1 with a
 *              human-readable drift report if anything is out of sync.
 *              Use this in CI / pre-deploy gates.
 *   --write    Generate, then copy / merge directly into sibling repos. The
 *              expected layout is:
 *                computing-sc/      (this repo)
 *                computing/         (UI)
 *                computing-admin/   (admin UI)
 *                computing-subgraph/(subgraph)
 *              Override sibling locations with environment variables:
 *                UI_REPO_PATH, ADMIN_REPO_PATH, SUBGRAPH_REPO_PATH
 *
 * Drift is the #1 source of post-deploy regressions in this project — every
 * release that mutates contract-addresses.json should run --write (or --check
 * in CI) before merging. See deployments/CHANGELOG.md for past incidents.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';

const CONTRACTS_ROOT = path.join(__dirname, '..');
const OUTPUT_ROOT = path.join(CONTRACTS_ROOT, 'output', 'sync-ui');
const CONTRACT_ADDRESSES_PATH = path.join(CONTRACTS_ROOT, 'contract-addresses.json');
const DEPLOYMENTS_DIR = path.join(CONTRACTS_ROOT, 'deployments');

const ARGS = process.argv.slice(2);
const MODE_CHECK = ARGS.includes('--check');
const MODE_WRITE = ARGS.includes('--write');

const SISTER_REPOS = {
  ui: process.env.UI_REPO_PATH ?? path.join(CONTRACTS_ROOT, '..', 'computing'),
  admin: process.env.ADMIN_REPO_PATH ?? path.join(CONTRACTS_ROOT, '..', 'computing-admin'),
  subgraph: process.env.SUBGRAPH_REPO_PATH ?? path.join(CONTRACTS_ROOT, '..', 'computing-subgraph'),
};

const SISTER_TARGETS = {
  ui: path.join(SISTER_REPOS.ui, 'src', 'configs', 'contract-addresses.generated.ts'),
  admin: path.join(SISTER_REPOS.admin, 'src', 'configs', 'contract-addresses.generated.ts'),
  subgraphNetworks: path.join(SISTER_REPOS.subgraph, 'networks.json'),
};

const NETWORK_CHAIN_IDS: Record<string, number> = {
  localhost: 31337,
  sepolia: 11155111,
  mainnet: 1,
};

interface ContractEntry {
  address: string;
  implementation?: string;
}

type ContractAddressesJson = Record<string, Record<string, ContractEntry>>;

/** Subgraph networks.json fragment: network -> dataSourceName -> { address, startBlock? }. */
type SubgraphNetworksOutput = Record<string, Record<string, { address: string; startBlock?: number }>>;

interface UIContractAddresses {
  inheritance: string | null;
  forwarding: string | null;
  forwardingEOA: string | null;
  legacyAgreement: string | null;
  premiumSetting: string | null;
  premiumRegistry: string | null;
  timeLockERC20: string | null;
  timeLockERC721: string | null;
  timeLockERC1155: string | null;
  timeLock: string | null;
  timelockRouter: string | null;
  usdcAddress: string | null;
  usdtAddress: string | null;
  tokenWhitelist: string | null;
}

const CONTRACT_TO_UI_KEY: Record<string, keyof UIContractAddresses> = {
  MultisigLegacyRouter: 'inheritance',
  TransferLegacyRouter: 'forwarding',
  TransferEOALegacyRouter: 'forwardingEOA',
  EIP712LegacyVerifier: 'legacyAgreement',
  PremiumSetting: 'premiumSetting',
  PremiumRegistry: 'premiumRegistry',
  TimelockERC20: 'timeLockERC20',
  TimelockERC721: 'timeLockERC721',
  TimelockERC1155: 'timeLockERC1155',
  TimeLockRouter: 'timeLock',
  ERC20Token_USDC: 'usdcAddress',
  ERC20Token_USDT: 'usdtAddress',
  TokenWhiteList: 'tokenWhitelist',
};

function checksum(addr: string | undefined): string | null {
  if (!addr || typeof addr !== 'string') return null;
  try {
    return ethers.utils.getAddress(addr);
  } catch {
    return null;
  }
}

function buildUIContractAddresses(networkContracts: Record<string, ContractEntry>): UIContractAddresses {
  const out: UIContractAddresses = {
    inheritance: null,
    forwarding: null,
    forwardingEOA: null,
    legacyAgreement: null,
    premiumSetting: null,
    premiumRegistry: null,
    timeLockERC20: null,
    timeLockERC721: null,
    timeLockERC1155: null,
    timeLock: null,
    timelockRouter: null,
    usdcAddress: null,
    usdtAddress: null,
    tokenWhitelist: null,
  };
  for (const [contractName, key] of Object.entries(CONTRACT_TO_UI_KEY)) {
    const entry = networkContracts[contractName];
    if (entry?.address) {
      const addr = checksum(entry.address);
      if (addr) out[key] = addr;
    }
  }
  if (out.timeLock) out.timelockRouter = out.timeLock;
  return out;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getStartBlock(network: string, contractName: string): number | undefined {
  const deploymentsNetwork = path.join(DEPLOYMENTS_DIR, network);
  for (const artifactName of [`${contractName}.json`, `${contractName}_Proxy.json`]) {
    const artifactPath = path.join(deploymentsNetwork, artifactName);
    if (!fs.existsSync(artifactPath)) continue;
    try {
      const content = fs.readFileSync(artifactPath, 'utf-8');
      const parsed = JSON.parse(content) as { receipt?: { blockNumber?: number } };
      const block = parsed.receipt?.blockNumber;
      if (typeof block === 'number') return block;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function writeAddresses(): void {
  const data = fs.readFileSync(CONTRACT_ADDRESSES_PATH, 'utf-8');
  const parsed = JSON.parse(data) as ContractAddressesJson;

  const lines: string[] = [
    '// Generated by scripts/sync-ui.ts — do not edit by hand.',
    '// Copy this file (and sibling dirs) into the UI repo src/ after running npm run sync-ui.',
    '',
    'export type ContractAddressesByChainId = Record<number, {',
    '  inheritance: string | null;',
    '  forwarding: string | null;',
    '  forwardingEOA: string | null;',
    '  legacyAgreement: string | null;',
    '  premiumSetting: string | null;',
    '  premiumRegistry: string | null;',
    '  timeLockERC20: string | null;',
    '  timeLockERC721: string | null;',
    '  timeLockERC1155: string | null;',
    '  timeLock: string | null;',
    '  timelockRouter: string | null;',
    '  usdcAddress: string | null;',
    '  usdtAddress: string | null;',
    '  tokenWhitelist: string | null;',
    '}>;',
    '',
    'export const CONTRACT_ADDRESSES_BY_CHAIN_ID: ContractAddressesByChainId = {',
  ];

  const seenChainIds = new Set<number>();
  if (parsed.hardhat && !parsed.localhost) {
    parsed.localhost = parsed.hardhat;
  }
  for (const [network, chainId] of Object.entries(NETWORK_CHAIN_IDS)) {
    if (seenChainIds.has(chainId)) continue;
    const networkContracts = parsed[network];
    if (!networkContracts) continue;
    seenChainIds.add(chainId);
    const addrs = buildUIContractAddresses(networkContracts);
    lines.push(`  ${chainId}: {`);
    for (const [k, v] of Object.entries(addrs)) {
      const val = v === null ? 'null' : `'${v}'`;
      lines.push(`    ${k}: ${val},`);
    }
    if (addrs.timelockRouter === null && addrs.timeLock) {
      lines.push(`    timelockRouter: '${addrs.timeLock}',`);
    }
    lines.push('  },');
  }

  lines.push('};');
  lines.push('');

  const outPath = path.join(OUTPUT_ROOT, 'configs', 'contract-addresses.generated.ts');
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  console.log('Wrote', path.relative(CONTRACTS_ROOT, outPath));
}

/** Admin UI only needs a subset of contracts per chain (computing-admin). */
const ADMIN_CONTRACT_MAP: Record<string, 'premiumRegistry' | 'payment' | 'configBanner' | 'tokenWhiteList'> = {
  PremiumRegistry: 'premiumRegistry',
  Payment: 'payment',
  Banner: 'configBanner',
  TokenWhiteList: 'tokenWhiteList',
};

function buildAdminContractAddresses(
  networkContracts: Record<string, ContractEntry>
): Record<'premiumRegistry' | 'payment' | 'configBanner' | 'tokenWhiteList', string | null> {
  const out: Record<'premiumRegistry' | 'payment' | 'configBanner' | 'tokenWhiteList', string | null> = {
    premiumRegistry: null,
    payment: null,
    configBanner: null,
    tokenWhiteList: null,
  };
  for (const [contractName, key] of Object.entries(ADMIN_CONTRACT_MAP)) {
    const entry = networkContracts[contractName];
    if (entry?.address) {
      const addr = checksum(entry.address);
      if (addr) out[key] = addr;
    }
  }
  return out;
}

function writeAdminAddresses(): void {
  const data = fs.readFileSync(CONTRACT_ADDRESSES_PATH, 'utf-8');
  const parsed = JSON.parse(data) as ContractAddressesJson;

  const lines: string[] = [
    '// Generated by scripts/sync-ui.ts — do not edit by hand.',
    '// Copy this file to computing-admin/src/configs/contract-addresses.generated.ts',
    '// (replace the existing file there).',
    '',
    'export type AdminContractAddressesByChainId = Record<number, {',
    '  premiumRegistry: string | null;',
    '  payment: string | null;',
    '  configBanner: string | null;',
    '  tokenWhiteList: string | null;',
    '}>;',
    '',
    'export const ADMIN_CONTRACT_ADDRESSES_BY_CHAIN_ID: AdminContractAddressesByChainId = {',
  ];

  const seenChainIds = new Set<number>();
  if (parsed.hardhat && !parsed.localhost) {
    parsed.localhost = parsed.hardhat;
  }
  for (const [network, chainId] of Object.entries(NETWORK_CHAIN_IDS)) {
    if (seenChainIds.has(chainId)) continue;
    const networkContracts = parsed[network];
    if (!networkContracts) continue;
    seenChainIds.add(chainId);
    const addrs = buildAdminContractAddresses(networkContracts);
    lines.push(`  ${chainId}: {`);
    for (const [k, v] of Object.entries(addrs)) {
      const val = v === null ? 'null' : `'${v}'`;
      lines.push(`    ${k}: ${val},`);
    }
    lines.push('  },');
  }

  lines.push('};');
  lines.push('');

  const outPath = path.join(OUTPUT_ROOT, 'configs', 'admin-contract-addresses.generated.ts');
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  console.log('Wrote', path.relative(CONTRACTS_ROOT, outPath));
}

type AbiExportStyle = 'const_as_const' | 'default_export';

const ABI_MAPPINGS: Array<{
  artifact: string;
  outPath: string;
  exportName: string;
  style: AbiExportStyle;
}> = [
    { artifact: 'TokenWhiteList.json', outPath: 'configs/abis/tokenWhitelist.ts', exportName: 'TokenWhitelistAbi', style: 'const_as_const' },
    { artifact: 'PremiumRegistry_Implementation.json', outPath: 'configs/abis/premiumRegistry.ts', exportName: 'PremiumRegistryABI', style: 'default_export' },
    { artifact: 'PremiumSetting_Implementation.json', outPath: 'configs/abis/premiumSetting.ts', exportName: 'PremiumSettingABI', style: 'default_export' },
    { artifact: 'TimeLockRouter_Implementation.json', outPath: 'configs/abis/timelockAbi.ts', exportName: 'TimelockABI', style: 'default_export' },
    { artifact: 'EIP712LegacyVerifier_Implementation.json', outPath: 'configs/abis/legacyAgreement.ts', exportName: 'LegacyAgreementAbi', style: 'default_export' },
    { artifact: 'TimelockERC20_Implementation.json', outPath: 'constants/erc20TimelockAbi.ts', exportName: 'erc20TimelockAbi', style: 'const_as_const' },
    { artifact: 'TimelockERC721_Implementation.json', outPath: 'constants/erc721TimelockAbi.ts', exportName: 'erc721TimelockAbi', style: 'const_as_const' },
    { artifact: 'TimelockERC1155_Implementation.json', outPath: 'constants/erc1155TimelockAbi.ts', exportName: 'erc1155TimelockAbi', style: 'const_as_const' },
    { artifact: 'MultisigLegacyRouter_Implementation.json', outPath: 'configs/abis/legacyAbi.ts', exportName: 'LegacyAbi', style: 'default_export' },
    { artifact: 'TransferLegacyRouter_Implementation.json', outPath: 'configs/abis/legacyRouterAbi.ts', exportName: 'LegacyRouterAbi', style: 'default_export' },
  ];

function writeAbiFile(
  network: string,
  artifactName: string,
  outRelPath: string,
  exportName: string,
  style: AbiExportStyle
): void {
  const deploymentsNetwork = path.join(DEPLOYMENTS_DIR, network);
  const artifactPath = path.join(deploymentsNetwork, artifactName);
  if (!fs.existsSync(artifactPath)) {
    console.warn('Missing artifact, skipping:', artifactName);
    return;
  }
  const content = fs.readFileSync(artifactPath, 'utf-8');
  let abi: unknown;
  try {
    const parsed = JSON.parse(content);
    abi = parsed.abi;
  } catch {
    console.warn('Invalid JSON or missing abi:', artifactName);
    return;
  }
  if (!Array.isArray(abi)) {
    console.warn('abi is not an array:', artifactName);
    return;
  }

  const abiJson = JSON.stringify(abi, null, 2);
  let body: string;
  if (style === 'const_as_const') {
    body = `export const ${exportName} = ${abiJson} as const;\n`;
  } else {
    body = `const ${exportName} = ${abiJson};\n\nexport default ${exportName};\n`;
  }

  const outPath = path.join(OUTPUT_ROOT, outRelPath);
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, body, 'utf-8');
  console.log('Wrote', path.relative(CONTRACTS_ROOT, outPath));
}

function writeAbis(): void {
  const data = fs.readFileSync(CONTRACT_ADDRESSES_PATH, 'utf-8');
  const parsed = JSON.parse(data) as ContractAddressesJson;
  const networks = Object.keys(parsed).filter((n) => NETWORK_CHAIN_IDS[n] !== undefined);
  const deploymentDirs = networks.filter((n) => fs.existsSync(path.join(DEPLOYMENTS_DIR, n)));
  const allDirs =
    fs.existsSync(DEPLOYMENTS_DIR) ?
      fs.readdirSync(DEPLOYMENTS_DIR).filter((name) => {
        const p = path.join(DEPLOYMENTS_DIR, name);
        return fs.statSync(p).isDirectory() && !name.startsWith('.');
      }) :
      [];
  const network = deploymentDirs[0] ?? allDirs[0] ?? networks[0] ?? 'sepolia';
  for (const m of ABI_MAPPINGS) {
    writeAbiFile(network, m.artifact, m.outPath, m.exportName, m.style);
  }
}

function writeSubgraphNetworks(): void {
  const data = fs.readFileSync(CONTRACT_ADDRESSES_PATH, 'utf-8');
  const parsed = JSON.parse(data) as ContractAddressesJson;
  const output: SubgraphNetworksOutput = {};
  for (const [network, contracts] of Object.entries(parsed)) {
    if (network === 'hardhat' && output['localhost']) continue;
    const outputKey = network === 'hardhat' ? 'localhost' : network;
    const entries: Record<string, { address: string; startBlock?: number }> = {};
    for (const [contractName, entry] of Object.entries(contracts)) {
      const addr = checksum(entry?.address);
      if (!addr) continue;
      const startBlock = getStartBlock(network, contractName);
      entries[contractName] = startBlock !== undefined ? { address: addr, startBlock } : { address: addr };
    }
    if (Object.keys(entries).length > 0) output[outputKey] = entries;
  }
  const outPath = path.join(OUTPUT_ROOT, 'subgraph-networks.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log('Wrote', path.relative(CONTRACTS_ROOT, outPath));
}

function printCopyInstructions(): void {
  console.log('');
  console.log('--- Copy instructions ---');
  console.log('');
  console.log('UI: Copy output/sync-ui/* into the UI repo src/ so that:');
  console.log('     output/sync-ui/configs/  →  computing/src/configs/');
  console.log('     output/sync-ui/constants/  →  computing/src/constants/');
  console.log('');
  console.log('Admin: Copy output/sync-ui/configs/admin-contract-addresses.generated.ts to');
  console.log('       computing-admin/src/configs/contract-addresses.generated.ts');
  console.log('');
  console.log('Subgraph: Merge addresses from output/sync-ui/subgraph-networks.json into the');
  console.log('     subgraph networks file. For each network (e.g. sepolia), replace or merge');
  console.log('     that key in computing-subgraph/networks.json with the corresponding object');
  console.log('     from subgraph-networks.json. Then run "yarn build:sepolia" and');
  console.log('     "yarn deploy:sepolia" in the subgraph repo to redeploy the indexer.');
  console.log('');
  console.log('Tip: rerun with "--check" to compare automatically, or "--write" to apply');
  console.log('     all of the above directly to the sister repos (when they live next to');
  console.log('     this repo on disk).');
  console.log('');
}

/**
 * Merge generated subgraph networks output into an existing networks.json
 * shape, producing the canonical state with minimal reordering:
 *   - Network ordering preserved from `existing` (new networks appended).
 *   - Within each managed network, contract ordering preserved from `existing`
 *     for surviving entries; new entries appended at the end.
 *   - Each (network, contract) entry takes its address from `generated`.
 *     For startBlock, prefer `generated.startBlock` (so block bumps from a
 *     fresh deploy land), falling back to the existing startBlock when the
 *     generated entry has none (deployment artifact lost the receipt).
 *   - Entries no longer in `generated` are dropped (e.g. sunset routers).
 *   - Networks only present in `existing` (e.g. legacy "ethereum" key with
 *     the v1 InheritanceWillRouter) are passed through untouched.
 */
function buildMergedSubgraphNetworks(
  generated: SubgraphNetworksOutput,
  existing: SubgraphNetworksOutput
): SubgraphNetworksOutput {
  const merged: SubgraphNetworksOutput = {};
  const seenNetworks = new Set<string>();
  for (const [network, existingEntries] of Object.entries(existing)) {
    seenNetworks.add(network);
    const generatedEntries = generated[network];
    if (!generatedEntries) {
      merged[network] = existingEntries;
      continue;
    }
    const out: Record<string, { address: string; startBlock?: number }> = {};
    for (const [name, existingEntry] of Object.entries(existingEntries)) {
      const generatedEntry = generatedEntries[name];
      if (!generatedEntry) continue;
      const startBlock =
        generatedEntry.startBlock !== undefined ? generatedEntry.startBlock : existingEntry.startBlock;
      out[name] = startBlock !== undefined ? { address: generatedEntry.address, startBlock } : { address: generatedEntry.address };
    }
    for (const [name, generatedEntry] of Object.entries(generatedEntries)) {
      if (out[name]) continue;
      out[name] = generatedEntry.startBlock !== undefined
        ? { address: generatedEntry.address, startBlock: generatedEntry.startBlock }
        : { address: generatedEntry.address };
    }
    merged[network] = out;
  }
  for (const [network, entries] of Object.entries(generated)) {
    if (seenNetworks.has(network)) continue;
    merged[network] = entries;
  }
  return merged;
}

interface DriftReport {
  path: string;
  kind: 'missing' | 'mismatch';
  details?: string;
}

function diffStrings(label: string, expected: string, actual: string): string {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const max = Math.max(expectedLines.length, actualLines.length);
  const out: string[] = [`--- diff: ${label} ---`];
  for (let i = 0; i < max; i++) {
    if (expectedLines[i] !== actualLines[i]) {
      if (actualLines[i] !== undefined) out.push(`  - ${i + 1}: ${actualLines[i]}`);
      if (expectedLines[i] !== undefined) out.push(`  + ${i + 1}: ${expectedLines[i]}`);
    }
  }
  return out.join('\n');
}

/** Per-(network, contract) semantic diff for subgraph networks.json. */
function diffSubgraphNetworks(
  expected: SubgraphNetworksOutput,
  actual: SubgraphNetworksOutput
): string[] {
  const out: string[] = [];
  const allNetworks = new Set<string>([...Object.keys(expected), ...Object.keys(actual)]);
  for (const network of allNetworks) {
    const exp = expected[network] ?? {};
    const act = actual[network] ?? {};
    const allContracts = new Set<string>([...Object.keys(exp), ...Object.keys(act)]);
    for (const c of allContracts) {
      const e = exp[c];
      const a = act[c];
      if (!e && a) {
        out.push(`  ${network}.${c}: should be removed (still has address ${a.address})`);
      } else if (e && !a) {
        out.push(`  ${network}.${c}: missing (expected ${e.address}${e.startBlock !== undefined ? ` @ ${e.startBlock}` : ''})`);
      } else if (e && a) {
        if (e.address.toLowerCase() !== a.address.toLowerCase()) {
          out.push(`  ${network}.${c}.address: ${a.address} → ${e.address}`);
        }
        if (e.startBlock !== undefined && a.startBlock !== e.startBlock) {
          out.push(`  ${network}.${c}.startBlock: ${a.startBlock ?? '(none)'} → ${e.startBlock}`);
        }
      }
    }
  }
  return out;
}

function checkOrWriteSisters(): void {
  if (!MODE_CHECK && !MODE_WRITE) return;
  const drifts: DriftReport[] = [];

  const generatedUi = fs.readFileSync(path.join(OUTPUT_ROOT, 'configs', 'contract-addresses.generated.ts'), 'utf-8');
  const generatedAdmin = fs.readFileSync(path.join(OUTPUT_ROOT, 'configs', 'admin-contract-addresses.generated.ts'), 'utf-8');
  const generatedSubgraph = JSON.parse(
    fs.readFileSync(path.join(OUTPUT_ROOT, 'subgraph-networks.json'), 'utf-8')
  ) as SubgraphNetworksOutput;

  // Compare line-ending agnostically: git's autocrlf can flip LF→CRLF on
  // Windows checkouts, but the file content is semantically identical.
  const norm = (s: string): string => s.replace(/\r\n/g, '\n');

  const checkOrWriteFile = (label: string, target: string, expected: string): void => {
    if (!fs.existsSync(target)) {
      drifts.push({ path: target, kind: 'missing' });
      if (MODE_WRITE) {
        ensureDir(path.dirname(target));
        fs.writeFileSync(target, expected, 'utf-8');
        console.log(`Created ${label}: ${target}`);
      }
      return;
    }
    const actual = fs.readFileSync(target, 'utf-8');
    if (norm(actual) === norm(expected)) return;
    if (MODE_WRITE) {
      fs.writeFileSync(target, expected, 'utf-8');
      console.log(`Updated ${label}: ${target}`);
    } else {
      drifts.push({ path: target, kind: 'mismatch', details: diffStrings(label, expected, actual) });
    }
  };

  // UI / Admin: full file comparison
  checkOrWriteFile('UI contract-addresses.generated.ts', SISTER_TARGETS.ui, generatedUi);
  checkOrWriteFile('Admin contract-addresses.generated.ts', SISTER_TARGETS.admin, generatedAdmin);

  // Subgraph networks.json: merge + semantic compare per (network, contract)
  if (!fs.existsSync(SISTER_TARGETS.subgraphNetworks)) {
    drifts.push({ path: SISTER_TARGETS.subgraphNetworks, kind: 'missing' });
  } else {
    const existing = JSON.parse(
      fs.readFileSync(SISTER_TARGETS.subgraphNetworks, 'utf-8')
    ) as SubgraphNetworksOutput;
    const merged = buildMergedSubgraphNetworks(generatedSubgraph, existing);
    const semanticDiff = diffSubgraphNetworks(merged, existing);
    if (semanticDiff.length > 0) {
      if (MODE_WRITE) {
        fs.writeFileSync(SISTER_TARGETS.subgraphNetworks, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
        console.log(`Updated subgraph networks.json: ${SISTER_TARGETS.subgraphNetworks}`);
        console.log('  Note: subgraph.yaml may also need data-source removals if a contract was sunset.');
      } else {
        drifts.push({
          path: SISTER_TARGETS.subgraphNetworks,
          kind: 'mismatch',
          details: ['--- subgraph networks.json drift ---', ...semanticDiff].join('\n'),
        });
      }
    }
  }

  if (MODE_CHECK && drifts.length > 0) {
    console.error('');
    console.error('=== DRIFT DETECTED ===');
    for (const d of drifts) {
      console.error('');
      console.error(`[${d.kind}] ${d.path}`);
      if (d.details) console.error(d.details);
    }
    console.error('');
    console.error(`${drifts.length} sister-repo file(s) out of sync. Run with --write to apply.`);
    process.exit(1);
  }
  if (MODE_CHECK) {
    console.log('');
    console.log('OK — all sister-repo files in sync with contract-addresses.json.');
  }
}

function main(): void {
  if (!fs.existsSync(CONTRACT_ADDRESSES_PATH)) {
    console.error('contract-addresses.json not found at', CONTRACT_ADDRESSES_PATH);
    process.exit(1);
  }
  ensureDir(OUTPUT_ROOT);
  writeAddresses();
  writeAdminAddresses();
  writeAbis();
  writeSubgraphNetworks();
  if (!MODE_CHECK && !MODE_WRITE) {
    printCopyInstructions();
  }
  checkOrWriteSisters();
}

main();

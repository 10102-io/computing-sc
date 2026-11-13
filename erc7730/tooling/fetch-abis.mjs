// Refreshes abis/ from Sourcify and lists each contract's state-changing
// functions. `node fetch-abis.mjs` fetches every contract; name some to
// fetch only those (`node fetch-abis.mjs ShieldVaultV3`), so the others
// stay as they were reviewed.
import { writeFileSync, mkdirSync } from 'node:fs';

// The routers are proxies: Sourcify holds the ABI under the implementation.
// TransferEOALegacyRouter names the implementation live since the timelock
// installed it on 2026-11-13. Its ABI is the same, fragment for fragment,
// as that of the one before it (0xe3d1bc20b92cd38D3C154F1B97A1A288b0e706A1,
// 2026-11-07), so the descriptor held on both sides of the upgrade. After
// an upgrade, name the new implementation here.
const contracts = {
  TransferEOALegacyRouter: '0x8F8971289e35adF8f9123BF142120D21109974eb',
  TimeLockRouter: '0x82f3148cc4836f03110F9B7139588B0563AF5005',
  ShieldVault: '0xA1EA2F8C0518458975E09ED63bf5D48980f76C38',
  ShieldVaultV3: '0x1610DC8D25475959D5ba9395c4CE02456B51EB59'
};

const only = process.argv.slice(2);
for (const name of only) {
  if (!contracts[name]) throw new Error(`${name}: unknown contract (${Object.keys(contracts).join(', ')})`);
}

const typeStr = (p) =>
  p.type.startsWith('tuple')
    ? `(${p.components.map(typeStr).join(',')})${p.type.slice(5)}`
    : p.type;

mkdirSync('abis', { recursive: true });
for (const [name, addr] of Object.entries(contracts)) {
  if (only.length && !only.includes(name)) continue;
  const res = await fetch(`https://sourcify.dev/server/v2/contract/1/${addr}?fields=abi`);
  const j = await res.json();
  // An unverified or partly matched contract must not become a descriptor.
  if (!res.ok || j.match !== 'exact_match' || !Array.isArray(j.abi)) {
    throw new Error(`${name} ${addr}: no exact match on Sourcify (HTTP ${res.status}, match ${j.match})`);
  }
  writeFileSync(`abis/${name}.json`, JSON.stringify(j.abi, null, 2));
  console.log(`=== ${name}`);
  for (const f of j.abi.filter((x) => x.type === 'function' && !['view', 'pure'].includes(x.stateMutability))) {
    console.log(`  ${f.name}(${f.inputs.map(typeStr).join(',')})${f.stateMutability === 'payable' ? ' payable' : ''}`);
    console.log(`      names: ${f.inputs.map((i) => i.name + (i.components ? '{' + i.components.map((c) => c.name + (c.components ? '{' + c.components.map((d) => d.name).join(',') + '}' : '')).join(',') + '}' : '')).join(' | ')}`);
  }
}

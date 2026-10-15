import { writeFileSync, mkdirSync } from 'node:fs';

const contracts = {
  TransferEOALegacyRouter: '0x355BBf74B91e021f18Cee0de191b295B4159E4A1',
  TimeLockRouter: '0x82f3148cc4836f03110F9B7139588B0563AF5005',
  ShieldVault: '0xA1EA2F8C0518458975E09ED63bf5D48980f76C38'
};

const typeStr = (p) =>
  p.type.startsWith('tuple')
    ? `(${p.components.map(typeStr).join(',')})${p.type.slice(5)}`
    : p.type;

mkdirSync('abis', { recursive: true });
for (const [name, addr] of Object.entries(contracts)) {
  const j = await (await fetch(`https://sourcify.dev/server/v2/contract/1/${addr}?fields=abi`)).json();
  writeFileSync(`abis/${name}.json`, JSON.stringify(j.abi, null, 2));
  console.log(`=== ${name}`);
  for (const f of j.abi.filter((x) => x.type === 'function' && !['view', 'pure'].includes(x.stateMutability))) {
    console.log(`  ${f.name}(${f.inputs.map(typeStr).join(',')})${f.stateMutability === 'payable' ? ' payable' : ''}`);
    console.log(`      names: ${f.inputs.map((i) => i.name + (i.components ? '{' + i.components.map((c) => c.name + (c.components ? '{' + c.components.map((d) => d.name).join(',') + '}' : '')).join(',') + '}' : '')).join(' | ')}`);
  }
}

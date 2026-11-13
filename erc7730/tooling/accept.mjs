// Records the reviewed runner output as each case's expected rendering.
// `node accept.mjs` records every descriptor; name some to record only those
// (`node accept.mjs ShieldVaultV3`), so the others keep what was reviewed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const names = ['TransferEOALegacyRouter', 'TimeLockRouter', 'ShieldVault', 'ShieldVaultV3'];
const only = process.argv.slice(2);
for (const n of only) {
  if (!names.includes(n)) throw new Error(`${n}: unknown descriptor (${names.join(', ')})`);
}

mkdirSync('expected', { recursive: true });
for (const n of only.length ? only : names) {
  const r = JSON.parse(readFileSync(`results/${n}.json`, 'utf8'));
  const expected = {};
  for (const c of r.cases) {
    if (!c.rendered) throw new Error(`${n}: "${c.description}" has no rendering (${c.status}: ${c.message})`);
    expected[c.description] = c.rendered;
  }
  writeFileSync(`expected/calldata-${n}.json`, JSON.stringify(expected, null, 2) + '\n');
  console.log(`${n}: ${r.cases.length} expectations recorded`);
}

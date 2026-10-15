// Records the reviewed runner output as each case's expected rendering.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync('expected', { recursive: true });
for (const n of ['TransferEOALegacyRouter', 'TimeLockRouter', 'ShieldVault']) {
  const r = JSON.parse(readFileSync(`results/${n}.json`, 'utf8'));
  const expected = {};
  for (const c of r.cases) {
    if (!c.rendered) throw new Error(`${n}: "${c.description}" has no rendering (${c.status}: ${c.message})`);
    expected[c.description] = c.rendered;
  }
  writeFileSync(`expected/calldata-${n}.json`, JSON.stringify(expected, null, 2) + '\n');
  console.log(`${n}: ${r.cases.length} expectations recorded`);
}

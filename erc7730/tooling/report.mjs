import { readFileSync } from 'node:fs';

const names = ['TransferEOALegacyRouter', 'TimeLockRouter', 'ShieldVault'];
const verbose = process.argv.includes('--verbose');
let pass = 0;
let total = 0;
for (const n of names) {
  const r = JSON.parse(readFileSync(`results/${n}.json`, 'utf8'));
  console.log(`\n##### ${n}  (${r.implementation})`);
  for (const c of r.cases) {
    total += 1;
    if (c.status === 'pass') pass += 1;
    console.log(`[${c.status}] ${c.description}${c.status !== 'pass' && c.message && verbose ? '  :: ' + c.message : ''}`);
    if (c.rendered && (verbose || c.status !== 'pass')) {
      const ii = c.rendered.interpolatedIntent ? `  |  ${c.rendered.interpolatedIntent}` : '';
      console.log(`   intent: ${c.rendered.intent}${ii}`);
      for (const f of c.rendered.fields) console.log(`   - ${f.label}: ${typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}`);
    }
  }
}
console.log(`\n${pass}/${total} cases pass`);

// The compiler team's known-bug list for given solc versions, and the full
// text of given bugs. Run it again when a new compiler is released: a new
// bug that reaches back to a version on mainnet shows up here.
//
//   node scripts/compiler-bugs/known-bugs.mjs 0.8.35 0.8.20 0.8.10 0.7.6
//   node scripts/compiler-bugs/known-bugs.mjs --text YulOptimizerKnowledgeBaseStaleBookkeeping
const SOURCES = [
  "https://raw.githubusercontent.com/argotorg/solidity/develop/docs/",
  "https://raw.githubusercontent.com/ethereum/solidity/develop/docs/",
];
let byVersion;
let bugs;
for (const base of SOURCES) {
  try {
    const [a, b] = await Promise.all([fetch(`${base}bugs_by_version.json`), fetch(`${base}bugs.json`)]);
    if (!a.ok || !b.ok) continue;
    byVersion = await a.json();
    bugs = await b.json();
    console.log(`source: ${base}`);
    break;
  } catch {
    // The next source.
  }
}
if (!byVersion) throw new Error("bug lists unreachable");

const args = process.argv.slice(2);
if (args[0] === "--text") {
  for (const name of args.slice(1)) {
    const b = bugs.find((x) => x.name === name);
    if (!b) {
      console.log(`\n== ${name}: not in the list`);
      continue;
    }
    console.log(`\n== ${name} (${b.severity}, ${b.introduced ?? "-"} to ${b.fixed})`);
    console.log(`summary: ${b.summary}`);
    console.log(`description: ${b.description}`);
    console.log(`link: ${b.link ?? "-"}  conditions: ${JSON.stringify(b.conditions ?? {})}`);
  }
} else {
  const order = (v) =>
    v
      .split(".")
      .map(Number)
      .reduce((s, n) => s * 1000 + n, 0);
  const latest = Object.keys(byVersion)
    .sort((x, y) => order(x) - order(y))
    .pop();
  console.log(`latest version in the list: ${latest} (${byVersion[latest].released}), bugs: ${byVersion[latest].bugs.length}`);
  const info = new Map(bugs.map((b) => [b.name, b]));
  for (const v of args) {
    const entry = byVersion[v];
    console.log(`\n== ${v} (released ${entry?.released}): ${entry?.bugs.length} known bugs`);
    for (const name of entry?.bugs ?? []) {
      const b = info.get(name) ?? {};
      console.log(
        `  ${name} | ${b.severity} | introduced ${b.introduced ?? "-"} | fixed ${b.fixed ?? "-"} | conditions ${JSON.stringify(b.conditions ?? {})}`
      );
    }
  }
}

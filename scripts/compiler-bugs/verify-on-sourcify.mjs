// Publishes the source of a contract on mainnet that no verifier holds, on
// Sourcify, from the compiler input found for it here (find-input.mjs,
// rebuild-from-history.mjs). Sourcify compiles the input itself and
// compares with the chain, so a wrong input cannot be published as a match.
// No key is needed. PUBLIC AND NOT REVERSIBLE: without --submit the script
// only says what it would send.
//
// Several legacies share one bytecode: LIKE=<address> takes the input found
// for that address, after checking that the code on the chain is the same.
//
//   node scripts/compiler-bugs/verify-on-sourcify.mjs <address>...
//   node scripts/compiler-bugs/verify-on-sourcify.mjs --submit <address>...
//   $env:LIKE='0x3f34…'; node scripts/compiler-bugs/verify-on-sourcify.mjs --submit <address>...
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getCode, work } from "./env.mjs";

const SERVER = "https://sourcify.dev/server";
const args = process.argv.slice(2);
const submit = args.includes("--submit");
const addresses = args.filter((a) => a !== "--submit").map((a) => a.toLowerCase());
const like = process.env.LIKE?.toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inputFor = (address) => {
  const file = join(work, "found-inputs", `${address}.json`);
  if (!existsSync(file)) throw new Error(`no input found for ${address}: run find-input.mjs or rebuild-from-history.mjs first`);
  return JSON.parse(readFileSync(file, "utf8"));
};
/** What Sourcify holds for an address: null, or its match levels. */
async function held(address) {
  const res = await fetch(`${SERVER}/v2/contract/1/${address}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${address}: Sourcify answers ${res.status}`);
  const { match, runtimeMatch, creationMatch } = await res.json();
  return match ? { match, runtimeMatch, creationMatch } : null;
}

const likeCode = like ? await getCode(like) : null;
let failed = 0;
for (const address of addresses) {
  const record = inputFor(like ?? address);
  if (like && (await getCode(address)) !== likeCode) {
    console.log(`${address}: its code is NOT the code of ${like}, skipped`);
    failed += 1;
    continue;
  }
  const before = await held(address);
  if (before) {
    console.log(`${address}: already on Sourcify (${JSON.stringify(before)})`);
    continue;
  }
  const { compilerVersion, fullyQualifiedName } = record.compilation;
  const { language, sources, settings } = record.stdJsonInput;
  const what = `${fullyQualifiedName}, solc ${compilerVersion}, ${Object.keys(sources).length} sources (${record.match})`;
  if (!submit) {
    console.log(`${address}: would submit ${what}`);
    continue;
  }
  const res = await fetch(`${SERVER}/v2/verify/1/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stdJsonInput: { language, sources, settings }, compilerVersion, contractIdentifier: fullyQualifiedName }),
  });
  const accepted = await res.json().catch(() => ({}));
  if (res.status !== 202 || !accepted.verificationId) {
    console.log(`${address}: NOT accepted (${res.status}): ${JSON.stringify(accepted).slice(0, 400)}`);
    failed += 1;
    continue;
  }
  let job;
  for (let i = 0; i < 90; i += 1) {
    await sleep(5000);
    job = await (await fetch(`${SERVER}/v2/verify/${accepted.verificationId}`)).json().catch(() => null);
    if (job?.isJobCompleted) break;
  }
  const after = job?.isJobCompleted && !job.error ? await held(address) : null;
  if (after) {
    console.log(`${address}: VERIFIED on Sourcify ${JSON.stringify(after)}; ${what}`);
  } else {
    console.log(`${address}: NOT verified: ${JSON.stringify(job?.error ?? job ?? "no answer").slice(0, 600)}`);
    failed += 1;
  }
}
if (failed) process.exitCode = 1;

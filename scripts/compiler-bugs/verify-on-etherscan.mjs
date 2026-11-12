// The Etherscan side of verify-on-sourcify.mjs: publishes the source of a
// contract on mainnet from the compiler input found for it here. Etherscan
// compiles the input itself and compares with the chain. Needs
// API_KEY_ETHERSCAN in .env (an API key, not a signing key; never printed).
// PUBLIC AND NOT REVERSIBLE: without --submit the script only reads the
// current status.
//
// LIKE=<address> takes the input found for that address, after checking
// that the code on the chain is the same (legacies that share one bytecode).
//
//   node scripts/compiler-bugs/verify-on-etherscan.mjs <address>...
//   node scripts/compiler-bugs/verify-on-etherscan.mjs --submit <address>...
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getCode, work } from "./env.mjs";

const API = "https://api.etherscan.io/v2/api?chainid=1";
const key = process.env.API_KEY_ETHERSCAN;
if (!key) throw new Error("API_KEY_ETHERSCAN is not set in .env");
const args = process.argv.slice(2);
const submit = args.includes("--submit");
const addresses = args.filter((a) => a !== "--submit").map((a) => a.toLowerCase());
const like = process.env.LIKE?.toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One call; the free tier allows 5 a second, and a rate-limit reply is retried, never read as an answer. */
async function call(params, method = "GET") {
  const body = new URLSearchParams({ ...params, apikey: key });
  for (let attempt = 0; ; attempt += 1) {
    await sleep(350);
    const res = await (method === "GET" ? fetch(`${API}&${body}`) : fetch(API, { method, body })).catch(() => null);
    const json = await res?.json().catch(() => null);
    if (json && !(typeof json.result === "string" && /rate limit/i.test(json.result))) return json;
    if (attempt >= 4) throw new Error(`Etherscan ${params.action}: ${json?.result ?? res?.status ?? "no answer"}`);
    await sleep(1200 * (attempt + 1));
  }
}
/** What Etherscan shows for an address: null, or the verified contract's name and compiler. */
async function held(address) {
  const json = await call({ module: "contract", action: "getsourcecode", address });
  const rec = Array.isArray(json.result) ? json.result[0] : null;
  if (!rec) throw new Error(`Etherscan ${address}: ${json.message} ${json.result}`);
  return rec.SourceCode ? `${rec.ContractName} (${rec.CompilerVersion})` : null;
}

const likeCode = like ? await getCode(like) : null;
let failed = 0;
for (const address of addresses) {
  const before = await held(address);
  if (before) {
    console.log(`${address}: verified on Etherscan as ${before}`);
    continue;
  }
  if (!submit) {
    console.log(`${address}: NOT verified on Etherscan`);
    continue;
  }
  const file = join(work, "found-inputs", `${like ?? address}.json`);
  if (!existsSync(file)) throw new Error(`no input found for ${like ?? address}: run find-input.mjs or rebuild-from-history.mjs first`);
  if (like && (await getCode(address)) !== likeCode) {
    console.log(`${address}: its code is NOT the code of ${like}, skipped`);
    failed += 1;
    continue;
  }
  const record = JSON.parse(readFileSync(file, "utf8"));
  const { language, sources, settings } = record.stdJsonInput;
  const sent = await call(
    {
      module: "contract",
      action: "verifysourcecode",
      contractaddress: address,
      sourceCode: JSON.stringify({ language, sources, settings }),
      codeformat: "solidity-standard-json-input",
      contractname: record.compilation.fullyQualifiedName,
      compilerversion: `v${record.compilation.compilerVersion}`,
      constructorArguements: "",
    },
    "POST"
  );
  if (sent.status !== "1") {
    console.log(`${address}: NOT accepted: ${sent.result}`);
    failed += 1;
    continue;
  }
  let status = "";
  for (let i = 0; i < 60; i += 1) {
    await sleep(5000);
    status = String((await call({ module: "contract", action: "checkverifystatus", guid: sent.result })).result);
    if (!/pending/i.test(status)) break;
  }
  const after = await held(address);
  console.log(after ? `${address}: VERIFIED on Etherscan as ${after} (${status})` : `${address}: NOT verified: ${status}`);
  if (!after) failed += 1;
}
if (failed) process.exitCode = 1;

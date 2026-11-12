// Downloads official solc builds into the work folder and checks each
// against the sha256 and keccak256 the release list publishes. Native
// releases by version for this platform; "nightly" for the two soljson
// builds around the 0.8.38 optimizer fix.
//
//   node scripts/compiler-bugs/get-compilers.mjs 0.8.36 0.8.37 0.8.38 nightly
import { createHash } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NIGHTLY, require, work } from "./env.mjs";

const { keccak256 } = require("ethers").utils;
const PLATFORM = { win32: "windows-amd64", linux: "linux-amd64", darwin: "macosx-amd64" }[process.platform];
if (!PLATFORM) throw new Error(`no native solc builds for ${process.platform}`);

async function fetchChecked(base, pick) {
  const list = await (await fetch(`${base}list.json`)).json();
  const build = list.builds.find(pick);
  if (!build) return null;
  const out = join(work, "solc", build.path);
  if (!existsSync(out)) {
    const bytes = Buffer.from(await (await fetch(base + build.path)).arrayBuffer());
    const sha = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    if (sha !== build.sha256 || keccak256(bytes) !== build.keccak256) throw new Error(`${build.path}: checksum mismatch, not saved`);
    writeFileSync(out, bytes);
    if (process.platform !== "win32") chmodSync(out, 0o755);
  }
  return { build, out };
}

for (const wanted of process.argv.slice(2)) {
  if (wanted === "nightly") {
    for (const file of Object.values(NIGHTLY)) {
      const got = await fetchChecked("https://binaries.soliditylang.org/bin/", (b) => b.path === file);
      console.log(got ? `${got.build.longVersion} ${got.out}` : `${file} is not in the release list`);
    }
    continue;
  }
  const got = await fetchChecked(`https://binaries.soliditylang.org/${PLATFORM}/`, (b) => b.version === wanted && !b.prerelease);
  console.log(got ? `${wanted} ${got.build.longVersion} ${got.out}` : `${wanted} is not in the release list`);
}

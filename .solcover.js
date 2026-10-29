// solidity-coverage configuration (docs/security/tooling-report.md).
//
// Default scope is the ShieldVault train: `contracts/shield/ShieldVault.sol`
// and `contracts/common/QuantumRecoveryRegistry.sol`, which are the two
// contracts without an independent review. Everything else still compiles
// (instrumented contracts import it) but is not instrumented, so the report
// shows real numbers for the two files instead of a wall of mocks.
//
//   npm run coverage              ShieldVault + registry, their two spec files
//   COVERAGE_SCOPE=all npm run coverage:all   every contract, every spec
//
// viaIR is on in hardhat.config.ts. Instrumentation inflates the code, so
// the Yul optimizer must stay enabled (`configureYulOptimizer`) or the
// instrumented ShieldVault hits "stack too deep"; the other optimizer
// steps are switched off so coverage counters are not folded away.
const fs = require("fs");
const path = require("path");

const SHIELD_SCOPE = ["shield/ShieldVault.sol", "common/QuantumRecoveryRegistry.sol"];

function listSolFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSolFiles(full, base));
    else if (entry.name.endsWith(".sol")) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const scopeAll = process.env.COVERAGE_SCOPE === "all";
const contractsDir = path.join(__dirname, "contracts");
const skipFiles = scopeAll ? ["mock"] : listSolFiles(contractsDir).filter((f) => !SHIELD_SCOPE.includes(f));

module.exports = {
  skipFiles,
  istanbulReporter: ["html", "lcov", "text", "json-summary"],
  configureYulOptimizer: true,
  solcOptimizerDetails: {
    peephole: false,
    inliner: false,
    jumpdestRemover: false,
    orderLiterals: true,
    deduplicate: false,
    cse: false,
    constantOptimizer: false,
    yul: true,
  },
  mocha: {
    // The ShieldVault property test takes minutes under instrumentation.
    timeout: 1_800_000,
  },
};

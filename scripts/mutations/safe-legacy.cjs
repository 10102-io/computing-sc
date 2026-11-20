/**
 * Mutation check of the Safe legacy fix (2026-11): each change below is a
 * bug planted in the guard, the Safe legacy router, its factory base, the
 * legacy or the deployer, and each must make test/SafeGuard.spec.ts fail.
 * A change the spec does not notice is a rule nobody tests.
 *
 *   node scripts/mutations/safe-legacy.cjs          # all, about 35 minutes
 *   node scripts/mutations/safe-legacy.cjs 4 10     # by number
 *   MUTATION_GREP='in any order' node scripts/mutations/safe-legacy.cjs   # what the random walk catches alone
 *
 * One source file is changed at a time and restored after its run, also
 * when the run throws. Run no other Hardhat command meanwhile, and compile
 * once afterwards (`npx hardhat compile`) so the artifacts are of the
 * sources again. Exit code 1 when a mutation is not caught, or when one no
 * longer applies to the source (then the list is stale, not the contract).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..', '..');
const G = 'contracts/SafeGuard.sol';
const R = 'contracts/inheritance/MultisigLegacyContractRouter.sol';
const L = 'contracts/inheritance/MultisigLegacyContract.sol';
const D = 'contracts/common/LegacyDeployer.sol';
const F = 'contracts/common/LegacyFactory.sol';
const nth = (text, find, n, repl) => {
  let at = -1;
  for (let i = 0; i <= n; i++) at = text.indexOf(find, at + 1);
  if (at < 0) throw new Error(`not found: ${find}`);
  return text.slice(0, at) + repl + text.slice(at + find.length);
};
const M = [
  ['guard: any caller moves the clock through checkTransaction', G, (t) => nth(t, 'if (msg.sender == safeWallet) _noteNow();', 0, '_noteNow();')],
  ['guard: any caller moves the clock through checkModuleTransaction', G, (t) => nth(t, 'if (msg.sender == safeWallet) _noteNow();', 1, '_noteNow();')],
  ['guard: the Safe itself does not move the clock', G, (t) => nth(t, 'if (msg.sender == safeWallet) _noteNow();', 0, '')],
  ['guard: the module hook does nothing', G, (t) => nth(t, 'if (msg.sender == safeWallet) _noteNow();', 1, '')],
  ['guard: sync moves the clock whenever it is called', G, (t) => nth(t, 'if (known && uint128(nonce) != _lastNonce) _note(known, nonce);', 0, 'if (known) _note(known, nonce);')],
  ['guard: sync does nothing', G, (t) => nth(t, 'if (known && uint128(nonce) != _lastNonce) _note(known, nonce);', 0, '')],
  ['guard: the nonce is never noted', G, (t) => nth(t, 'if (known) _lastNonce = uint128(nonce);', 0, '')],
  ['guard: can be bound twice', G, (t) => nth(t, 'if (_lastTimestamp != 0) revert SafeGuardInitialized();', 0, '')],
  ['guard: no module guard interface', G, (t) => nth(t, 'interfaceId == MODULE_GUARD_INTERFACE_ID ||', 0, '')],
  ['router: activation does not ask whether the legacy is set up on the Safe', R, (t) => nth(t, '_checkSafeWalletValid(legacyId_, safeWallet);', 0, '')],
  ['router: activation does not ask whether the guard is up to date', R, (t) => nth(t, 'if (!_guardSawLastTransaction(guardAddress, safeWallet)) revert GuardBehindSafeWallet();', 0, '')],
  ['router: the check does not ask whether the legacy is set up', R, (t) => nth(t, 'if (!_isSetUpOnSafeWallet(guardAddress, legacyAddress, safeWallet)) return false;', 0, '')],
  ['router: the check does not ask whether the guard is up to date', R, (t) => nth(t, 'if (!_guardSawLastTransaction(guardAddress, safeWallet)) return false;', 0, '')],
  ['factory: set up means the guard alone', F, (t) => nth(t, ' && ISafeWallet(safeWallet_).isModuleEnabled(legacyAddress_)', 0, '')],
  ['factory: set up means the module alone', F, (t) => nth(t, '_guardOfSafeWallet(safeWallet_) == guardAddress_ && ', 0, '')],
  ['factory: activation does not ask for the guard', F, (t) => nth(t, 'if (guardAddress != _guardOfSafeWallet(safeWallet_)) revert GuardSafeWalletInvalid();', 0, '')],
  ['factory: activation does not ask for the module', F, (t) => nth(t, 'if (ISafeWallet(safeWallet_).isModuleEnabled(moduleAddress) == false) revert ModuleSafeWalletInvalid();', 0, '')],
  ['legacy: an heir who is an owner already is not skipped', L, (t) => nth(t, 'if (ISafeWallet(owner).isOwner(beneficiaries_[i])) continue;', 0, '')],
  ['legacy: address 1 is accepted as a beneficiary', L, (t) => nth(t, ' || beneficiary_ == address(1)', 0, '')],
  ['legacy: the threshold is never changed', L, (t) => nth(t, 'if (threshold != _minRequiredSignatures) {', 0, 'if (false) {')],
  ['deployer: the owner passes onlyRouter', D, (t) => nth(t, 'msg.sender == multisigLegacyRouter, "Router only"', 0, 'msg.sender == multisigLegacyRouter || msg.sender == owner(), "Router only"')],
  ['deployer: the implementation can be initialised', D, (t) => nth(t, '    _disableInitializers();', 0, '')],
  ['router: the check answers true for an activated legacy', R, (t) => nth(t, 'if (MultisigLegacy(legacyAddress).getIsActiveLegacy() == 2) return false;', 0, '')],
  ['router: any contract that answers like the Safe passes onlySafeWallet', R, (t) => nth(t, 'if (msg.sender != MultisigLegacy(_checkLegacyExisted(legacyId_)).getLegacyOwner()) revert SenderIsNotSafeWalletOfLegacy();', 0, '')],
  ['factory: a guard without a nonce is never trusted', F, (t) => { const o = t.replace(/catch \{\s*return true;/, 'catch { return false;'); if (o === t) throw new Error('not found: catch'); return o; }],
  ['guard: the nonce is not read at the creation', G, (t) => nth(t, '_noteNow();', 0, '_lastTimestamp = uint128(block.timestamp);')],
  ['guard: a hook reverts when the address behind it does not answer nonce()', G, (t) => nth(t, 'if (ok && out.length == 32) return (true, abi.decode(out, (uint256)));', 0, 'require(ok && out.length == 32); return (true, abi.decode(out, (uint256)));')],
];
const only = process.argv[2] ? process.argv.slice(2).map(Number) : null;
// MUTATION_GREP narrows the run to the cases whose title matches, to see what one part of the spec catches alone.
const grep = process.env.MUTATION_GREP ? ['--grep', JSON.stringify(process.env.MUTATION_GREP)] : [];
let survived = 0;
M.forEach(([name, file, fn], i) => {
  if (only && !only.includes(i)) return;
  const full = path.join(root, file);
  const orig = fs.readFileSync(full, 'utf8');
  let out = '';
  try {
    fs.writeFileSync(full, fn(orig));
    const r = spawnSync('npx', ['hardhat', 'test', 'test/SafeGuard.spec.ts', ...grep], { cwd: root, shell: true, encoding: 'utf8', env: { ...process.env, HARDHAT_NO_FORK: '1' }, maxBuffer: 1 << 28 });
    out = (r.stdout || '') + (r.stderr || '');
  } finally {
    fs.writeFileSync(full, orig);
  }
  const failing = (out.match(/(\d+) failing/) || [])[1];
  const passing = (out.match(/(\d+) passing/) || [])[1];
  const compileError = /HH600|TypeError|DeclarationError|ParserError/.test(out);
  const verdict = compileError ? 'COMPILE ERROR (mutation invalid)' : failing ? `caught: ${failing} failing, ${passing} passing` : `SURVIVED (${passing} passing)`;
  if (!failing || compileError) survived += 1;
  const first = (out.match(/^\s+1\) (.*)$/m) || [])[1] || '';
  console.log(`${String(i).padStart(2)} ${name}: ${verdict}${first ? ` [first: ${first.slice(0, 90)}]` : ''}`);
});
console.log(survived ? `${survived} mutation(s) not caught` : 'every mutation caught');
process.exit(survived ? 1 : 0);

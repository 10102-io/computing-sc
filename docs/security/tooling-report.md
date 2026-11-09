# Tooling report: ShieldVault v2 and v3, legacy v3

Sections 1 to 7 are ShieldVault v2 and the registry (2026-10-27). Section 8
is legacy v3, wave B of the 2026-11 train (2026-11-05). Section 9 is
ShieldVault v3 (2026-11-09), built and not deployed. Section 10 is round
11 (2026-11-09): the fixes after two cross-model reviews of both, and the
whole suite rerun on the merged branch.

Status of `contracts/shield/ShieldVault.sol` (v2) and
`contracts/common/QuantumRecoveryRegistry.sol`: **internally reviewed,
tooling-verified, not independently audited.** This report records what
free tooling says about the two contracts as of 2026-10-27, with real
numbers, and where the tooling stops. It complements the audit package
(`docs/plans/shield-vault-audit.md`), which is the document to hand to a
firm; nothing here replaces that review.

Target: the source at tag `v2026.09.29`, unchanged since the mainnet
deployment of 2026-09-29 (`0xA1EA2F8C0518458975E09ED63bf5D48980f76C38`).
No line of either contract was modified for this work; everything below
is tests, configuration, CI and documentation.

## 1. Summary

| Evidence | Result | Where |
|---|---|---|
| Hardhat unit specs | 263 passing in the full suite; 50 for ShieldVault (40 existing + 10 new branch specs), 6 for the registry | `test/ShieldVault.spec.ts`, `test/ShieldVault.branches.spec.ts`, `test/QuantumRecoveryRegistry.spec.ts` |
| Coverage, ShieldVault.sol | **100% lines (224/224), 100% statements (180/180), 100% functions (42/42), 98.84% branches (170/172)**; the two uncovered branch arms are unreachable by construction (section 2) | `npm run coverage` |
| Coverage, QuantumRecoveryRegistry.sol | 100% lines (10/10), statements (9/9), functions (6/6), branches (2/2) | `npm run coverage` |
| Slither 0.11.6 | ShieldVault: 7 results, 0 vulnerabilities (3 false positives at Medium/High, 3 Low by design, 1 Informational); registry: 0 results | `docs/security/static-analysis.md` |
| Aderyn 0.6.8 | 0 High, 5 Low (all informational in substance) | `docs/security/static-analysis.md` |
| Foundry stateless fuzz | 13 properties, each 2,000 runs in CI and 20,000 runs locally, 0 counterexamples | `test/foundry/ShieldVault.fuzz.t.sol` |
| Foundry invariants | 9 invariant functions over a 25-operation handler, 256 runs x depth 200 (51,200 calls) in CI and 768 runs x depth 250 (192,000 calls) locally, 0 counterexamples | `test/foundry/ShieldVault.invariants.t.sol`, `ShieldVaultHandler.sol` |
| Invariants of the audit package covered | 19 of 19 have at least one automated check; section 4 says how strong each is | section 4 |
| CI | tests, coverage with thresholds, Slither and Aderyn, fuzz and invariants on every PR | `.github/workflows/security.yml` |

**Findings against the contract: none.** Every counterexample the fuzzers
produced during development was a mistake in the harness (section 4.4
lists them, because they show how the harness was debugged and what it
would have caught). Two observations that are not bugs are recorded in
section 6.

## 2. Coverage

`solidity-coverage` 0.8.17 is wired through `.solcover.js`.
`npm run coverage` instruments only the two review targets (every other
contract still compiles but is skipped, so the report is readable) and
runs the three spec files that exercise them; `npm run coverage:all`
instruments everything and runs the whole suite. `viaIR` is on in
`hardhat.config.ts`, so the configuration keeps the Yul optimizer enabled
(`configureYulOptimizer: true`) and switches the other optimizer steps off,
as the solidity-coverage documentation recommends for viaIR projects;
without that the instrumented ShieldVault does not compile ("stack too
deep").

### Before this work (the 40 existing ShieldVault specs plus the 6 registry specs)

| File | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| ShieldVault.sol | 98.89% (178/180) | 84.88% (146/172) | 97.62% (41/42) | 99.11% (222/224) |
| QuantumRecoveryRegistry.sol | 100% | 100% | 100% | 100% |

Dark before: `domainSeparator()` (never called), the `_isHeld` miss path
(an owed payee who is not a held beneficiary of a position that has a hold
mask), and 24 branch arms: the reentrancy arm of all 8 `nonReentrant`
functions, `UnknownPosition` from `_open` and `positionOf`, `ZeroAmount` in
`requestWithdraw` and `_pull`, `NothingReceived`, `NothingPending` in
`_cancel`, `InvalidAddress` for the vault as `recoveryTo`, as a
`claimOwedWithSig` destination, as fee recipient, for a zero token and a
zero registry, the length mismatch in `_validateConfig`, and the two
unreachable arms below.

### After (`test/ShieldVault.branches.spec.ts` added, 10 specs)

| File | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| ShieldVault.sol | **100%** (180/180) | **98.84%** (170/172) | **100%** (42/42) | **100%** (224/224) |
| QuantumRecoveryRegistry.sol | 100% | 100% | 100% | 100% |

The two branch arms still uncovered cannot be reached from any call
sequence, which is itself a useful fact about the contract:

- `veto`, line 445, `if (amount > 0)`: the false arm needs an open position
  with zero balance. `_pull` refuses a deposit that delivers nothing, and
  the only three ways a balance falls to zero (`executePending` of the whole
  amount, `veto`, `executeFallback`) all close the position in the same
  call. "Open implies funded" (invariant 12) is checked after every call of
  the invariant campaign and has never failed, so this arm is dead,
  defensive code.
- `fallbackAvailableAt`, line 536, `ready > at ? ready : at`: the `ready`
  arm needs a pending `readyAt` later than `lastActivity + silence`. Every
  request refreshes `lastActivity`, so `readyAt = lastActivity + exitDelay`
  at request time, and later check-ins only move `lastActivity` forward.
  With `exitDelay <= 90 days` and `silence >= 180 days` (both enforced by
  `_validateConfig`, including for the pending config the view consults),
  `ready > at` is impossible. The branch would only matter if the bounds
  were ever relaxed in a future deployment.

The reentrancy arms are now covered by a real probe, not a stub:
`contracts/mock/MockReentrantShieldToken.sol` is an ERC-20 whose transfer
hook calls back into the vault with a configurable payload. The spec arms
it with each of the eight guarded functions in turn, deposits (so the hook
fires inside `_pull`, while the guard is held), and checks that every
attempt failed with `ReentrancyGuardReentrantCall`, that each deposit was
credited exactly once, that the pending withdrawal survived, and that a
hook on the outgoing payout cannot re-enter either. The same token is one
of the three tokens in the invariant campaign (section 4).

CI enforces the figures above as thresholds (lines, statements, functions
100%; branches 98% for ShieldVault, 100% for the registry) and uploads the
HTML and lcov reports as an artifact.

## 3. Static analysis

Full triage in `docs/security/static-analysis.md`. In one paragraph:
Slither 0.11.6 with solc 0.8.35 and the deployed compiler settings reports
7 results on ShieldVault and 0 on the registry. The one High
(`uninitialized-state` on the `_positions` mapping) and the two Medium
(`uninitialized-local` on two zero-started accumulators) are documented
detector limitations with storage pointers and implicit zero
initialisation; they are recorded in `slither.db.json` so that CI, which
runs Slither with `--fail-medium`, stays green on them and fails on anything
new at Medium or above. The three Low `timestamp` results are the delay
mechanism itself, and the Informational `cyclomatic-complexity` on
`_validateConfig` is a validator that checks nine rules in one place.
Aderyn reports 0 High and 5 Low (centralisation risk on the documented
admin surface, one SSTORE in a loop bounded by ten, a numeric literal
style note, a struct member named like a state variable, and reverts
inside a validator loop). Slither could not build IR for OpenZeppelin's
`EIP712` constructor and two accessors (a known 0.11.x limitation with
`ShortString`), which is noted as an analysis gap and compensated by the
constructor and domain-separator specs.

## 4. Fuzzing and invariants (Foundry)

Foundry (forge 1.8.6) is added for the fuzz and invariant suite only;
Hardhat remains the build, test and deploy tool. `foundry.toml` mirrors the
compiler settings of `hardhat.config.ts` (solc 0.8.35, Cancun, optimizer
200 runs, viaIR) so the fuzzed bytecode has the deployed shape. `forge-std`
is a git submodule under `lib/`. `src` is `contracts/shield`, so forge
compiles only ShieldVault, its imports and the tests.

```
npm run fuzz            # CI profile: fuzz 2,000 runs per property, invariants 256 runs x depth 200
npm run fuzz:deep       # fuzz 20,000 runs per property, invariants 2,048 runs x depth 300
FUZZ_SUMMARY=out/fuzz-summary.txt npm run fuzz   # also writes per-operation reach counts
```

### 4.1 The stateful handler

`test/foundry/ShieldVaultHandler.sol` drives one vault with:

- four owners (three EOAs, one ERC-1271 wallet whose signatures come from
  its key), a recovery wallet each, three EOA beneficiaries, a paper key
  (held shares), a mute contract beneficiary (cannot sign, cannot call),
  a thief, a relayer, the admin and a treasury;
- three tokens: two `MockAwkwardERC20` (switchable transfer fee including a
  100% burn, USDC-style blocklist on payees and on the vault itself) and
  one `MockReentrantShieldToken` (callbacks that try to re-enter), of which
  the first two are listed at start and the admin may list or delist any;
- 25 operations: every external function of the vault (`open`, `deposit`,
  `checkIn`, `checkInWithSig`, `requestWithdraw`, `requestChange`,
  `cancelPending`, `cancelPendingWithSig`, `executePending`, `veto`,
  `executeFallback`, `claimOwed`, `claimOwedWithSig`, `collectFees`, the
  four admin setters), a stranger trying the admin setters, environment
  moves (token fee, blocklist, direct donation to the vault, time warps of
  seconds to three years), a griefer copying an owner's digest into a decoy
  position, and arming the hostile token with one of nine re-entry payloads;
- a shared starting state (five positions over three owners and two tokens,
  with and without sheets and fallbacks, one with a paper key, one
  withdrawal already waiting, one already failed into an owed entry) so
  that sequences of 200 calls reach the exits often.

Every operation states, from the spec and not from the code, the exact
condition under which the vault must accept the call, then checks the
outcome: who was paid how much (net of the token's own fee), what became
owed, that the fee is `floor(amount * feeBps / 10,000)`, that
`lastActivity` moved only for the owner, that a refused call changed
nothing, and so on. Signed operations are built with the right key and
nonce and then deliberately spoiled one way at a time (forged key, expired
deadline, wrong nonce, wrong id, stale `readyAt`, redirected destination).
A wrong accept, wrong refuse or wrong effect increments `violations` with a
message; the vault calls are wrapped in `try`, so the handler itself never
reverts and `fail_on_revert` is on, which turns any harness bug into a
failure rather than a silently skipped call.

### 4.2 The invariant functions (checked after every call)

| Function | Audit invariant | What it asserts |
|---|---|---|
| `invariant_handlerSawNoViolation` | I2, I3, I4, I5, I7, I8, I9, I10, I14, I17, I18, I19, Q3, Q11 | `violations == 0`, with the last message as the failure reason |
| `invariant_solvencyPerToken` | I1, I16 | per token: `balanceOf(vault) == sum of balances + sum of owed + feesAccrued + direct donations`, exactly |
| `invariant_openImpliesFunded` | I12 | open implies `balance > 0`; closed implies `balance == 0` |
| `invariant_pendingConsistency` | I13, I3 | a pending slot only on an open position; `readyAt` equal to the one recorded at request; a fixed amount never above the balance; a pending digest equal to the one pinned at request |
| `invariant_storedConfigsValid` | I15 | every active and pending config satisfies the spec's rule (mirror written independently of `_validateConfig`) |
| `invariant_closedIsTerminal` | I11 | a closed position's full `Position` struct equals the snapshot taken at close; nothing closes outside the three exits |
| `invariant_feeFixedAtOpen` | I17, I7 | each position's `feeBps` equals the rate at opening and is at most 50; the global rate is at most 50; the recipient is neither zero nor the vault |
| `invariant_digestsDisjointAndPinned` | I6, I5 | per owner, digests ever held by distinct positions are disjoint; every held digest is pinned for that owner; a pin is never cleared; the active digest is one the position has held |
| `invariant_noReentrancySucceeded` | Q11 | the hostile token's callbacks never got into the vault |

### 4.3 Stateless properties (`ShieldVault.fuzz.t.sol`, 13 tests)

| Test | Audit invariant | Property |
|---|---|---|
| `testFuzz_configValidation` | I15 | differential: `open` accepts a random config iff the independent mirror does; stored config equals the input |
| `testFuzz_withdrawDelayExact` | I3, I7, I8 | `readyAt == request + delay`; execution succeeds iff `wait >= delay`, with pause, delisting and a fee change as noise |
| `testFuzz_changeWaitsCurrentDelay` | I3 | a change to a shorter delay applies only after the current delay |
| `testFuzz_withdrawFeeExact` | I17 | fee snapshotted at open, `fee == floor(amount*bps/1e4)`, `net + fee == amount`, later rate changes ignored |
| `testFuzz_fallbackSplitExact` | I9, I17 | 1 to 10 beneficiaries, random shares summing to 10,000, random hold mask and fee: every non-last share is its floor, the last takes the remainder (bounded by n-1 units), held shares are owed and not sent, the vault keeps exactly fee plus held shares |
| `testFuzz_vetoBindsEveryField` | I4, I5, I14 | wrong secret, wrong destination and the vault as destination are refused; the right pair succeeds under a pending theft, pause, delisting, fee change and a blocked recovery wallet (then owed), takes no fee, clears pending, closes |
| `testFuzz_copiedDigestIsHarmless` | I6, Q3 | a stranger pinning a copy neither burns the owner's sheet nor lets the owner's secret move the decoy; the owner cannot pin the same sheet twice |
| `testFuzz_checkInSignatureBindsEverything` | I18 | valid signature works once; forged key, wrong nonce, wrong id, expired deadline and another chain's domain are refused without consuming a nonce or moving `lastActivity` |
| `testFuzz_cancelSignatureBindsReadyAt` | I18, Q15b | a cancel signed for one `readyAt` does not cancel a later request with another; the same-block re-request case (the documented limitation) behaves as documented |
| `testFuzz_heldShareMovesOnlyForItsKey` | I19 | a held share is refused to any pusher, to a forged signature and to a redirected destination, and moves exactly once on the key's own signature |
| `testFuzz_adminCannotReachAPosition` | I7, I8 | any admin action (including a refused one and an ownership transfer) leaves the position, owed and nonces byte-identical and the exit still works |
| `testFuzz_gasLimitCannotForceOwed` | Q9 | over gas limits from 21,000 to 400,000, `executePending`, `veto` and `executeFallback` either revert wholesale or pay the payable payee; no gas limit turns a payable payout into an owed entry |
| `testFuzz_feeOnTransferCreditsWhatArrived` | I1, Q10 | with a token fee of 0 to 100%, the position is credited what arrived (or refused when nothing did), and a payout debits the vault the gross amount while the payee receives net of the token's fee |

### 4.4 Results

CI profile, run locally on 2026-10-27 (forge 1.8.6):

- Stateless: 13 tests, 2,000 runs each in the CI profile. 0
  counterexamples.
- Invariants: 256 runs x depth 200 = 51,200 handler calls, 9 invariant
  functions evaluated after each call. 0 counterexamples, 0 reverts.
  Wall time 336 s single-threaded.

Longer local campaign, same code, run on 2026-10-27 to push past the CI
budget (`FOUNDRY_FUZZ_RUNS=20000 FOUNDRY_INVARIANT_RUNS=768
FOUNDRY_INVARIANT_DEPTH=250`):

- Stateless: 13 tests x 20,000 runs. 0 counterexamples against the
  contract. The first pass of this campaign did find one counterexample,
  in the test and not in the vault: `testFuzz_vetoBindsEveryField`
  compared the recovery wallet's absolute balance with the position's
  balance, and at run 12,963 the fuzzer picked the owner (funded with
  10^30 tokens) as the recovery wallet. The vault had paid exactly the
  position's 5e18; the assertion was changed to a delta and the suite
  re-run clean at 20,000 runs (item 4 in the list below).
- Invariants: 768 runs x depth 250 = 192,000 handler calls, 9 invariant
  functions after each call. 0 counterexamples, 0 reverts. Wall time
  1,357 s single-threaded. Reach, summed over the campaign (192,251 calls
  made, 88,066 accepted by the vault):

| Operation | Calls | Accepted by the vault |
|---|---|---|
| `admin.setDepositsPaused` | 7716 | 7716 |
| `admin.setFee` | 7704 | 6898 |
| `admin.setFeeRecipient` | 7566 | 5104 |
| `admin.setTokenSupported` | 7664 | 7664 |
| `adv.armHostile` | 7749 | 7749 |
| `adv.decoy` | 7549 | 1339 |
| `cancelPending` | 7620 | 1262 |
| `cancelPendingWithSig` | 7623 | 713 |
| `checkIn` | 7702 | 4047 |
| `checkInWithSig` | 7678 | 1949 |
| `claimOwed` | 7765 | 721 |
| `claimOwedWithSig` | 7737 | 291 |
| `collectFees` | 7754 | 1259 |
| `deposit` | 7790 | 2892 |
| `env.blocklist` | 7795 | 7795 |
| `env.donate` | 7811 | 6698 |
| `env.tokenFee` | 7618 | 7618 |
| `env.warp` | 7464 | 7464 |
| `executeFallback` | 7764 | 543 |
| `executePending` | 7764 | 1057 |
| `open` | 7680 | 1617 |
| `requestChange` | 7758 | 2276 |
| `requestWithdraw` | 7560 | 1637 |
| `stranger.admin` | 7676 | 0 |
| `veto` | 7744 | 1757 |

(`stranger.admin` is accepted 0 times by design: every call is a non-admin
trying an admin setter. A refused call is also a check, since the handler
asserts the refusal was right. The CI campaign's own counts are printed in
the `reach per operation` step of the Foundry job and uploaded as the
`fuzz-summary` artifact.)

Counterexamples found during development, all in the harness, none in the
contract (kept here because each one shows the handler is strict enough to
catch a real deviation of the same shape):

1. "stranger deposit moved lastActivity": the handler's "stranger" was the
   thief, who owns the decoy positions it had opened. Fixed by deciding
   ownership by address, not by role. Had the vault moved `lastActivity`
   on a genuine stranger's deposit (I10), the same check would have fired.
2. "claimOwedWithSig accepted a bad signature or destination": the
   "redirected" flaw signed for the thief as destination, and the thief is
   also in the payee set, so the fuzzer found the one case where the
   signed and submitted destinations coincided. Fixed by signing for a
   destination that is certainly different. The real property (a claim
   pays only the signed destination) held.
3. Two `expectRevert` mistakes in the stateless tests (a view call made
   while building a signature counted as "the next call"; a fallback
   address that coincided with the fuzzed destination). Both were test
   bugs.
4. "recovery wallet not paid the full balance" at 20,000 runs: an absolute
   balance assertion met a recovery wallet that was already funded (the
   owner). Changed to a delta. The vault's payout was exact.

### 4.5 Honest limits of the campaign

- Reach is uneven. Operations that need time and a prior request
  (`executeFallback`, `executePending`, the signed cancel) are accepted in
  a few percent of their calls; `claimOwed*` only when an owed entry exists.
  The table above gives the actual counts. The stateless tests cover the
  same paths deterministically with thousands of runs each, which is why
  both layers exist.
- The handler's acceptance predicates are a second implementation of the
  spec. Where the spec and the code agree but are both wrong, the harness
  agrees too. The predicates were written from
  `docs/plans/shield-vault-audit.md`, not from the contract, and the
  config validator is mirrored independently, but this is the usual limit
  of property testing.
- Tokens are mocks. `MockAwkwardERC20` has a fee and a blocklist on both
  sides and `MockReentrantShieldToken` has transfer hooks; neither is USDC,
  USDT or wstETH. Behaviours those have and the mocks do not (USDT's
  missing return value is handled by SafeERC20 and is exercised elsewhere
  in the suite by `MockNoReturnERC20`; proxy upgrades; USDC's pause) are
  approximated by the blocklist on the vault address.
- Gas semantics in the gas-griefing test are those of the mock's
  transfer (cheaper than USDC's). The 63/64 argument does not depend on
  the exact cost, but a real-token replay was not done.
- Invariant runs are seeded by Foundry's RNG; the CI run is not fixed to
  a seed, so two CI runs explore different sequences. That is intended
  (every PR explores new ground) but means a flaky harness would show up
  as intermittent CI red rather than a stable failure. The handler never
  reverting and `fail_on_revert = true` is the defence.
- Not covered by any automated check: the social and operational layer
  (alerts reaching the owner before `readyAt`, the private relay for
  vetoes, the governance Safe's threshold), the mainnet tokens' real
  behaviour under upgrade, and the frontend's sheet and digest
  computation, which the audit package lists out of scope.

## 5. CI

`.github/workflows/security.yml` runs on every pull request and on pushes
to `dev` and `main`, with four independent jobs so one tool's problem
never hides another's result:

| Job | Does | Fails when |
|---|---|---|
| `hardhat tests` | `npm ci`, `npx hardhat compile`, `npx hardhat test` (263 specs) | any spec fails |
| `coverage` | `npm run coverage`, then a threshold check on the review targets (since 2026-11-09 ShieldVault v3 too); uploads HTML/lcov | ShieldVault v2 or v3 below 100% lines, statements, functions or 98% branches; registry below 100% anywhere |
| `slither and aderyn` | Slither on each file with the deployed compiler settings and the triage database, `--fail-medium`; Aderyn on the two files; since round 7 also, report only, Slither and Aderyn on the three legacy v3 files (section 8); uploads every report | a new Slither result at Medium or above on ShieldVault (v2 or v3, since 2026-11-09) or the registry; any Aderyn High there (the legacy v3 steps never fail) |
| `foundry fuzz and invariants` | `forge test` on `test/foundry/**` with the CI profile, prints per-operation reach, uploads the summary | any counterexample or any handler revert |

Everything runs with `HARDHAT_NO_FORK=1` so a stray `fork-block.json` can
never turn CI into a mainnet fork, and no secret or RPC is used. The
repository had no CI before this; the four jobs are now the automated
safety net for the two contracts. Expected wall time: tests about a
minute, coverage three to four minutes, static analysis two minutes, the
Foundry job ten to fifteen minutes on a standard runner (10m35s on the
first run).

## 6. Observations that are not findings

Recorded so the next reader does not rediscover them.

1. **Two defensive branches are dead code** (section 2). Not a bug;
   worth knowing if the delay or silence bounds are ever changed in a
   future deployment, because `fallbackAvailableAt` would then start
   returning the pending `readyAt` in some cases.
2. **`Withdrawn`, `FallbackExecuted` and `Vetoed` are emitted before the
   transfer and also when the payout ends up owed** (followed by
   `OwedRecorded`). Already stated in the audit package's "intentional"
   list. An indexer that reads `Withdrawn` as "paid" without pairing it
   with `OwedRecorded` in the same transaction will over-count payouts.
   This is a subgraph and worker concern, not a contract one.
3. **The hold gate also covers a held beneficiary's unrelated owed
   entries** (a failed withdrawal to the same address), because `_isHeld`
   looks at the address, not at the origin of the entry. Noted in Q16 of
   the audit package; the effect is only that such an entry waits for the
   beneficiary's own call or signature too.
4. **A cancelled change burns its sheet for that owner** (the digest stays
   pinned). Documented design; the handler checks it on every cancel.

## 7. How to reproduce

```powershell
npm ci
npx hardhat compile
npm run test:shield          # the three ShieldVault / registry spec files
npm run coverage             # coverage/index.html, coverage/coverage-summary.json
npm run slither:shield       # needs: pip install slither-analyzer solc-select; solc-select install 0.8.35; solc-select use 0.8.35
npm run aderyn:shield        # needs: aderyn 0.6.8 (https://github.com/Cyfrin/aderyn)
npm run fuzz                 # needs: foundryup; git submodule update --init
```

The Foundry suite reads `FUZZ_SUMMARY=<path under out/>` to append per-run
reach counts; `FOUNDRY_PROFILE=deep` or `npm run fuzz:deep` runs the long
campaign.

## 8. Legacy v3 (wave B), 2026-11-05

Status of `contracts/forwarding/TransferLegacyEOAContractV3.sol` and
`contracts/whitelist/NftCollectionWhiteList.sol`: **internally reviewed,
tooling-verified, not independently audited.** The external review's scope
is `wave-b-audit-scope.md`. Target: the round 7 commit named there as the
commit to audit, on `feat/train-2026-11` (round 6 was `2dca935` and
`c9d6607`). Wave A was not touched: the wave A clone reproduces byte for byte from its verification
input and its artifact equals the mainnet code at
`0x2E2dE6475fcBE77E7930499981850d37b237924C` (15,426 bytes, keccak
`0x4caeb8ab…30bbcb`).

### 8.1 Summary

| Evidence | Result | Where |
|---|---|---|
| Hardhat specs | 386 passing in the full suite since round 10 (364 before); 38 for v3: 2 new in round 6, 5 in round 7, 5 in round 8 (one round 7 spec replaced), all failing on the code before their round; round 10: 19 fee specs and 3 router-guard specs (section 8.9) | `test/Train2026-11.v3.spec.ts`, `Train2026-11.fee.spec.ts` |
| Slither 0.11.6 | 24 results in v3's own code, none open: the reentrancy pattern fixed in round 6 and still reported in four instances (the detector does not credit a guard on an internal override), five false positives, the rest Low or informational by design; 67 results in the inherited wave A code, triaged for the record; 2 on the allowlist, 2 on the vault (in imported interfaces) | `static-analysis.md`, "Legacy v3" |
| Aderyn | not run locally (no Windows build of a current release, section 8.7); since round 7 CI runs 0.6.8 on the three files, report only | `.github/workflows/security.yml` |
| Foundry invariants | 7 invariant functions over an 18-entry handler with an independent model of the spec, including share ownership, the router's combined setters and a hostile owner acting from transfer callbacks; CI profile and deep profile, 0 counterexamples (numbers in 8.5) | `test/foundry/LegacyV3.invariants.t.sol`, `LegacyV3Handler.sol` |
| Foundry differential | v3 without backup lines against the wave A clone, call for call, twin owners and heirs, the combined setters included; 0 differences | `test/foundry/LegacyV3WholeEstate.t.sol` |
| Foundry stateless fuzz | 6 properties of the per-share math, 2,000 runs each in CI and 20,000 in the deep profile, 0 counterexamples | `test/foundry/LegacyV3.fuzz.t.sol` |
| Findings | round 6: one Medium liveness bug (fixed), one defensive guard (added); round 7, from two external read-only reviews: one High (share ownership) and one Medium (cross-layer and duplicate first lines), both fixed; round 8, from the re-reviews: two regressions (atomic edits, `claimNfts` state before the pull), both fixed; the rest documented | section 8.6 |

Coverage was not measured for v3 in this round (the coverage job
instruments ShieldVault and the registry only).

### 8.2 The handler

`test/foundry/LegacyV3Handler.sol` is the router: it creates one v3 clone
as the router does (EIP-1167 clone, `initialize`, a LegacyPullVaultV2
binding), calls the router-only entry points, and runs the router's
post-checks inside an external self-call, so a claim the router would
refuse reverts as a whole. The legacy has three first-line shares (50/30/20),
backup lines (a two-backup and a one-backup line), a second and a third
line, an executor, three tokens on the three pull rails (a direct
allowance, a USDT-like token that returns nothing, and Permit2 through the
vault), ETH held by the legacy, and two ERC-721 and two ERC-1155 items.
Payment takes 25 bps, as the token itself (since round 10 the fee is never
swapped; the Uniswap router has no liquidity and no suite calls it). Since
round 10 the vault-rail token can blocklist Payment and Payment can refuse
ETH (the `feeRefusal` entry, section 8.9).

The 18 entries: deposits (tokens to the owner, ETH from the owner or a
third party), drains (the owner's wallet shrinks; the owner withdraws ETH
while live), time warps (short steps to land in windows, long ones to reach
deadlines), check-ins, every owner setting (`setBackupLines` from 13 sets,
`setNftItems` from 10 item templates, first-line and second- or third-line
edits through the router, `setExecutor`), the router's two combined setters
(since round 8: `setLegacyConfig` moving the second line into the first
while naming a new second line, and `setBothLayer23Distributions` swapping
the second and third lines, each modelled child call by child call against
the intermediate state), attestations, token and ETH claims
(two entries, two thirds of the claimants drawn from the current lines),
NFT claims, NFT approval changes and transfers, the owner's M-1 `unbind`,
strangers and the executor trying every direct route, and `die`, after
which the owner never acts again (so most runs reach claims, and some never
do).

Every entry computes from its own model of the spec, not from the contract,
whether the call must be accepted and what it must move: the deadline with
an attestation, layers and periods, the backup windows, the per-share dues
(running totals, the cap of section 8.6), the whole-estate split, the NFT
payee and the units that can move given who holds and who may move them,
and each setter's acceptance rule. It then compares acceptance, every
watched balance (tokens, ETH, NFTs), `released`, `totalReleased`,
`shareOwner`, units moved and the activation flag. Since round 7 it also
observes, independently of the model, which shares actually paid in each
claim and to whom: the first payee of a share is recorded, every later
payment from it must go to the same address, and a share that paid
nothing (an empty, failed or refused claim) must keep its owner. The edit
sets include a first line that repeats an address, one that names the
second line, and the second line set to the third line's address; since
round 8 these are accepted in whole-estate mode and per-share mode must
then be refused. One first-line heir (carol) is a contract whose ERC-721,
ERC-1155 and ETH receipt callbacks have the owner try to delete the
legacy, withdraw its ETH, check in, rewrite the first line and change the
executor; every attempt must fail (round 8). A mismatch is counted in
`violations`; the handler never reverts, and `fail_on_revert` is on.

### 8.3 The invariant functions (after every call)

| Function | Plan invariant | What it asserts |
|---|---|---|
| `invariant_handlerSawNoViolation` | V1, V4, V5, V6, V7 | `violations == 0`: every acceptance and every amount as the spec says; no backup claim before its window; every payment from a share goes to its first payee (so no second or third line and no first-line member receives from a share someone else owns); an empty, failed or refused claim changes no owner; no stranger or executor call gets through |
| `invariant_conservation` | V2 | per token and ETH: owner + drained + paid out = all inflows; paid out = what the model paid; the legacy and the vault hold no tokens |
| `invariant_perShareEntitlement` | V2, V3 | shares' `released` sum to `totalReleased`; no share above its percentage of all inflows of that token; `released` equals the model |
| `invariant_shareOwnerIsFirstPayee` | V4 | for every address that was ever a share, `shareOwner` equals the model and the first payee the handler observed |
| `invariant_executorHoldsNothing` | V6 | the executor is the model's, on no line, not a backup, and holds no ETH, token or NFT |
| `invariant_nftUnits` | V7 | per item, units moved at most the units named and equal to the model; ERC-1155 units conserved across owner, drain sink and claimants |
| `invariant_configMatchesModel` | V8 | the deadline (with an attestation), `backupDelay` and the first line equal the model; shares sum to 100% after every accepted edit |
| `invariant_wholeEstateIsWaveA` (differential) | V9 | the two twins accepted and refused the same calls and paid the same amounts to the same twins and to Payment |

### 8.4 Stateless properties (`LegacyV3.fuzz.t.sol`)

| Test | Property |
|---|---|
| `testFuzz_runningTotalsOrderIndependent` | random percentages, four inflows and claim orders: after a final round each share has exactly its percentage of all inflows, at most 2 units of dust are left, and the wallet paid out exactly what was released |
| `testFuzz_capAfterTheWalletShrank` | after a drain the next share gets what is there, net of the exact fee, and after a refill stays within both its running-total entitlement and the current pot |
| `testFuzz_backupWindowToTheSecond` | a backup's claim before `deadline + backupDelay` reverts `BackupNotYet(opensAt)` with the exact time; from then on it pays and marks the share |
| `testFuzz_secondLineTakesOnlyUnclaimedShares` | with any subset of shares claimed, an inflow and a drain, the second line gets exactly the unclaimed dues (capped by what is there) and no claimed share's record moves |
| `testFuzz_executorTiming` | an attestation fails before half the trigger, brings the deadline to the earlier of normal and 30 days, a check-in cancels it, the executor holds nothing |
| `testFuzz_floorSplitNeverExceedsThePot` | the floor split never exceeds the pot and leaves at most 2 units |

### 8.5 Results

Round 8 code (commit `4f58e6b`). CI profile, run locally on 2026-11-05
(forge 1.8.6), the whole `test/foundry/**` suite: 22 tests in 5 suites, 0
failures, 10 min 32 s.

- v3 invariants: 256 runs x depth 200 = 51,200 handler calls, 7 invariant
  functions after each call. 0 counterexamples, 0 reverts. 370 s.
- Differential: 256 runs x depth 200 = 51,200 calls; 11,449 claim pairs
  compared, 2,018 accepted by both twins; 5,549 combined edits compared,
  2,699 accepted by both. 0 differences. 50 s.
- Stateless: 6 tests x 2,000 runs. 0 counterexamples.

Reach of the v3 invariant campaign (summed `FUZZ_SUMMARY` counts, CI profile):

| Operation | Calls | Accepted by the legacy |
|---|---|---|
| `claim` (tokens and ETH, both entries) | 5,552 | 1,162 |
| of which per-share / by a backup / second- or third-line sweep / with a capped due | | 614 / 109 / 204 / 39 |
| share ownership: shares that got their first payee / first-line claims refused because someone else owns the share / sweeps that left an owned share untouched | | 290 / 294 / 370 |
| `claimNfts` | 2,877 | 753 (90 item moves) |
| owner calls from inside a transfer callback (carol, round 8) | 52 | 0, by design: every one refused |
| `combinedEdit` (router combined setters, round 8) | 826 | 530 |
| `attest` | 2,843 | 73 |
| `setLines` / `setItems` / `setLayers` / `setExecutor` / `setDistributions` | 776 / 824 / 779 / 777 / 284 | 368 / 504 / 456 / 462 / 255 |
| `checkIn` / `unbind` | 792 / 821 | 781 / 7 |
| `deposit` / `drain` / `nftApprovals` / `warp` / `die` | 2,990 / 2,837 / 2,966 / 2,832 / 2,836 | all, except drains with nothing to drain and `die` draws that keep the owner alive |
| `stranger` (eve and the executor on every direct route) | 2,866 | 0, by design |

(A refused call is a check too: the handler asserts the refusal was right.
`unbind` succeeds only for a living owner after a claim, which is rare by
construction. Backup claims are fewer than in round 6 because a primary
that is paid first owns the share and its backups are refused. The CI job
prints the same counts in its `reach per operation` step.)

Deep profile (`FOUNDRY_PROFILE=deep`), same code, run locally on
2026-11-05, `test/foundry/LegacyV3*`: 8 tests, 0 failures, 70 min 29 s.

- v3 invariants: 2,048 runs x depth 300 = 614,400 handler calls, 7
  invariant functions after each call. 0 counterexamples, 0 reverts.
  4,228 s single-threaded.
- Differential: 2,048 runs x depth 300 = 614,400 calls; 135,819 claim
  pairs compared, 32,255 accepted by both twins; 67,836 combined edits
  compared, 28,434 accepted by both. 0 differences. 440 s.
- Stateless: 6 tests x 20,000 runs. 0 counterexamples.

Reach of the deep invariant campaign: 67,915 claim calls, 20,391 accepted
(8,992 per-share, 1,685 by a backup, 2,889 second- or third-line sweeps,
601 with a capped due after a drain); share ownership: 2,719 shares got
their first payee, 5,668 first-line claims were refused because someone
else owned the share, 5,737 sweeps left an owned share untouched; 34,265
NFT claim calls, 14,526 accepted, 1,188 item moves; 964 owner calls from
inside carol's transfer callbacks, all refused; 3,415 accepted combined
edits; 667 accepted attestations; 2,545 / 3,438 / 3,410 / 3,307 / 1,818
accepted backup-line, item, layer, executor and first-line edits; 0 of
34,069 stranger and executor attempts got through.

Earlier rounds passed the same profiles (614,400 calls per suite in the deep
profile, 0 counterexamples): round 6 with the `lineClaimed` rule the round 7
reviews showed to be wrong, and round 7 with checks the round 8 re-reviews
showed to block the router's combined setters; see 8.6.

### 8.6 What the campaign found

**One contract bug, fixed in round 6 (Medium, liveness).** Writing the
handler's model of a per-share claim raised the question of what a share
gets when the owner's wallet holds less than its due. A share's due is its
percentage of the pot (what is pullable now plus everything released)
minus what it received; the dues fit in what is pullable as long as the
pot never shrinks. A wallet that shrinks after an earlier claim (the owner
spends, another approval or a drainer takes tokens) breaks that, and the
transfer of the full due then failed silently: the share got nothing,
though tokens were there, until the wallet refilled. Whole-estate mode pays
whatever is there. The fix fills the dues in first-line order up to what
is pullable and records what was paid, so a share keeps the rest owed.
Against the previous code the suite fails three invariants within 64 runs
("released differs from the model", "claims moved out a different amount
than the model paid", "totalReleased differs from the model"), and the new
Hardhat spec fails ("100 gross, less the 25 bps fee").

**One defensive change (Slither W1, W2).** v3 recorded the shares' receipts
after the payout call and relied on the router's guard. Token claims now run
under the clone's own guard, shared with `claimNfts`; the spec in which an
heir re-enters from its NFT callback failed on the previous code.

**Round 7: what the suite missed.** Two independent read-only reviews from
other model families found a High (a share's backup could take its
primary's later inflows; a share's own line could come back after the second
line swept it and lock the sweep out, even with an empty claim) and a Medium
(cross-layer and repeated first-line addresses strand funds). The round 6
suite did not catch either, because its model encoded the same `lineClaimed`
rule as the contract and its edit sets contained no cross-layer or repeated
first line: the first limit of section 8.7, in practice. Round 7 changed
the rule (`shareOwner`) and added checks that do not rely on the model: the
handler observes which shares actually paid and to whom, and requires every
later payment from a share to go to its first payee, and the edit sets now
include the stranding first lines. The differential suite also showed the
new refusals at once (wave A accepts a first line that names the third
line; round 7's v3 refused it), so in round 7 such edits went to v3 alone
there; since round 8 v3 accepts them in whole-estate mode again and the
twins run every edit in lockstep.

**Round 8: two regressions the suite could not see.** The re-reviews found
that round 7's checks broke the router's combined setters (each child call
was checked against a half-done state) and that `claimNfts` still set the
legacy inactive only after the pull. The suite had neither the combined
setters nor a contract owner acting from a callback; both are in it now, and
the five new Hardhat specs fail on the round 7 code. Adding the combined
setters immediately produced one counterexample in the harness, not in v3:
after an earlier cross-line move the second line is the move's own new
address, so the next move would put it on both lines, which wave A refuses
and the model first did not.

**Counterexamples and gaps found in the harness during development**, kept
because each shows what the suite checks:

1. `setUp` reverted: the clone's initializer calls `pullVault()` on its
   router, and the handler had no code yet inside its constructor. The
   legacy is now created in `boot()`, after deployment, as on chain.
2. The first campaigns reached no claim at all (0 of 877 accepted): owner
   check-ins and settings kept moving the deadline. `die()` and long time
   steps fixed the reach; the reach counters (section 8.5) are now part of
   the summary so this cannot recur silently.
3. The model first read "pullable now" after the call instead of before
   it, and watched one address twice; both were harness bugs.
4. `testFuzz_runningTotalsOrderIndependent` overflowed in its own index
   arithmetic for an order seed near `2^256`; a test bug.

### 8.7 Honest limits

- Aderyn was not run on v3 locally. The current release (0.6.8, the one CI
  uses) ships no Windows build, the last Windows build (0.3.4) panics on
  solc 0.8.35, and there is no WSL distribution or Rust toolchain to run or
  build 0.6.8 here. Since round 7, CI runs it on the three v3 files on its
  Linux runner, report only; its first report has not been triaged yet.
- The model is a second implementation of the spec, written from
  `docs/plans/train-2026-11.md` and the review rounds. Where both are
  wrong the same way, the suite agrees with them. The differential suite
  (V9) has no such limit: it compares against the deployed wave A code.
- One legacy per run, at most three shares, fixed option sets for lines,
  items and layers. Larger first lines and item lists are not exercised
  here.
- Tokens are mocks: a standard ERC-20, a no-return token, a token that can
  blocklist Payment (round 10; its transfer fee stays off) and Permit2's
  mock. Fee-on-transfer and rebasing tokens, and heirs whose transfers
  fail, are not modelled.
- The router is modelled by its checks, not deployed; a router change
  needs its own tests (K-1 in the audit scope). Round 10's router guard is
  covered by Hardhat specs on the live mainnet clone code and the HEAD
  clone, not by this suite (it does not drive the unswap claim).

### 8.8 How to reproduce (tools as installed for this run)

Tools are user-local under `c:\Users\ebusi\dev\computing\.tools` (outside
every repository), added to `PATH` per command:

| Tool | Version | Source |
|---|---|---|
| Foundry (forge, cast, anvil) | 1.8.6, commit `6bad0a6` | `foundry_v1.8.6_win32_amd64.zip` from the GitHub release; SHA-256 `924d6395…edcfff` matches the published `.sha256` |
| Slither | 0.11.6, crytic-compile 0.4.2 | `pip install slither-analyzer==0.11.6 solc-select==1.2.0` in a Python 3.11.0 venv |
| solc | 0.8.35 (`47b9dedd`) | `solc-select install 0.8.35` with `VIRTUAL_ENV` set, so it lands in the venv |
| solidity-code-metrics | 0.0.28 | `npx` (nSLOC for the audit scope) |

```powershell
$env:PATH = "c:\Users\ebusi\dev\computing\.tools\foundry;$env:PATH"
forge test --match-path "test/foundry/LegacyV3*" -vv                    # CI profile
$env:FOUNDRY_PROFILE = "deep"; forge test --match-path "test/foundry/LegacyV3*" -vv
$env:FUZZ_SUMMARY = "out/v3-summary.txt"                                # reach counts
```

### 8.9 Round 10 (2026-11-09): the fee without a swap

The claim fee now goes from the owner's wallet to Payment as the token
itself, and a fee that cannot get there is not collected and never blocks
a claim (`wave-b-audit-scope.md`, "What changed since 4f58e6b", K-13).
What changed in the suite:

- Handler: the vault-rail token is a `MockAwkwardERC20` that can blocklist
  Payment, and the Payment mock can refuse ETH. A 19th entry,
  `feeRefusal`, switches both on or off. The model then expects no fee at
  Payment, counts the fee as released in per-share mode and leaves it in
  the owner's wallet (or the legacy, for ETH). A new reach counter,
  `feeRefused`, counts claims whose fee was refused.
- `invariant_perShareEntitlement` (V3): the bound is the inflows plus the
  uncollected fees, which the records count but which stay in the pot.
  `invariant_conservation` (V2) is unchanged and exact: what claims moved
  out is the net payouts plus the fees that arrived.
- `testFuzz_refusedFeeStaysInThePot`, a seventh stateless property: with
  a random subset of first-line claims refused a fee, each share is paid
  its due minus the fee, Payment receives only the fees it accepted, the
  records stay within the inflows plus the uncollected fees, tokens are
  conserved, and a later round with Payment reachable leaves at most 2
  units in the wallet.

CI profile, run locally on 2026-11-09 (forge 1.8.6) at the round 10 code:
3 suites, 0 failures. The invariant suite ran 256 runs x depth 200, 7
invariant functions, 0 counterexamples, 0 reverts (412 s; a second run of
that suite alone passed too). The
differential suite had 0 differences over 11,461 claim pairs (2,136
accepted by both twins) and 5,655 combined edits (2,738). The 7 stateless
properties each passed 2,000 runs. Reach of the invariant campaign: 5,271
claim calls, 1,115 accepted (584 per-share, 129 by a backup, 147 sweeps,
33 with a capped due), **312 claims with a refused fee**, 744 accepted NFT
claims (99 item moves), 305 first payees, 302 claims refused because
someone else owned the share, 90 owner calls from carol's callbacks (all
refused), 0 of 2,640 stranger attempts through. The deep profile was not
rerun for round 10.

## 9. ShieldVault v3, 2026-11-09

Status of `contracts/shield/ShieldVaultV3.sol`: **internally reviewed,
tooling-verified, not independently audited, not deployed**, and with no
adversarial review by a second reviewer yet (v2 had two). What v3 changes
and why: `docs/plans/shield-vault.md`, "v3". Target: commit `df19774` on
`feat/shield-vault-v3`. Sections 1 to 7 still describe v2, whose source is
not edited: its artifact keeps the recorded 14,375 runtime bytes and
metadata hash `0533e0df…c990`.

### 9.1 Summary

| Evidence | Result | Where |
|---|---|---|
| Size | 494 nSLOC (v2: 492). Against v2, outside comments: 16 lines added, 14 removed (the name, the withdrawal fee line, `_payOrOwe`, three payee checks, the validator's token argument). Runtime 14,724 bytes (v2: 14,375; limit 24,576) | `contracts/shield/ShieldVaultV3.sol` |
| Hardhat specs | 422 passing in the full suite (`HARDHAT_NO_FORK=1`); 114 in the four shield files: v2's 40 specs and 10 branch specs each against v2 and v3 (100), 8 v3 specs, 6 for the registry | `test/ShieldVault.spec.ts`, `test/ShieldVault.branches.spec.ts`, `test/ShieldVaultV3.spec.ts` |
| Coverage, ShieldVaultV3.sol | **100% lines (227/227), 100% statements (185/185), 100% functions (42/42), 98.9% branches (180/182)**; the two dark arms are v2's two dead arms (section 2), at lines 464 and 556 | `npm run coverage` |
| Coverage, ShieldVault.sol and the registry | unchanged: 100%, 100%, 100%, 98.84% (170/172); registry 100% | `npm run coverage` |
| Slither 0.11.6 | 9 results, 0 vulnerabilities: v2's 7 under v3's names (the 3 false positives at Medium or High recorded in `slither.db.json`) and 2 new Low `calls-loop` on `_payOrOwe`'s balance reads, by design | `static-analysis.md`, "ShieldVault v3" |
| Aderyn | not run locally (no Windows build, section 8.7); CI runs 0.6.8 on v3 with the "no High" gate | `.github/workflows/security.yml` |
| Foundry stateless fuzz | 15 properties, 2,000 runs each in CI and 20,000 in the deep profile, 0 counterexamples | `test/foundry/ShieldVaultV3.fuzz.t.sol` |
| Foundry invariants | 10 invariant functions over a 26-operation handler; 256 runs x depth 200 (51,200 calls) in CI, 768 x 250 (192,000 calls) locally; 0 counterexamples, 0 reverts | `test/foundry/ShieldVaultV3.invariants.t.sol`, `ShieldVaultV3Handler.sol` |
| Findings | none against the contract | |

### 9.2 What the v3 suites check beyond v2's

Hardhat. The shared specs pass on v3 unchanged except the two about the
fee, which branch on the version: on v3 the withdrawal pays the whole
amount and accrues nothing, the release accrues the fee. The v3 file adds:

- the owner's own exits are free: a withdrawal, an `ALL` withdrawal with a
  stranger's dust, a change, a cancel and a veto emit no `FeeCharged` and
  leave nothing in the vault;
- a release charges once (one `FeeCharged`), and the held and the failed
  share are claimed for exactly what was recorded, with no further fee; the
  vault ends with exactly the release fee;
- SV-L1: with a token that moves everything and returns `false`, the
  withdrawal, the release and the veto record nothing as owed; a partial
  move owes the rest; no move owes it all; each holding is paid once. The
  same scenario on v2 is in the file too and asserts v2's double payment,
  so these specs fail on v2's code;
- the token contract is refused at open, change, withdrawal request and
  signed claim; a sheet committed to the token still vetoes (by design);
- the ABI: every v2 fragment, formatted in full, equals v3's; v3's ABI reads
  a v2 holding; `eip712Domain()` is `"10102 ShieldVault"`, `"2"`, the v3
  address.

Stateless fuzz. v2's 13 properties with v3's rules
(`testFuzz_withdrawFeeExact` becomes `testFuzz_withdrawIsFree`, over partial,
whole and `ALL` withdrawals at any rate; `testFuzz_configValidation` also
draws the token as a beneficiary, and its mirror refuses it;
`testFuzz_feeOnTransferCreditsWhatArrived` expects a free withdrawal), and:

| Test | Property |
|---|---|
| `testFuzz_falseReturnOwesOnlyWhatStayed` | a token moving 0 to 10,000 bps of a payout and returning `false`, any amount, rate and exit (withdrawal, veto, release): the payee holds what moved, is owed exactly the rest, the fee is taken only on the release, the vault still covers a bystander holding in the same token, and the later claim pays exactly the rest |
| `testFuzz_tokenRefusedAsPayee` | the token at any position of 1 to 10 beneficiaries is refused at open and change; a withdrawal to it is refused; the held share's own signature naming it is refused without consuming the nonce |
| `testFuzz_gasLimitCannotForceOwed` | unchanged from v2, and still holds with the two balance reads in the payout path |

Invariants. `ShieldVaultV3Handler.sol` is v2's handler with v3's rules:

- a fourth token, `MockLyingERC20`, listed at start, and a 26th operation
  `env.lie` that makes it honest (half the draws), move everything and
  return `false`, move nothing, or move a random part;
- the four token contracts in the payee pool and as an occasional
  beneficiary, so the refusal is exercised (refused for the holding's own
  token, accepted for another);
- every payout checked against an exact model of what the payee receives,
  what becomes owed and what leaves the vault (v2's handler accepted either
  "paid" or "owed"; v3's predicts which);
- a withdrawal must leave `feesAccrued` as it was; claims and fee
  collection are refused while the token reports failure, since they must
  pay in full or revert;
- one more invariant, `invariant_feesOnlyFromReleases`: per token, fees
  held plus fees collected equal the fees the releases took.

### 9.3 Results

CI profile, forge 1.8.6, on 2026-11-09:

- Invariants: 256 runs x depth 200 = 51,200 handler calls, 10 invariant
  functions after each call. 0 counterexamples, 0 reverts. Run twice: alone,
  before three reach counters were added to the handler (929 s, with the
  coverage job running alongside), and with the committed handler within
  the whole `test/foundry/**` suite (38 tests in 7 suites, 0 failures,
  17 min 20 s).
- Stateless: 15 tests x 2,000 runs. 0 counterexamples.

Deep fuzz profile: 15 tests x 20,000 runs, 0 counterexamples, 59 s.

Longer local campaign, same code (`FOUNDRY_INVARIANT_RUNS=768
FOUNDRY_INVARIANT_DEPTH=250`), run on 2026-11-09: 768 runs x depth 250 =
192,000 handler calls, 10 invariant functions after each call. 0
counterexamples, 0 reverts. 3,473 s single-threaded. Reach, summed over
the campaign (192,251 calls made, 91,530 accepted by the vault; the
`reach.` lines count events inside other calls, not calls):

| Operation | Calls | Accepted by the vault |
|---|---|---|
| `admin.setDepositsPaused` | 7283 | 7283 |
| `admin.setFee` | 7443 | 6656 |
| `admin.setFeeRecipient` | 7426 | 4910 |
| `admin.setTokenSupported` | 7435 | 7435 |
| `adv.armHostile` | 7394 | 7394 |
| `adv.decoy` | 7609 | 1424 |
| `cancelPending` | 7257 | 1187 |
| `cancelPendingWithSig` | 7399 | 627 |
| `checkIn` | 7452 | 3991 |
| `checkInWithSig` | 7405 | 1801 |
| `claimOwed` | 7345 | 747 |
| `claimOwedWithSig` | 7430 | 265 |
| `collectFees` | 7555 | 276 |
| `deposit` | 7372 | 2818 |
| `env.blocklist` | 7274 | 7274 |
| `env.donate` | 7488 | 6577 |
| `env.lie` | 7377 | 7377 |
| `env.tokenFee` | 7375 | 7375 |
| `env.warp` | 7361 | 7361 |
| `executeFallback` | 7412 | 568 |
| `executePending` | 7236 | 1048 |
| `open` | 7485 | 1648 |
| `requestChange` | 7549 | 2172 |
| `requestWithdraw` | 7290 | 1524 |
| `stranger.admin` | 7138 | 0 |
| `veto` | 7461 | 1792 |
| `reach.lie`: payouts while the token reported failure / of which some funds moved anyway | 66 | 41 |
| `reach.owed`: payouts that left something owed | 464 | 464 |
| `reach.tokenPayee`: calls naming the holding's token as a payee / of which that was the only flaw | 388 | 78 |

The deep invariant profile (2,048 runs x depth 300, 614,400 calls) was
started and stopped after 18 minutes: at about 40 calls a second on this
machine it needs some four hours, and Foundry reports nothing before a
campaign ends. The longer campaign above matches the one v2 had (section
4.4).

### 9.4 Honest limits

Section 4.5 applies unchanged. In addition:

- The lying token is a mock with one switch. The longer campaign made 66
  payouts while it lied, 41 of them with funds moving anyway (the
  `reach.lie` line); the stateless property covers that path 20,000 times.
- No second reviewer has looked at v3. The diff is small and the evidence
  is the same kind v2 had before its deployment, but v2 also had two
  adversarial reviews.
- Cost: every payout makes one `balanceOf` call, two when the transfer
  fails. Not measured on mainnet tokens.

### 9.5 How to reproduce

```powershell
$env:HARDHAT_NO_FORK = "1"
npx hardhat test test/ShieldVault.spec.ts test/ShieldVault.branches.spec.ts test/ShieldVaultV3.spec.ts test/QuantumRecoveryRegistry.spec.ts
npx hardhat coverage --testfiles "test/{ShieldVault,ShieldVault.branches,ShieldVaultV3,QuantumRecoveryRegistry}.spec.ts"   # alone: it instruments artifacts/
$env:PATH = "c:\Users\ebusi\dev\computing\.tools\foundry;$env:PATH"
forge test --match-path "test/foundry/ShieldVaultV3*" -vv                                       # CI profile
$env:FOUNDRY_INVARIANT_RUNS = "768"; $env:FOUNDRY_INVARIANT_DEPTH = "250"; $env:FUZZ_SUMMARY = "out/v3-long-summary.txt"
forge test --match-path "test/foundry/ShieldVaultV3.invariants.t.sol" -vv                       # longer campaign
npx hardhat run scripts/deploy-shield-vault-v3.ts --network hardhat                             # deploy rehearsal, records nothing
```

## 10. Round 11 (2026-11-09): after the cross-model reviews

Two read-only reviews, a GPT-family and a Gemini-family reviewer, read
round 10 (section 8.9) and ShieldVault v3 (section 9) at `d988e6b`, the
merge of both with `dev`. No Critical or High. What was done, with the
reasons and the known issues: `wave-b-audit-scope.md` ("What changed since
4f58e6b", K-13, K-14, K-17, "ShieldVault v3"). Status unchanged: internally
reviewed, tooling-verified, not independently audited, not deployed.

| Finding | Change | Evidence |
|---|---|---|
| Medium (GPT): on the clone's direct rail, a token that moves funds and returns `false` counted as 0 while the move stayed (a per-share claimant could drain the other shares) | the direct transfer runs in `pullDirect` on the legacy itself (only `address(this)` may call it), with `safeTransferFrom`, inside `try`: the move rolls back | `Train2026-11.review.spec.ts`: whole-estate on the base and v3, full and partial moves rolled back and later claims exact; per-share, three claims by A take nothing from B (full and partial); the deployed wave A code (a starved heir at fee 0, a reverting claim at 25 bps) and the live 2026-07-30 code (no bias) |
| Low (GPT): the router's unswap guard trusts the storage token's views | accepted (K-14 (b)) | a token that reports 0 to the router: the live clone code swaps at a zero minimum; a HEAD clone keeps both guards |
| L-1 (Gemini): the whole-estate fee was pulled before the beneficiaries | after them, for ETH and tokens | a token that takes 0.1% more under an exact allowance: both heirs paid in full, the fee not collected |
| I-1 (Gemini): ShieldVault v3's `collectFees` could pay the token's own contract | refused (`InvalidAddress`) | `ShieldVaultV3.spec.ts`; the Foundry handler's `collectFees` now expects the refusal |
| Untested cases (both) | specified | the unswap claim with a vault or Permit2 approval plus a small direct allowance (the direct part swapped, the rest on its rail, one call); a second whole-estate claim after a refused fee; per-share payouts failing for a blocklisted heir and an heir refusing ETH, nothing recorded, the backup claims; ShieldVault v3 with a token that takes 10% more and returns `false` (nothing owed, the shortfall shown); replay of v2 check-ins, cancels and sheets on v3 and the reverse; gas burners (a fee receiver burning all its gas, a token burning it on the fee transfer in both modes, a ShieldVault v3 token burning it on one payout and on fee collection) |

New mock: `MockWeirdERC20` (moves part or all and returns `false`, takes
more than the amount, burns the gas of a transfer to one address, or
answers `balanceOf` and `allowance` with 0 to one caller). The live
fixture gains the deployed wave A clone's runtime code (15,426 bytes,
keccak `0x4cae…bbcb`, read with `eth_getCode`).

Results on this machine, 2026-11-09, at the round 11 code, run one at a
time:

- Hardhat: 470 passing, 0 failing (444 at `d988e6b`; 22 new legacy specs,
  4 new ShieldVault v3 specs).
- Coverage (`npm run coverage`, the CI scope): ShieldVaultV3.sol 100%
  lines (228/228), statements (186/186), functions (42/42), 98.91% branches
  (182/184; the two dark arms are v2's dead ones); ShieldVault.sol
  unchanged (100, 100, 100, 98.84%); the registry 100%. Every CI threshold
  met.
- Foundry, CI profile, every suite (`test/foundry/**`): 7 suites, 39 tests,
  0 failures, 18 min. Legacy v3 invariants 568 s, 0 counterexamples, 326
  claims with a refused fee; differential 0 differences over 11,449 claim
  pairs; ShieldVault v2 and v3 invariants 945 s and 1,086 s, 0
  counterexamples; 35 stateless properties.
- Slither (CI flags): ShieldVaultV3 6 results shown over the triage
  database, exit 0 (as before); the router 46 (unchanged); legacy v3 86, the
  five new ones from the self-call, triaged in `static-analysis.md` (R11-1,
  by design).
- `check-clone-reproducible.ts`: v3 (23,490 bytes) and the base (14,320)
  IDENTICAL from their minimal input.
- Sizes: v3 23,490 (1,086 spare), the base 14,320, the router 23,398,
  ShieldVault v3 14,733 (14,724 before), ShieldVault v2 14,375 (unchanged).
- Gas: the self-call costs about 1,500 per direct transfer (a 10-token
  claim: 1,101,410 on the base, 1,058,599 before; 1,414,114 on v3
  per-share, 1,383,081 before).

Not rerun: the deep Foundry profiles and Aderyn (no Windows build; CI
runs it).

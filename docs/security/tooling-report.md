# Tooling report: ShieldVault v2 and legacy v3

Sections 1 to 7 are ShieldVault v2 and the registry (2026-10-27). Section 8
is legacy v3, wave B of the 2026-11 train (2026-11-05).

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
| `coverage` | `npm run coverage`, then a threshold check on the two files; uploads HTML/lcov | ShieldVault below 100% lines, statements, functions or 98% branches; registry below 100% anywhere |
| `slither and aderyn` | Slither on each file with the deployed compiler settings and the triage database, `--fail-medium`; Aderyn on the two files; since round 7 also, report only, Slither and Aderyn on the three legacy v3 files (section 8); uploads every report | a new Slither result at Medium or above on ShieldVault or the registry; any Aderyn High there (the v3 steps never fail) |
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
| Hardhat specs | 360 passing in the full suite; 34 for v3: 2 new in round 6 and 5 new in round 7 | `test/Train2026-11.v3.spec.ts` |
| Slither 0.11.6 | 21 results in v3's own code, none open: one fixed in round 6 and still reported (the detector does not credit a guard on an internal override), five false positives, the rest Low or informational by design; 68 results in the inherited wave A code, triaged for the record; 2 on the allowlist, 2 on the vault (in imported interfaces) | `static-analysis.md`, "Legacy v3" |
| Aderyn | not run locally (no Windows build of a current release, section 8.7); since round 7 CI runs 0.6.8 on the three files, report only | `.github/workflows/security.yml` |
| Foundry invariants | 7 invariant functions over a 17-entry handler with an independent model of the spec, including share ownership; CI profile and deep profile, 0 counterexamples (numbers in 8.5) | `test/foundry/LegacyV3.invariants.t.sol`, `LegacyV3Handler.sol` |
| Foundry differential | v3 without backup lines against the wave A clone, call for call, twin owners and heirs; v3's extra refusals (round 7) sent to v3 alone; 0 differences | `test/foundry/LegacyV3WholeEstate.t.sol` |
| Foundry stateless fuzz | 6 properties of the per-share math, 2,000 runs each in CI and 20,000 in the deep profile, 0 counterexamples | `test/foundry/LegacyV3.fuzz.t.sol` |
| Findings | round 6: one Medium liveness bug (fixed), one defensive guard (added); round 7, from two external read-only reviews: one High (share ownership) and one Medium (cross-layer and duplicate first lines), both fixed; the rest documented | section 8.6 |

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
Payment takes 25 bps; the Uniswap router has no liquidity, so every fee
reaches Payment as tokens and stays countable.

The 17 entries: deposits (tokens to the owner, ETH from the owner or a
third party), drains (the owner's wallet shrinks; the owner withdraws ETH
while live), time warps (short steps to land in windows, long ones to reach
deadlines), check-ins, every owner setting (`setBackupLines` from 13 sets,
`setNftItems` from 10 item templates, first-line and second- or third-line
edits through the router, `setExecutor`), attestations, token and ETH claims
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
second line, and the second line set to the third line's address, which
v3 must refuse. A mismatch is counted in `violations`; the handler never
reverts, and `fail_on_revert` is on.

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

Round 7 code (commit `8bb8573`). CI profile, run locally on 2026-11-05
(forge 1.8.6), the whole `test/foundry/**` suite: 22 tests in 5 suites, 0
failures, 10 min 0 s.

- v3 invariants: 256 runs x depth 200 = 51,200 handler calls, 7 invariant
  functions after each call. 0 counterexamples, 0 reverts. 319 s.
- Differential: 256 runs x depth 200 = 51,200 calls; 12,761 claim pairs
  compared, 3,229 accepted by both twins, 47 overlapping first-line edits
  refused by v3 alone. 0 differences. 36 s.
- Stateless: 6 tests x 2,000 runs. 0 counterexamples.

Reach of the v3 invariant campaign (summed `FUZZ_SUMMARY` counts, CI profile):

| Operation | Calls | Accepted by the legacy |
|---|---|---|
| `claim` (tokens and ETH, both entries) | 6,028 | 1,140 |
| of which per-share / by a backup / second- or third-line sweep / with a capped due | | 799 / 135 / 223 / 38 |
| share ownership: shares that got their first payee / first-line claims refused because someone else owns the share / sweeps that left an owned share untouched | | 421 / 449 / 446 |
| `claimNfts` | 2,978 | 954 (149 item moves) |
| `attest` | 3,048 | 87 |
| `setLines` / `setItems` / `setLayers` / `setExecutor` / `setDistributions` | 811 / 772 / 844 / 875 / 295 | 443 / 477 / 560 / 501 / 178 |
| `checkIn` / `unbind` | 791 / 879 | 775 / 7 |
| `deposit` / `drain` / `nftApprovals` / `warp` / `die` | 2,984 / 2,973 / 3,014 / 3,039 / 2,994 | all, except drains with nothing to drain and `die` draws that keep the owner alive |
| `stranger` (eve and the executor on every direct route) | 3,072 | 0, by design |

(A refused call is a check too: the handler asserts the refusal was right.
`unbind` succeeds only for a living owner after a claim, which is rare by
construction. Backup claims are fewer than in round 6 because a primary
that is paid first now owns the share and its backups are refused. The CI
job prints the same counts in its `reach per operation` step.)

Deep profile (`FOUNDRY_PROFILE=deep`), same code, run locally on
2026-11-05, `test/foundry/LegacyV3*`: 8 tests, 0 failures, 63 min 29 s.

- v3 invariants: 2,048 runs x depth 300 = 614,400 handler calls, 7
  invariant functions after each call. 0 counterexamples, 0 reverts.
  3,808 s single-threaded.
- Differential: 2,048 runs x depth 300 = 614,400 calls; 153,082 claim
  pairs compared, 51,994 accepted by both twins, 529 overlapping first-line
  edits refused by v3 alone. 0 differences. 383 s.
- Stateless: 6 tests x 20,000 runs. 0 counterexamples.

Reach of the deep invariant campaign: 72,138 claim calls, 20,617 accepted
(14,572 per-share, 2,737 by a backup, 4,678 second- or third-line sweeps,
1,018 with a capped due after a drain); share ownership: 4,350 shares got
their first payee, 9,814 first-line claims were refused because someone
else owned the share, 9,840 sweeps left an owned share untouched; 36,257
NFT claim calls, 18,366 accepted, 1,742 item moves; 646 accepted
attestations; 3,494 / 3,592 / 3,801 / 3,305 / 1,250 accepted backup-line,
item, layer, executor and first-line edits; 0 of 36,165 stranger and
executor attempts got through.

The round 6 code had passed the same profiles (614,400 calls per suite in
the deep profile, 0 counterexamples) with the `lineClaimed` rule the round 7
reviews showed to be wrong; see 8.6.

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
line; v3 now refuses it), which is why such edits now go to v3 alone there.

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
- Tokens are mocks: a standard ERC-20, a no-return token and Permit2's
  mock. Fee-on-transfer, rebasing and blocklisting tokens, and payees whose
  transfers fail, are not modelled.
- The router is modelled by its checks, not deployed; a router change
  needs its own tests (K-1 in the audit scope).

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

# ShieldVault v2: tooling report

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
| `slither and aderyn` | Slither on each file with the deployed compiler settings and the triage database, `--fail-medium`; Aderyn on the two files; uploads both reports | a new Slither result at Medium or above; any Aderyn High |
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

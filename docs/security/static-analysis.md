# Static analysis: ShieldVault v2 and QuantumRecoveryRegistry

Run on 2026-10-27 against the working tree at the `v2026.09.29` source of
`contracts/shield/ShieldVault.sol` (unchanged since the mainnet deployment
of 2026-09-29; the mainnet bytecode match is recorded in
`docs/plans/shield-vault-audit.md`, section 2) and
`contracts/common/QuantumRecoveryRegistry.sol`.

Status of these contracts: internally reviewed, tooling-verified, not
independently audited. This file is one piece of that tooling evidence; the
whole picture is in `tooling-report.md`.

## Tools and settings

| Tool | Version | Invocation |
|---|---|---|
| Slither | 0.11.6 (crytic-compile 0.4.2) | `slither <file> --solc-remaps @openzeppelin=node_modules/@openzeppelin --solc-args '--via-ir --optimize --optimize-runs 200 --evm-version cancun' --filter-paths node_modules --triage-database slither.db.json --fail-medium` |
| solc for Slither | 0.8.35 via `solc-select` | Same settings as `hardhat.config.ts`, so the analysed code is the deployed shape |
| Aderyn | 0.6.8 | `aderyn . -s contracts -i contracts/shield/ShieldVault.sol,contracts/common/QuantumRecoveryRegistry.sol` |

Both tools run in CI (`.github/workflows/security.yml`, job
`static-analysis`) and locally with `npm run slither:shield` and
`npm run aderyn:shield`. Slither's 102 detectors and Aderyn's 88 detectors
all ran; `--filter-paths node_modules` keeps OpenZeppelin's own code out of
the result list (its use is in scope, the library is not).

## Verdict

No finding in either tool is a vulnerability. Slither reports 7 results on
ShieldVault (1 rated High, 2 Medium, 3 Low, 1 Informational), all triaged
below: the three rated Medium or above are detector false positives of a
well-known kind and are recorded in `slither.db.json` so that CI fails only
on something new. Slither reports 0 results on the registry. Aderyn reports
0 High and 5 Low on ShieldVault, all informational in substance, and
nothing on the registry.

## Slither: ShieldVault.sol (7 results)

| # | Detector | Slither severity | Where | Triage | Reason |
|---|---|---|---|---|---|
| S1 | `uninitialized-state` | High / High confidence | `_positions` (line 127), used in `open`, `positionOf`, `fallbackAvailableAt`, `_isHeld`, `_claimOwed`, `_open` | **False positive** | `_positions` is a `mapping(uint256 => Position)`; a mapping has no initialisation and is only ever written through a storage pointer (`Position storage p = _positions[id]; p.owner = ...` in `open`). The detector tracks direct assignments to the variable and does not follow storage references, which its own documentation lists as a limitation. Every read of `_positions[id]` for an id that was never opened is guarded by `_open` / `positionOf` (`owner == address(0)` reverts `UnknownPosition`) or, in `fallbackAvailableAt`, returns 0 by design. |
| S2 | `uninitialized-local` | Medium / Medium | `paid` in `executeFallback` (line 468) | **False positive** | `uint256 paid;` is an accumulator whose intended starting value is zero (`paid += amount` in the loop; the last beneficiary receives `total - paid`). Solidity zero-initialises locals; the detector flags any local declared without an explicit `= 0`. The remainder arithmetic is checked exactly by `testFuzz_fallbackSplitExact` and the invariant handler. |
| S3 | `uninitialized-local` | Medium / Medium | `sum` in `_validateConfig` (line 629) | **False positive** | Same pattern: `uint256 sum;` accumulates `sharesBps[i]` and is compared with `10,000`. The validator is differentially fuzzed against an independent mirror (`testFuzz_configValidation`). |
| S4 | `timestamp` | Low / Medium | `executePending`: `block.timestamp < p.pending.readyAt` (line 405) | **Informational, by design** | The exit delay is the product's security mechanism; comparing against `block.timestamp` at day granularity is the intent. On proof-of-stake Ethereum the timestamp is fixed by the slot; a proposer cannot move it by more than the slot's 12 seconds, which is irrelevant against delays of 7 to 90 days (`shield-vault-audit.md`, "Time assumptions"). |
| S5 | `timestamp` | Low / Medium | `executeFallback`: `block.timestamp < lastActivity + silence` (line 456) | **Informational, by design** | Same reasoning; silence periods are 180 to 1,095 days. |
| S6 | `timestamp` | Low / Medium | `_verify`: `block.timestamp > deadline` (line 569) | **Informational, by design** | Signature deadlines are the standard EIP-712 expiry pattern; a 12-second skew only shortens or lengthens a relayed signature's life by that much. |
| S7 | `cyclomatic-complexity` | Informational / High | `_validateConfig` (lines 618-640), complexity 13 | **Informational** | The validator checks nine independent rules on a config in one place. Splitting it would spread the rules over several functions without removing a branch. The function has 100% branch coverage and is fuzzed differentially against a mirror written from the spec. |

### Analysis gap to be aware of

Slither printed, before the results:

```
Impossible to generate IR for ShieldVault.constructor (EIP712.sol#68-77)
Impossible to generate IR for ShieldVault._EIP712Name (EIP712.sol#146-148)
Impossible to generate IR for ShieldVault._EIP712Version (EIP712.sol#157-159)
```

Slither 0.11.6 cannot build its intermediate representation for
OpenZeppelin 5.6's `EIP712` constructor and the two name/version accessors,
which use the `ShortString` user-defined value type with a storage fallback.
Detectors that work on IR therefore did not see those three functions
(the message names the `EIP712` base constructor as inherited by
ShieldVault; the source lines are OpenZeppelin's). The library code is out
of scope by the audit package's own terms, but the gap means IR-based
detectors have nothing to say about construction-time behaviour. That is
compensated by tests: the constructor's guards are covered by
`test/ShieldVault.branches.spec.ts` ("the constructor refuses a zero
registry and the setters refuse zero or self addresses"), and the domain
separator is checked against an independent EIP-712 computation
("domainSeparator is the EIP-712 domain of the deployed vault on this
chain"), as are signatures made under another chain's domain
(`testFuzz_checkInSignatureBindsEverything`). Slither's non-IR detectors
(naming, shadowing, pragma, assembly, low-level calls and the like) ran
over the whole contract and reported nothing.

### Detectors that ran and found nothing worth noting

Reentrancy (all four variants), unchecked transfers, arbitrary `send`,
`delegatecall`, `tx.origin`, `suicidal`, unprotected upgrade or
initializer, shadowing, incorrect equality, divide-before-multiply,
dangerous strict equalities, locked ether, unused return, assembly,
low-level calls, costly loops, pragma and solc version, naming convention,
dead code, external function visibility, too many digits, and the rest of
the default set: 0 results on both contracts. The absence of reentrancy
results is corroborated dynamically by the reentrancy probe spec
(`MockReentrantShieldToken`, all eight guarded functions) and the
`invariant_noReentrancySucceeded` invariant.

## Slither: QuantumRecoveryRegistry.sol

`0 result(s) found` with the same settings.

## Aderyn: ShieldVault.sol and QuantumRecoveryRegistry.sol

Aderyn counts 492 nSLOC for ShieldVault and 47 for the registry, matching
the audit package. 0 High. 5 Low, all on ShieldVault:

| # | Detector | Where | Triage | Reason |
|---|---|---|---|---|
| A1 | Centralization Risk | `Ownable2Step`, `setTokenSupported`, `setDepositsPaused`, `setFee`, `setFeeRecipient` | **Informational, by design** | The admin surface is exactly these four setters plus two-step ownership, and it is documented as such. The admin can curate tokens, pause new deposits, set the fee for positions opened later (hard cap 50 bps) and redirect uncollected fees. It cannot touch a position, an owed entry, a pin, a nonce or an exit. That claim is tested in the unit specs ("the admin surface is curation and the future fee only"), fuzzed in `testFuzz_adminCannotReachAPosition`, and checked after every admin call in the invariant handler (digest of all positions, owed entries and nonces unchanged). |
| A2 | Costly operations inside loop | `executeFallback` loop (line 469): `owed[id][bens[i]] += amount` | **Informational** | One `SSTORE` per held or unpayable beneficiary is the feature (the share is recorded for that beneficiary). The loop is bounded by `MAX_BENEFICIARIES = 10`. |
| A3 | Large Numeric Literal | `BPS = 10_000` (line 59) | **Informational, style** | `10_000` with a digit separator is the clearer spelling for basis points; `1e4` would be the suggested form. No behaviour difference. |
| A4 | Local Variable Shadows State Variable | `Position.feeBps` (line 114) vs the state variable `feeBps` (line 148) | **Informational** | A struct member named like the global rate. Every use is qualified (`p.feeBps` vs `feeBps`), the compiler does not warn, and the two deliberately mean "the rate this position opened with" and "the rate for positions opened from now on". Renaming is not possible without redeploying; the distinction is documented in the struct's NatSpec. |
| A5 | Loop Contains `require`/`revert` | `_validateConfig` loops (lines 630, 633) | **Informational, by design** | The loop validates a caller-supplied list and must refuse the whole config if any entry is bad; "forgive and continue" is the wrong behaviour for a validator. |

## What static analysis does not say

Neither tool reasons about the protocol's own invariants (delays, digest
binding, one sheet per position, exits never pausable). Those are the
subject of the fuzz and invariant suite under `test/foundry/` and of the
unit specs; see `tooling-report.md`. Neither tool models the external
tokens' behaviour (blacklists, pauses, fee-on-transfer, hooks), which the
suite approximates with `MockAwkwardERC20` and `MockReentrantShieldToken`.

# Static analysis: ShieldVault v2, QuantumRecoveryRegistry and legacy v3

The legacy v3 (wave B) results are in the last section, "Legacy v3".

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
| Slither | 0.11.6 (crytic-compile 0.4.2) | `slither <file> --compile-force-framework solc --solc-remaps @openzeppelin=node_modules/@openzeppelin --solc-args '--via-ir --optimize --optimize-runs 200 --evm-version cancun' --filter-paths node_modules --triage-database slither.db.json --fail-medium` |
| solc for Slither | 0.8.35 via `solc-select` | Same settings as `hardhat.config.ts`, so the analysed code is the deployed shape. `--compile-force-framework solc` is needed because the presence of `foundry.toml` would otherwise make crytic-compile pick Foundry and require `forge` |
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

## Legacy v3 (wave B): TransferEOALegacyV3, NftCollectionWhiteList, LegacyPullVaultV2

Run on 2026-11-05 on `feat/train-2026-11` after the round 6 fixes, and run
again after rounds 7 (share ownership, cross-layer and duplicate checks, the
shorter NFT pull) and 8 (validation only where it matters, `claimNfts`
claims the legacy before any pull) to `TransferLegacyEOAContractV3.sol`;
the tables below are the round 8 run. Status: internally reviewed,
tooling-verified, not independently audited; the external review is the
next step (`wave-b-audit-scope.md`). `LegacyPullVaultV2.sol` and the wave A
clone it inherits from are deployed and were analysed for the record only;
neither was changed.

| Tool | Version | Invocation |
|---|---|---|
| Slither | 0.11.6 (crytic-compile 0.4.2), Python 3.11.0 venv | the ShieldVault command above, on each of the three files |
| solc for Slither | 0.8.35 via `solc-select` 1.2.0 | same settings as `hardhat.config.ts` |
| Aderyn | **not run locally** | no Windows build of any 0.4+ release exists (the latest, 0.6.8, ships Linux and macOS only); the last Windows build, 0.3.4 (it reports 0.3.3), panics on solc 0.8.35 (`SvmError(ChecksumMismatch)` in its compiler manager); no WSL distribution or Rust toolchain is installed to run or build 0.6.8. Since round 7, CI runs Aderyn 0.6.8 on the three files on its Linux runner (`.github/workflows/security.yml`, job `static-analysis`, step "aderyn (legacy v3)"), report only |

Slither on `TransferLegacyEOAContractV3.sol` analyses the whole inheritance
chain, so 67 of its 91 results are in the wave A clone
(`TransferLegacyEOAContract.sol`), `GenericLegacy.sol` or shared interfaces.
Those are triaged for the record (they describe code that is live on
mainnet and cannot change); the 24 in v3 itself are triaged one by one.
`NftCollectionWhiteList.sol`: 2 results. `LegacyPullVaultV2.sol`: 2
results, both in interfaces it imports.

### Verdict

No open vulnerability. One true positive in v3, in pattern rather than in
reach, was fixed in round 6: v3's per-share settlement paid the claimant
before recording what the shares received, and relied on the router's
reentrancy guard for that. v3 now runs every token claim under its own
guard, shared with `claimNfts` (spec: "the legacy's own guard"). Slither
still reports the two reentrancy-eth results (W1, W2): its detector does
not credit a guard placed on an internal override, and the triage below
says why both are now unreachable. Separately, while modelling the spec for
the invariant suite, a liveness bug was found and fixed in the same
function (tooling report, section 8.6); Slither does not detect that kind
of bug.

Round 7 changed no verdict: the new `due == 0` equality (W6) is a false
positive of the same kind as W5, and `_pullNft` no longer reads the vault's
binding, so two `calls-loop` results are gone. The bugs round 7 fixed (share
ownership, a line coming back after a sweep, cross-layer and duplicate first
lines) are logic bugs no detector reports; the external reviews found them.

Round 8 changed no verdict either. Slither now reports the reentrancy-eth
pattern on `_transferAssetToBeneficiaries` three times instead of once (W2:
`eoaStorageToken` cleared in the token loop, on the v3 and the wave A path,
and `released` written in `_dues`), the `costly-loop` note on
`_setLegacyToInactive` is gone (it no longer runs inside the item loop), and
`claimNfts` gets an informational complexity note (W22). The `claimNfts`
CEI issue round 8 fixed (an owner contract acting from a transfer callback
while the legacy was still live) is cross-function and needs the owner's
cooperation; W4 flagged the late writes, not that path.

The Medium and High results are **not** added to `slither.db.json`. The
reentrancy-eth result on v3's `_transferAssetToBeneficiaries` gets a
different id on two identical runs (its description lists the external
calls in a varying order), so a triage entry cannot reliably hide it, and
each entry embeds the full source maps (the 19 would add about 90,000
lines). Since round 7, CI runs Slither on the three files without
`--fail-medium` (informational: the report is uploaded, nothing fails), so
a new result is seen in review and triaged here.

### Slither: results in TransferEOALegacyV3 (24)

| # | Detector | Slither severity | Where | Triage | Reason |
|---|---|---|---|---|---|
| W1 | `reentrancy-eth` | High / Medium | `_settle` (lines 349-380): `released`, `shareOwner` and `totalReleased` written after the payout call | **Fixed in round 6 (defensive); now a false positive** | Before round 6 the only protection was the router: every router path into a clone claim (`activeLegacy`, `activeLegacyFor`, `activeLegacyAndUnswap`) is `nonReentrant`, so a payee could not start a second settlement during its payout. The clone pins its router forever, so v3 now also runs `_transferAssetToBeneficiaries` under its own `ReentrancyGuardTransient` guard, the one `claimNfts` uses. During a payout, every other state-changing entry point is closed: the owner setters and router edits need a live legacy (activation happens before any payout), `attestDeath` needs a live legacy, and `receive()` records activity only from the owner while live. Spec: a payee that re-enters from its NFT callback is refused and gets its tokens normally afterwards. The invariant suite checks `released`/`totalReleased` against an independent model after every call. |
| W2 (3) | `reentrancy-eth` | High / Medium | `_transferAssetToBeneficiaries` (lines 312-340): the same writes reached through it, and `eoaStorageToken` cleared inside the token loop (reported once for the v3 path and once for the inherited wave A path) | **Same as W1** | Same call path and guard. Since round 7 the owner of a share is written only after value moved (never before, so an empty or failed claim owns nothing). Clearing `eoaStorageToken` only stops an unswap claim from treating the token as swapped; under the guard no other claim runs meanwhile. |
| W3 | `uninitialized-state` | High / High | `_nftItems` (line 106) | **False positive** | A `mapping(uint256 => NftItem[])` written through a storage pointer (`list.push(item)` in `setNftItems`); the detector does not follow storage references (same pattern as ShieldVault S1). |
| W4 | `reentrancy-no-eth` | Medium / Medium | `claimNfts` (lines 464-493): `_nftMoved` corrected and `shareOwner` written after `_pullNft` | **False positive since rounds 6 and 8** | `claimNfts` is `nonReentrant`, so a nested `claimNfts` is refused, and since round 6 a nested token claim is refused too: the shared guard covers the cross-contract path (an NFT callback calling `router.activeLegacy`, which calls back into the clone), shown by the spec "the legacy's own guard: no token claim runs inside an NFT move, whatever the router". Since round 8 the legacy is marked claimed before the first pull, so no owner or edit entry point is open during a callback either (spec "an owner contract cannot delete or edit the legacy from an NFT recipient's callback"); a call that moves nothing reverts, so the mark is undone (review L-2). The units are reserved (`_nftMoved += left`) before the call and corrected after it. The owner is written after the move on purpose (round 7: only value that moved makes an owner). |
| W5 | `incorrect-equality` | Medium / High | `_settle`: `available == 0` (line 358) | **False positive** | An early exit when nothing is pullable. No attacker-controlled balance is compared for equality; a dust donation only makes the settlement run. |
| W6 | `incorrect-equality` | Medium / High | `_dues`: `due == 0` (line 406, round 7) | **False positive** | Skips a share with nothing to pay (its due, after the cap) so it is neither recorded nor given an owner. |
| W7 | `uninitialized-local` | Medium / Medium | `only` in `_transferAssetToBeneficiaries` (line 321) | **False positive, by design** | `address(0)` means "every share nobody else owns" (a second- or third-line claim); a first-line claim sets it to the share. |
| W8 | `missing-zero-check` | Low / Medium | constructor `nftAllowlist_` (line 145) | **By design** | Zero is the documented "NFTs disabled" setting (`setNftItems` reverts `NftsDisabled`). The deploy script (`train-2026-11.ts`, wave B) asserts the recorded allowlist. |
| W9-W14 | `calls-loop` (6) | Low / Medium | `_pullNft` (3: `balanceOf`, the vault move, the direct move), `_transferAssetToBeneficiaries` (2: `balanceOf` per token, one per claim entry point), `setNftItems` (`kindOf` per item) | **Informational, bounded** | At most 50 items and `MAX_TRANSFER` (100) tokens per claim. Every NFT call is a low-level call whose failure skips that item (`amount == 0`), so a hostile collection cannot block the others. `kindOf` goes to the allowlist, fixed in code. |
| W15 | `reentrancy-events` | Low / Medium | `_settle`: `ShareClaimed` after the fee transfer | **Informational** | The event follows the transfers it describes, within the guard. |
| W16-W19 | `timestamp` (4) | Low / Medium | `_transferAssetToBeneficiaries` (backup window), `_nftPayee`, `attestDeath`, `_activationDeadline` | **By design** | Windows are 30 days to 10 years, the grace period 30 days, the attestation threshold half the trigger. A proposer's few seconds of skew are irrelevant at that scale. The fuzz test `testFuzz_backupWindowToTheSecond` pins each window to the second. |
| W20, W21 | `low-level-calls`, `too-many-digits` | Informational / High | `_pullNft`; `MAX_PERCENT = 1000000` (GenericLegacy) | **Informational** | The low-level calls are what keeps a bad collection from blocking a claim. `MAX_PERCENT` is wave A's constant. |
| W22 | `cyclomatic-complexity` | Informational / High | `claimNfts` (complexity 12, round 8) | **Informational** | The per-item rules (index in range, units left, payee, the move, ownership, the activation event) in one loop; every branch is exercised by the handler's NFT claims. |

### Slither: inherited wave A code, for the record (67)

| # | Detector | Slither severity | Where | Triage | Reason |
|---|---|---|---|---|---|
| A-W1 | `arbitrary-send-erc20` | High / High | `unswap` (line 187): `safeTransferFrom(sender_, ...)` | **False positive** | `sender_` is the owner, checked by `onlyOwner(sender_)` behind `onlyRouter`; the owner moves their own tokens with their own approval. |
| A-W2 | `arbitrary-send-erc20` | High / High | `activeLegacyAndUnswap` (line 646): `from` = the legacy owner | **By design** | Pulling the owner's tokens on a claim is the product; it needs the owner's allowance to the clone, and the claim conditions (deadline, layer) hold. |
| A-W3 | `arbitrary-send-eth` | High / Medium | `_sendEth` (lines 599-602) | **False positive** | Its only callers (`withdraw`, `deleteLegacy`, `unswap`) pay the checked owner. |
| A-W4 | `reentrancy-eth` | High / Medium | whole-estate `_transferAssetToBeneficiaries` (lines 750-862): `eoaStorageToken` cleared inside the token loop | **Accepted (router guard)** | The live clone relies on the router's `nonReentrant` on all three claim paths. In v3 the same code runs under v3's guard as well. |
| A-W5 | `reentrancy-no-eth` | Medium / Medium | `activeLegacyAndUnswap`: `eoaStorageToken` cleared after the WETH unwrap or the Uniswap swap | **Accepted** | The external calls go to WETH and the Uniswap router recorded at create; the router guard applies. Refused in v3 per-share mode (`UnswapNotInPerShareMode`). |
| A-W6-A-W13 | `unused-return` (8) | Medium / Medium | `autoSwap`, `unswap`, `_swapAdminFee`, `activeLegacyAndUnswap` (swap amount arrays), `_permit2Allowance`, `_vaultAllowance` (Permit2 nonce), `_setDistributions`, `_clearDistributions` (`EnumerableSet` booleans) | **By design, with one observation** | The swaps enforce their minimum inside Uniswap; the Permit2 nonce is irrelevant to an allowance read. The ignored `add` boolean in `_setDistributions` means a first line that lists an address twice is accepted and keeps that address's last percentage. Wave A then gives the remainder to the last listed beneficiary; in v3 per-share mode the shares would add up to less than 100% and the rest would stay in the owner's wallet. The live wave A clone keeps that behaviour. In v3 it is refused since round 7: `_checkConfig` (run by `setBackupLines` and after every beneficiary edit) requires the first line to sum to 100% over its distinct addresses, so per-share mode never turns on for such a legacy and an edit cannot create one (`FirstLineInvalid`). |
| A-W14-A-W67 | `calls-loop` (28), `timestamp` (5), `missing-zero-check` (4), `events-maths` (2), `reentrancy-benign` (2), `naming-convention` (6), `dead-code` (3), `low-level-calls` (2), `cyclomatic-complexity`, `unindexed-event-address` (round 8: the `costly-loop` note on `_setLegacyToInactive` is gone) | Low and Informational | wave A clone, `GenericLegacy`, interfaces | **Informational** | Bounded loops over at most 32 beneficiaries and `MAX_TRANSFER` tokens. Day-scale time checks. Initializer addresses supplied by the router. Interface names that match the external ABIs (`WETH()`, `DOMAIN_SEPARATOR()`). `GenericLegacy` helpers kept for storage-layout compatibility. |

### Slither: NftCollectionWhiteList.sol (2) and LegacyPullVaultV2.sol (2)

| # | Detector | Severity | Where | Triage |
|---|---|---|---|---|
| N1 | `assembly` | Informational | `getCollections`: `mstore(allowed, count)` | **By design**: a memory-safe shrink of the returned array to the allowed entries, in a view. |
| N2 | `cache-array-length` | Optimization | `getCollections` loop | **Informational**: a view over an admin-curated list; no change. |
| V1, V2 | `naming-convention` | Informational | `IPremiumLegacy.LEGACY_TYPE()`, `IAllowanceTransfer.DOMAIN_SEPARATOR()` | **Informational**: interface names fixed by the contracts they describe. Nothing in the vault itself. |

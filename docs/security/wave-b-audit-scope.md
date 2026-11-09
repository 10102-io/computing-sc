# Legacy v3 (wave B) and ShieldVault v3: scope for an external review

10102 Computing Legacy lets an Ethereum account name heirs for its tokens,
ETH and now NFTs, and hands them over when the owner has been inactive for
a chosen period. Version 3 of the per-owner legacy contract adds three
optional features. This document is the scope for an external review before
v3 goes to mainnet, together with ShieldVault v3 (its own section near the
end). Status: internally reviewed twice, then two independent
read-only reviews by other model families (a GPT-family and a
Gemini-family reviewer). Their first pass at `88838a4` found one High, two
Mediums and several Lows, fixed in rounds 7 and 8 or listed below; both
re-checked the fixes at `8bb8573`, and the Gemini reviewer confirmed the
round 8 diff at `4f58e6b` with no regressions. Round 10 (founder
decisions, 2026-11-09) then changed three things, listed in "What changed
since 4f58e6b": the claim fee is no longer swapped, the router's unswap
guard applies only when something would convert, and the wave B batch
upgrades the router for it. Two read-only cross-model reviews (a GPT-family
and a Gemini-family reviewer) then read round 10 and ShieldVault v3 after
the merge, at `d988e6b`: no Critical or High; one Medium (a token that
moves funds and returns `false` on the direct rail), two Lows and one Info,
fixed or accepted in round 11 (listed in "What changed since 4f58e6b" and
the known issues), plus the cases both found untested, now specified.
Tooling-verified (the evidence is in `tooling-report.md`, sections 8 and
9, and `static-analysis.md`, "Legacy v3" and "ShieldVault v3"). Not
independently audited: that is what this document is for.

**Commit to audit:** `COMMIT_TO_AUDIT` on branch `feat/wave-b-final` of
`computing-sc` (rounds 10 and 11 and ShieldVault v3, merged with `dev`;
the legacy contracts at `15bd140` equal `4f58e6b`). Later commits on the
branch touch documentation only, unless a fix list says otherwise.

## Files in scope

nSLOC counted with `solidity-code-metrics` 0.0.28 (`npx solidity-code-metrics <files>`).

| File | nSLOC | Role |
|---|---|---|
| `contracts/forwarding/TransferLegacyEOAContractV3.sol` | 327 | the v3 clone implementation (new) |
| `contracts/whitelist/NftCollectionWhiteList.sol` | 59 | the allowlist of NFT collections (new) |
| `contracts/common/LegacyPullVaultV2.sol` | 82 | the pull vault: in scope for its NFT rails (`pullERC721`, `pullERC1155`) and the implementation allowlist; deployed with wave A |
| `contracts/forwarding/TransferLegacyEOAContract.sol` | 571 | the clone code v3 inherits, at HEAD: in scope as v3's behaviour (whole-estate mode runs it as is) and for the round 10 and 11 changes (the fee, the direct rail). The deployed wave A clone (`0x2E2d…924C`) is this file at the tag `v2026.11.07`, unchanged on chain and out of scope (its exposure to the round 11 Medium is K-17) |
| `contracts/common/GenericLegacy.sol` | 83 | the shared base of both clones; in scope as v3's behaviour |
| `contracts/forwarding/TransferLegacyEOAContractRouter.sol` | 591 (file) | the EOA router, an upgradeable proxy deployed with wave A: in scope for the round 10 change in `activeLegacyAndUnswap` (the guard, 11 lines), which the wave B batch deploys. Its claim paths (`_runActiveLegacy`, `activeLegacyFor`, `activeLegacyAndUnswap`) are context: they decide who may claim when, and the clone trusts them (K-1) |

New code: 468 nSLOC (v3, the list, the vault). With the inherited code a
reviewer must read: 1,122. Counted on HEAD; round 10 made v3 7 nSLOC and
the base 25 nSLOC smaller, round 11 the base 9 larger. ShieldVault v3
adds 483 (its section).

## What changed since 4f58e6b

For the legacy contracts, `git diff 4f58e6b <commit to audit> --
contracts/forwarding/` is three files (and the Foundry suite). Round 10:

1. **`TransferLegacyEOAContract.sol` (the base v3 inherits): the claim fee
   without a swap.** In whole-estate `_transferAssetToBeneficiaries`, the
   ERC-20 fee was pulled into the legacy and swapped to ETH for `Payment`
   by `_swapAdminFee` with a zero minimum (K-6 before), falling back to
   the token. It now goes from the owner's wallet straight to
   `paymentContract` through `_transferErc20ToBeneficiary` on the rail the
   payout uses (direct allowance, Permit2 with the clone as spender, the
   vault), never through the legacy. `_swapAdminFee` is removed with its
   Uniswap approval; `uniswapRouter` stays for the owner's `unswap` and
   the unswap claim. The ETH fee is unchanged (ETH to `Payment`). A failed
   fee transfer returns 0 as before and never reverts the claim; the fee is
   then not collected and not owed (K-13).
2. **`TransferLegacyEOAContractV3.sol`: the same in `_settle`.** The fee
   goes to `Payment` after the payout, through a new private `_pay` (ETH
   from the legacy, a token from the owner's wallet on the share's rail),
   the helper the payout uses too. Accounting is unchanged: `totalReleased`
   still counts the whole amount, fee included.
3. **`TransferLegacyEOAContractRouter.sol`: the unswap guard only when the
   clone would convert something.** The `ZeroAmountOutMin` and
   `UnswapNeedsSoleRecipient` checks for a non-WETH storage token now apply
   only when `balanceOf(owner) != 0 && allowance(owner, legacy) != 0` for
   that token, which is `min(balance, direct allowance) != 0`: the amount
   every clone version with the unswap claim pulls (unchanged since the
   claim was added, 2026-02-26) and the condition under which the clone
   swaps. With nothing to convert the clone swaps nothing, so the caller's
   minimum is never used. The live mainnet vintages were checked
   read-only (`docs/plans/train-2026-11.md`, wave B item 5). No new
   function, storage layout unchanged; deployed by the wave B batch as a
   proxy upgrade without a reinitializer.

Round 11, after the cross-model reviews:

4. **The direct rail rolls back a transfer it counts as failed** (GPT
   review, Medium). `_transferErc20ToBeneficiary` used SafeERC20's
   `trySafeTransferFrom`, which returns `false` when a token moves the
   funds and then returns `false` (the Tether Gold pattern), while the
   move stays. In per-share mode `_settle` then recorded nothing, so a
   claimant could repeat the claim and drain the other shares (1,000
   tokens split 60/40: A claims again and again, B gets nothing); in
   whole-estate mode the remainder for the last beneficiary was computed
   too high. The Permit2 and vault rails already rolled back (Permit2's
   transfer reverts on `false`). The direct rail now calls a new external
   `pullDirect(token, from, to, amount)` on the legacy itself, which
   accepts only `msg.sender == address(this)` (`OnlySelf`) and uses
   `safeTransferFrom`; the call is wrapped in `try`, so a `false` return or
   a revert undoes whatever moved and counts 0, never a claim-wide revert.
   It holds no guard, so v3's claim guard around its caller does not refuse
   it; cost, one call to self per direct transfer. A token that always
   returns `false` (Tether Gold) therefore cannot be claimed on any rail of
   the new clones; it stays with the owner's wallet, accounted for. The
   deployed clones' exposure is K-17.
5. **The whole-estate fee after the beneficiaries** (Gemini review, L-1).
   `_transferAssetToBeneficiaries` pulled the fee first; with a finite
   allowance and a token that takes more than the amount, the last
   beneficiary's pull could then fail. The fee now goes after the loop,
   for ETH and tokens, as v3's `_settle` does; such a token leaves the fee
   uncollected instead (K-13). No invariant changes: the amounts are the
   same, only the order of the transfers.

Sizes: v3 23,490 bytes (24,470 before round 10, 23,517 after it), the
base 14,320 (15,426; 14,252), the router 23,398 (23,040).

## What v3 does

Each owner has one legacy, an EIP-1167 clone created by the router, with
first-line beneficiaries and percentages, and optionally a second and a
third line that take over after further delays. Assets stay in the owner's
wallet under an approval (to the legacy, the vault or Permit2) until the
owner has been inactive for the trigger; a claim then pulls them. v3 adds,
all off by default:

1. **NFTs.** The owner names ERC-721 and ERC-1155 items from allowed
   collections and the first-line beneficiary each goes to. A claim moves
   them through the vault or a direct approval; an ERC-1155 item can move in
   parts, and the rest stays owed.
2. **Backup lines (Premium), "per-share mode".** Each first-line share
   becomes its own account per token. A claim pays the share its percentage
   of everything that token ever made available, minus what it already
   received. The share's own beneficiary may claim from the deadline, its
   backups after one and two backup delays. A share belongs to the first
   address that receives anything from it (tokens, ETH or an NFT unit), on
   whatever line; from then on only that address receives from it. A
   second- or third-line claim takes only shares nobody else owns.
3. **An executor (Premium).** An address that is never a beneficiary may
   attest the owner's death after half the trigger of silence; claims then
   open 30 days later unless the owner shows any activity.

## Trust model

- **Owner:** configures everything while the legacy is live. Any setting,
  check-in or ETH sent to the legacy counts as activity and resets the
  deadline. Cannot act once a claim has activated the legacy.
- **First-line beneficiaries and their backups:** claim their own share in
  their window while nobody else owns it, never another's. Backups can
  never be the owner, a beneficiary on any line, the executor, or on two
  lines. In per-share mode no first-line primary is the second- or
  third-line beneficiary and the first line sums to 100% (checked when the
  mode is entered or changed; a first-line edit leaves the mode). The second
  and third lines may be one address, which then covers both periods.
- **Second and third lines:** in their period, take the shares (and items)
  nobody else owns, and own each share they are paid from.
- **Executor:** can only shorten the wait as described; never receives
  anything. The owner alert email on `DeathAttested` is a deploy
  precondition.
- **NFT allowlist admin** (the deployer key, the governance Safe as
  co-admin): decides which collections can be named. The list is read when
  items are named, never at claim, so a delisting cannot stop an heir.
- **Router** (an upgradeable proxy behind a 48-hour timelock): the only
  caller of the clone's claim and edit entry points. It passes the
  claimant's address and checks the claimant's layer and period after the
  clone call.
- **LegacyPullVaultV2** (immutable): pulls for an owner only when called by
  the legacy bound to that owner; the router binds, the owner may unbind a
  legacy that is no longer live.
- **External:** Permit2 (canonical), Payment (receives the claim fee as
  the token itself or ETH, capped at 50 bps when the legacy is created; the
  governance Safe withdraws it), PremiumSetting (the Premium gate), the
  Uniswap V2 router (the owner's `unswap` and the unswap claim only; the
  fee is never swapped).

## Invariants the tooling checks

From the Foundry suite (`test/foundry/LegacyV3*`), checked after every call:

- V1. Every call is accepted or refused exactly as the spec says, and moves
  exactly the amounts the spec says, to the right addresses.
- V2. No over-distribution: per token, owner + drained + paid out = all
  inflows; claims move exactly what the model pays, `Payment` receives each
  fee as the token itself (or ETH), or nothing when the handler makes it
  refuse the fee; the legacy and the vault keep nothing; shares' `released`
  sum to `totalReleased`.
- V3. No share's `released` exceeds its percentage of everything its token
  brought in plus the fees that could not reach `Payment` (they are
  counted as released and stay in the pot, K-13).
- V4. Once a share has paid an address, every later payment from it (later
  inflows, other tokens, ETH, its NFTs) goes to that address: a second or
  third line never receives from a share someone else owns, nor does a
  first-line member. `shareOwner` is the first payee observed, and an empty,
  failed or refused claim changes no owner.
- V5. No backup claims tokens or NFTs before its window.
- V6. The executor is never on a line, holds nothing and cannot move funds;
  strangers cannot either.
- V7. NFT units moved never exceed the units named, and units are conserved.
- V8. The deadline (with an attestation), per-share mode, the first line and
  the second and third lines match the model; whenever per-share mode is on,
  shares sum to 100% and no first-line primary is on the second or third
  line (repeated and cross-layer first lines, the router's combined setters
  and a second line equal to the third are all exercised).
- V9. Without backup lines, v3 behaves call for call as the wave A clone
  (a differential suite).

## Known issues and accepted risks

- **K-1. The clone trusts the router** for the claimant's identity and for
  the layer and period check, which the router does after the clone call. In
  per-share mode a router that skipped that check would let anyone sweep the
  unclaimed shares. The router is behind the timelock.
- **K-2. NFT claims do not pass through the router,** so an activation by
  NFT claim does not release the router's create flag; the owner calls
  `releaseCreateFlag` (accepted in review round 3).
- **K-3. When the owner's wallet shrank after an earlier claim** (spending,
  another approval, a drainer), what is left is paid in claim order, not
  pro rata: each first-line claim takes up to its own share's due, and a
  second- or third-line sweep fills the shares it covers in first-line
  order. A share paid less keeps the rest owed, and later inflows repay it,
  because the running totals keep it due. Pro rata is not done because a
  fair split across separate claims would need a snapshot of the shortfall
  at the moment of the drain, which the contract cannot see (the drain
  happens in the owner's wallet). Fixed in round 6: before, such a claim
  paid nothing.
- **K-4. `pot * percentage` overflows** for a token whose amounts approach
  2^236; such claims revert. No real token is affected.
- **K-5. A repeated or cross-layer first line** (the wave A code accepts a
  first line that lists an address twice, keeping its last percentage, or
  that names the second or third line) is accepted in whole-estate mode,
  where nothing strands: as on wave A, any first-line claim pays every
  first-line share and the last beneficiary takes the remainder. v3 refuses
  to enter per-share mode with one (`FirstLineInvalid`, round 7), and a
  first-line edit always leaves per-share mode, so one never exists there.
  Round 8 moved these checks there, so the router's combined setters
  (`setLegacyConfig`, `setBothLayer23Distributions`) pass through their
  transient states.
- **K-6. Resolved in round 10: the claim fee is no longer swapped.**
  Before, wave A's `_swapAdminFee` swapped it to ETH with a zero minimum
  (at most 50 bps of a claim exposed to a sandwich). v3 and the base it
  inherits send the token itself to `Payment`. The deployed wave A clone
  keeps the swap.
- **K-7. Windows do not close, and a sweep owns only what it paid.** Once
  the second line's period opens, it races a share's own line for an
  unowned share; the first payment decides who owns it. A sweep owns only
  the shares it actually paid from: a share with nothing pullable at that
  moment stays open to its own line and to the next sweep. Owning shares a
  sweep did not pay would reopen the empty-claim problem fixed in round 7
  (an empty claim taking a share without receiving anything).
- **K-8. Size.** 23,490 of 24,576 bytes at 200 runs (1,086 spare since
  round 11; 106 before the fee swap was removed). If a fix needs more,
  `_pullNft` (about 600 bytes) moves into a linked library first; the
  optimizer runs last. The router has 1,178 bytes spare.
- **K-9. Static analysis.** Slither is triaged in `static-analysis.md`. CI
  runs Slither and Aderyn on the three files on every PR, report only
  (Slither's ids for one v3 result are not stable across runs, so it cannot
  gate). Aderyn was not run locally (no Windows build).
- **K-10. Executor and auto-renew (deploy precondition).** An attestation
  sets the deadline to 30 days later, which is exactly the router's
  `AUTO_RENEW_WINDOW`, so the worker's auto-renew attestor (trusted,
  off-chain) could cancel it with owner activity from before the
  attestation. The router is deployed and stays as it is; the worker must,
  for a v3 legacy with `deathAttestedAt() > getLastTimestamp()`, submit
  `recordActivity` only for a nonce increase in a block after the
  attestation's block (`eth_getTransactionCount(owner, attestationBlock)`
  below the current nonce).
- **K-11. Rounding.** Each share's entitlement is floored on its own, so up
  to one unit per share per token can stay in the owner's wallet until the
  pot grows. Cumulative rounding (floors that always sum to the pot) is not
  used because with running totals it can make a share's entitlement fall
  as the pot grows (a share between cumulative bounds 0.5 and 0.6 is due 1
  of a pot of 5 and 0 of a pot of 6), which would over-distribute.
- **K-12. Fee-on-transfer and rebasing tokens.** Recorded amounts are
  nominal. Such tokens are not admitted to the token allowlist the app
  offers; a claimant who names one directly gets nominal accounting (a
  negative rebase behaves like a shrunk wallet, K-3). stETH's 1 to 2 wei
  transfer rounding is accepted.
- **K-13. A fee that cannot reach `Payment` is not collected, not owed,
  and never blocks a claim** (round 10 decision). The fee transfer (a token
  that reverts or blocklists `Payment`, a `Payment` that refuses ETH, a
  failing rail) returns 0 like any payout and the heirs' payout stands.
  The fee stays where it was, in the owner's wallet (the legacy, for ETH),
  as part of the estate: a later whole-estate claim distributes it (and
  takes a fee on it again). In per-share mode it is still counted as
  released, so `totalReleased` and the shares' `released` may exceed the
  inflows by the uncollected fees, while the fee itself flows into the pot
  and the shares receive it pro rata. Dues never exceed what is pullable,
  so nothing is paid twice (spec "the uncollected fee stays in the pot and
  is never paid twice"; Foundry V2 exact, V3 with that bound). Only the
  protocol fee is lost. Since round 11 the fee is the last transfer of a
  token or ETH settlement in both modes, after the payout it is taken on.
  A fee receiver or token that burns all the gas it is given costs the
  claimant gas (63/64 of what is left at the fee call), not the claim:
  with a gas limit that leaves enough after it, the claim completes and
  the fee is not collected (specs at a 10M gas limit).
- **K-14. The unswap claim and the router's guard.** (a)
  `activeLegacyAndUnswap` reads only the direct allowance (inherited from
  the deployed wave A clone; refused in per-share mode). With a Permit2 or
  vault approval nothing is swapped and nothing is lost: the heir takes
  the token claim, as the app does when there is nothing to swap. Since
  round 10 the router's guard uses the same rule, so such an heir may also
  use the unswap entry point with a zero minimum: nothing converts, and
  the listed tokens are paid on their rails (spec: a vault or Permit2
  approval plus a small direct allowance swaps the direct part and pays
  the rest on its rail in one call). (b) **Accepted (GPT review, Low;
  founder decision):** the guard trusts the storage token's `balanceOf`
  and `allowance`, which a hostile token can answer differently per
  caller: 0 to the router, the real values to an old clone, which then
  swaps at the caller's zero minimum (spec, on the live mainnet clone
  code). Kept, because the storage token is the owner's own choice and a
  hostile token already controls everything stored in it (it can move or
  freeze the balance at will), so the guard protects nothing more there.
  New clones are unaffected: they read the values themselves and keep
  both guards (spec).
- **K-15. NFT callback re-entry.** A recipient's ERC-721 or ERC-1155
  callback that calls `router.activeLegacy` re-enters the clone through the
  router; v3's guard, shared by token and NFT claims, refuses it (spec "the
  legacy's own guard: no token claim runs inside an NFT move, whatever the
  router"). Since round 8 `claimNfts` also marks the legacy claimed before
  the first pull, so an owner that is a contract or an EIP-7702 account
  cannot delete, withdraw from or edit the legacy from a recipient's
  callback (spec with a hostile owner contract).
- **K-16. Round 8 interface changes.** A `claimNfts` call that would
  activate the legacy but moves nothing reverts `NothingClaimed` (the claim
  mark is undone with it; review L-2). `DEATH_GRACE`, `MIN_BACKUP_DELAY`,
  `MAX_BACKUP_DELAY` and `MAX_NFT_ITEMS` are internal constants now (30 days,
  30 days, 3,650 days, 50; for size): the app uses the documented values.
- **K-17. Deployed clones and a token that moves funds and returns
  `false`** (the round 11 Medium, which only new clones fix; deployed
  clones cannot change). Affected tokens: those whose `transferFrom` moves
  the funds and still returns `false`; Tether Gold (XAUt) is the
  documented case (the weird-erc20 catalogue). Only on a direct approval
  to the clone; the Permit2 and vault rails revert on `false`. Exposure by
  clone version:
  - **the wave A clone** (`0x2E2d…924C`, mainnet and Sepolia; also
    Sepolia's v3 `0x057c…3993`, whose per-share mode has the reviewer's
    drain, testnet only): `trySafeTransferFrom` counts the move as
    failed. With a nonzero fee (new mainnet creates snapshot 25 bps) the
    fee moves into the legacy first and `_swapAdminFee`'s fallback
    `safeTransfer` to `Payment` reverts on `false`, so any claim that
    lists such a token reverts: the token cannot be claimed through the
    legacy, the other tokens can (spec). With a zero fee, or an amount
    whose fee rounds to 0, the whole-estate split is biased: an earlier
    beneficiary's move counts as 0, the last beneficiary is asked for the
    whole remainder and gets nothing, claim after claim (spec: 600, then
    840 of 1,000 to the first of two heirs, 0 to the second). Read-only
    on mainnet, 2026-11-09: no legacy uses this clone yet (44 legacies,
    all on older versions); it is the target of new creates until wave B.
  - **older versions** (every live mainnet legacy: the five clone
    implementations and the 21 full-bytecode legacies since 2026-02): the
    direct rail is `try transferFrom { return amount; }`, which ignores the
    return value, so such a move counts as paid and nothing is biased (spec
    on the live 2026-07-30 code). The opposite quirk applies there instead:
    a token that returns `false` without moving (old ZRX- or BAT-style
    failures) counts as paid while nothing moved, so that heir's payout is
    lost for that claim. Legacy 1 predates them; the 2025 versions either
    ignore the return value in the same way or revert the whole claim on
    `false`, so none is biased either. All seven live mainnet legacies
    snapshotted a zero fee.

  The app's token list (`TokenWhiteList`, admin-curated) should not offer
  tokens with either behaviour.

Fixed before this review, for context (`docs/plans/train-2026-11.md`,
review rounds 1 to 3 and 6 to 8): H-1 (the last claimer of a round took later
inflows; replaced by running totals), L-1 to L-5 (attestation timing, an
early NFT claim activating the legacy, backups becoming second-line
beneficiaries, backup windows after the second line, NFT activation
events). Round 6: K-3's fix and v3's own reentrancy guard. Round 7: share
ownership replaces `lineClaimed` (a backup could take its primary's later
inflows, and a share's own line could come back after the second line swept
it and lock the sweep out, even with an empty claim); the cross-layer and
100% checks. Round 8, after two cross-model re-reviews: those checks apply
only where they protect something (entering per-share mode, and layer edits
while it is on), so the router's combined setters work again; the
second-equals-third check is dropped (it strands nothing); `claimNfts`
claims the legacy before any external call. Round 10 (founder decisions):
the fee is no longer swapped (K-6), a failed fee is not owed (K-13), and
the router's unswap guard applies only when something would convert
(K-14). Round 11, after the cross-model reviews of round 10: the direct
rail rolls back a transfer it counts as failed (Medium; K-17 for deployed
clones), the whole-estate fee goes last (L-1), the router's trust in the
storage token is accepted (Low, K-14), ShieldVault v3 refuses to collect
fees to the token's own contract (Info), and the cases both reviews found
untested are specified.

## ShieldVault v3

A delayed, inheritable, quantum-vetoable holding of one ERC-20 per
position, not upgradeable. v3 is a new deployment next to the deployed v2
(mainnet `0xA1EA2F8C0518458975E09ED63bf5D48980f76C38`, which has never held
a position and whose fee for new holdings is 0). Status: internally
reviewed, tooling-verified, read by the two cross-model reviews of round 11
(one Info, fixed), not independently audited, not deployed. Built on
`feat/shield-vault-v3` (`df19774`), merged at `d988e6b`; the commit to
audit is the one above. Spec and reasons: `docs/plans/shield-vault.md`,
"v3"; evidence: `tooling-report.md` section 9 and `static-analysis.md`,
"ShieldVault v3".

| File | nSLOC | Role |
|---|---|---|
| `contracts/shield/ShieldVaultV3.sol` | 483 (Aderyn counts 494) | the vault (new) |
| `contracts/common/QuantumRecoveryRegistry.sol` | 47 | deployed, unchanged: where owners register the scheme-5 veto commitments a position pins; context |
| `contracts/shield/ShieldVault.sol` | 492 (Aderyn) | the deployed v2, unchanged; the reference v3 differs from, out of scope |

What v3 changes against v2 (outside comments, 16 lines added and 14
removed before round 11):

1. **The fee is taken on releases only.** `executeFallback` charges the
   position's rate (fixed at `open`, at most 50 bps) once, on the balance
   it releases, before the split. Withdrawals (`ALL` included), the veto,
   changes, cancels and both claims charge nothing; a held or failed share
   is recorded net and claimed whole.
2. **A payout the token reports as failed owes only what stayed in the
   vault** (checklist audit SV-L1). `_payOrOwe` reads the vault's balance
   before the transfer and, after a reported failure, again: a token that
   moves the funds and returns `false` is not paid a second time, from
   other positions, through `owed`; a partial move owes the rest.
3. **The token's own contract is refused as a payee wherever one is chosen
   at call time**: `requestWithdraw` and `claimOwedWithSig` destinations,
   `open` and `requestChange` beneficiaries, and since round 11
   `collectFees` while `feeRecipient` is the token (Gemini review, Info;
   `InvalidAddress`, the fees wait for `setFeeRecipient`). Not the veto's
   recovery wallet, which is inside the commitment.

Unchanged on purpose: every function, event, error and struct (v3's ABI is
v2's, fragment for fragment, tested), the constructor and admin surface,
the delays, the signed actions and their nonces, the EIP-712 domain
(`"10102 ShieldVault"`, `"2"`) and the veto tag. Both bind the vault's
address, so nothing signed or committed for one vault verifies on the
other: round 11 specifies it both ways (a check-in and a cancel signed for
the other vault, and a sheet committed for it, are refused, no nonce
spent).

**Trust model.** The owner opens, deposits, checks in and requests a
withdrawal or a change of beneficiaries and sheet, each waiting the exit
delay (7, 30 or 90 days), cancellable and vetoable meanwhile. After the
silence period (180 to 1,095 days) anyone may release the balance to the
beneficiaries; a `holdMask` share waits for its key's signed claim. Whoever
holds the recovery secret may veto at any time, to the recovery wallet
committed with it. The admin (the governance Safe, `Ownable2Step`) curates
tokens, pauses new deposits, sets the release fee for positions opened
later and the fee recipient; it cannot reach a position, an owed entry, a
pin or a nonce. Exits are never pausable. Listed tokens: wstETH, USDC,
USDT and WETH, under the curation rule of `shield-vault.md` ("Tokens"):
the sender is debited exactly the amount, no hooks, a `balanceOf` that
never reverts (v3 no longer needs a truthful `false`).

**Invariants the tooling checks** (Foundry, after every call of a
26-operation handler with an exact payout model, a lying token and the
token contracts in the payee pool): the handler saw no violation, solvency
per token (vault balance = positions + owed + fees + donations), an open
position is funded, pending operations are consistent, stored configs are
valid, a closed position is terminal, the fee is fixed at open and at most
50 bps, veto digests are disjoint and pinned, fees come only from releases,
no reentrancy succeeded. Plus 15 stateless properties, among them
`testFuzz_falseReturnOwesOnlyWhatStayed` and
`testFuzz_gasLimitCannotForceOwed`.

**Known issues and accepted risks.**

- **SK-1. A token that debits more than the amount** takes the excess
  from the other positions in that token, whether it returns `true` or
  `false`. v3 owes nothing for it (no double payment), but cannot see the
  shortfall (spec, round 11). Excluded by the curation rule.
- **SK-2. A token that burns all the gas of one transfer.** With a gas
  limit that leaves enough after the 63/64 forwarded, a release completes
  and that payee's share is owed (spec at 10M gas); a caller cannot choose
  a gas limit that turns a payable payout into an owed one
  (`testFuzz_gasLimitCannotForceOwed`). `collectFees` to such a recipient
  reverts and the fees wait; fees never sit in the path of an exit.
- **SK-3. A fee recipient that is a listed token's contract** blocks
  collecting that token's fees until the Safe sets another recipient (round
  11). Nothing is lost.
- **SK-4. v2's accepted limitations hold for v3 unchanged**
  (`shield-vault.md`, "Known limitations"): nonces are per signer and
  purpose, not per position; a signed cancel binds the id and `readyAt`,
  not the operation; EIP-7702 accounts count as contracts for the held-share
  guard and for signatures.
- **SK-5. Static analysis gap.** Slither cannot build IR for OpenZeppelin's
  `EIP712` constructor and accessors; covered by the constructor and domain
  specs (`static-analysis.md`). CI gates v3 with `--fail-medium` over
  `slither.db.json` (v2's three false positives under v3's names) and with
  Aderyn's "no High".

## Out of scope

Wave A, which is deployed on Sepolia and mainnet (executed on mainnet
2026-11-07): the router except its round 10 change, the timelock and
premium contracts, the consent verifier, the wave A clone as used by
existing legacies (the tag `v2026.11.07`; its known exposure is K-17), the
ERC-20 path of LegacyPullVaultV2, the deployed ShieldVault v2 and the
recovery registry (context for ShieldVault v3). Also
the app, the subgraph and the worker, except where a finding needs one of
them to change.

## Building and testing

Windows PowerShell or any shell; Node 22.

```powershell
npm ci
git submodule update --init          # lib/forge-std
npx hardhat compile
npx hardhat test                     # full suite; v3 is test/Train2026-11.v3.spec.ts
npx hardhat test test/Train2026-11.v3.spec.ts test/Train2026-11.fee.spec.ts test/Train2026-11.oldclones.spec.ts test/Train2026-11.review.spec.ts
$env:HARDHAT_NO_FORK="1"; npx hardhat test test/ShieldVault.spec.ts test/ShieldVault.branches.spec.ts test/ShieldVaultV3.spec.ts test/QuantumRecoveryRegistry.spec.ts
$env:HARDHAT_NO_FORK="1"; npx hardhat coverage --testfiles "test/{ShieldVault,ShieldVault.branches,ShieldVaultV3,QuantumRecoveryRegistry}.spec.ts"   # alone: it instruments artifacts/
forge test --match-path "test/foundry/**" -vv                     # Foundry v1.8.6, CI profile, every suite
$env:FOUNDRY_PROFILE="deep"; forge test --match-path "test/foundry/LegacyV3*" -vv
$env:CLONE="contracts/forwarding/TransferLegacyEOAContractV3.sol:TransferEOALegacyV3"; npx hardhat run scripts/check-clone-reproducible.ts
```

Slither, with solc 0.8.35 selected and Foundry on the PATH (the same
command on `contracts/forwarding/TransferLegacyEOAContractRouter.sol` for
the router; on `contracts/shield/ShieldVaultV3.sol` add
`--triage-database slither.db.json --fail-medium`, as CI does):

```powershell
slither contracts/forwarding/TransferLegacyEOAContractV3.sol --compile-force-framework solc --solc-remaps "@openzeppelin=node_modules/@openzeppelin" --solc-args "--via-ir --optimize --optimize-runs 200 --evm-version cancun" --filter-paths node_modules
```

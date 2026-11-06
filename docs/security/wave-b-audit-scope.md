# Legacy v3 (wave B): scope for an external review

10102 Computing Legacy lets an Ethereum account name heirs for its tokens,
ETH and now NFTs, and hands them over when the owner has been inactive for
a chosen period. Version 3 of the per-owner legacy contract adds three
optional features. This document is the scope for an external review before
v3 goes to mainnet. Status: internally reviewed twice, tooling-verified (the
evidence is in `tooling-report.md`, section 8, and `static-analysis.md`,
"Legacy v3"), not independently audited.

**Commit to audit:** `c9d66076053c4af5930ae8790baaeed876c69a33` on branch
`feat/train-2026-11` of `computing-sc` (the round 6 fixes, `2dca935`, and
the Foundry suite on top). Later commits on the branch touch documentation
only, unless a fix list says otherwise.

## Files in scope

nSLOC counted with `solidity-code-metrics` 0.0.28 (`npx solidity-code-metrics <files>`).

| File | nSLOC | Role |
|---|---|---|
| `contracts/forwarding/TransferLegacyEOAContractV3.sol` | 325 | the v3 clone implementation (new) |
| `contracts/whitelist/NftCollectionWhiteList.sol` | 59 | the allowlist of NFT collections (new) |
| `contracts/common/LegacyPullVaultV2.sol` | 82 | the pull vault: in scope for its NFT rails (`pullERC721`, `pullERC1155`) and the implementation allowlist; deployed with wave A |
| `contracts/forwarding/TransferLegacyEOAContract.sol` | 587 | the wave A clone, which v3 inherits; in scope as v3's behaviour, not as a standalone contract (it is deployed and will not change) |
| `contracts/common/GenericLegacy.sol` | 83 | the shared base of both clones; same terms |

New code: 466 nSLOC. With the inherited code a reviewer must read: 1,136.
The router's claim paths (`TransferLegacyEOAContractRouter.sol`,
`_runActiveLegacy` and `activeLegacyAndUnswap`) are context: they decide who
may claim when, and the clone trusts them (K-1).

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
   backups after one and two backup delays. A second- or third-line claim
   takes only shares whose own line never claimed.
3. **An executor (Premium).** An address that is never a beneficiary may
   attest the owner's death after half the trigger of silence; claims then
   open 30 days later unless the owner shows any activity.

## Trust model

- **Owner:** configures everything while the legacy is live. Any setting,
  check-in or ETH sent to the legacy counts as activity and resets the
  deadline. Cannot act once a claim has activated the legacy.
- **First-line beneficiaries and their backups:** claim their own share in
  their window, never another's. Backups can never be the owner, a
  beneficiary on any line, the executor, or on two lines.
- **Second and third lines:** in their period, take the shares (and items)
  whose own line never claimed.
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
- **External:** Permit2 (canonical), Payment (the claim fee, capped at 50
  bps when the legacy is created), PremiumSetting (the Premium gate), the
  Uniswap V2 router (fee swaps only).

## Invariants the tooling checks

From the Foundry suite (`test/foundry/LegacyV3*`), checked after every call:

- V1. Every call is accepted or refused exactly as the spec says, and moves
  exactly the amounts the spec says, to the right addresses.
- V2. No over-distribution: per token, owner + drained + paid out = all
  inflows; claims move exactly what the model pays; the legacy and the vault
  keep nothing; shares' `released` sum to `totalReleased`.
- V3. No share ever receives more than its percentage of everything its
  token brought in.
- V4. A share claimed by its own line is never paid to the second or third
  line (`lineClaimed`).
- V5. No backup claims tokens or NFTs before its window.
- V6. The executor is never on a line, holds nothing and cannot move funds;
  strangers cannot either.
- V7. NFT units moved never exceed the units named, and units are conserved.
- V8. The deadline (with an attestation), per-share mode and the first line
  match the model; shares sum to 100%.
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
  another approval, a drainer), the shares in a claim are paid what is there,
  filled in first-line order, and keep the rest owed. The pot shrinks with
  the wallet, so every share bears the loss in proportion. Fixed in round 6:
  before, such a claim paid nothing.
- **K-4. `pot * percentage` overflows** for a token whose amounts approach
  2^236; such claims revert. No real token is affected.
- **K-5. Duplicate first-line addresses.** The wave A initializer accepts a
  first line that lists an address twice; the address keeps its last
  percentage. Wave A gives the remainder to the last beneficiary; in v3
  per-share mode the shares sum below 100% and the rest stays in the owner's
  wallet. The router and the app never send duplicates; a check in v3 does
  not fit the size budget.
- **K-6. The claim fee is swapped to ETH with a zero minimum** (wave A
  `_swapAdminFee`): at most 50 bps of a claim is exposed.
- **K-7. Windows do not close.** Once the second line's period opens, it
  races a share's own line for an unclaimed share; the first claim decides.
- **K-8. Size.** 24,457 of 24,576 bytes at 200 runs: a fix must fit in 119
  bytes or trim (the `primaryOf` and `nftItemCount` views first).
- **K-9. Static analysis.** Slither is triaged in `static-analysis.md`;
  Aderyn was not run on v3, and CI runs neither tool on these files yet.

Fixed before this review, for context (`docs/plans/train-2026-11.md`,
review rounds 1 to 3): H-1 (the last claimer of a round took later inflows;
replaced by running totals), L-1 to L-5 (attestation timing, an early NFT
claim activating the legacy, backups becoming second-line beneficiaries,
backup windows after the second line, NFT activation events). Round 6
(2026-11-05) added K-3's fix and v3's own reentrancy guard, shared by token
and NFT claims.

## Out of scope

Wave A, which is deployed on Sepolia and mainnet (the mainnet batch executes
2026-11-07): the router, the timelock and premium contracts, the consent
verifier, the wave A clone as used by existing legacies, the ERC-20 path of
LegacyPullVaultV2, ShieldVault and the recovery registry. Also the app, the
subgraph and the worker, except where a finding needs one of them to change.

## Building and testing

Windows PowerShell or any shell; Node 22.

```powershell
npm ci
git submodule update --init          # lib/forge-std
npx hardhat compile
npx hardhat test                     # full suite; v3 is test/Train2026-11.v3.spec.ts
npx hardhat test test/Train2026-11.v3.spec.ts
forge test --match-path "test/foundry/LegacyV3*" -vv              # Foundry v1.8.6, CI profile
$env:FOUNDRY_PROFILE="deep"; forge test --match-path "test/foundry/LegacyV3*" -vv
$env:CLONE="contracts/forwarding/TransferLegacyEOAContractV3.sol:TransferEOALegacyV3"; npx hardhat run scripts/check-clone-reproducible.ts
```

Slither, with solc 0.8.35 selected and Foundry on the PATH:

```powershell
slither contracts/forwarding/TransferLegacyEOAContractV3.sol --compile-force-framework solc --solc-remaps "@openzeppelin=node_modules/@openzeppelin" --solc-args "--via-ir --optimize --optimize-runs 200 --evm-version cancun" --filter-paths node_modules
```

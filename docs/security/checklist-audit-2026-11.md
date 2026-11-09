# Checklist audit, 2026-11-02

An internal checklist pass on the contracts that never had a third-party
audit, done before the 2026-11 contract train. **It is not an independent
audit**: the reviewers are AI agents working from public checklists, and
every finding below was re-checked by hand against the code and, where it
mattered, against mainnet state.

## Scope and method

| Area | Files |
|---|---|
| ShieldVault | `contracts/shield/ShieldVault.sol` (unchanged since `v2026.09.29`, not a proxy) |
| LegacyPullVault and its callers | `contracts/common/LegacyPullVault.sol`, the vault paths in `TransferLegacyEOAContract.sol` and `TransferLegacyEOAContractRouter.sol` |
| UpgradeTimelock and roles | `contracts/common/UpgradeTimelock.sol`, `scripts/harden-governance.ts`, `scripts/verify-governance.ts` |
| EOA auto-renew | router `setActivityAttestor`, `setAutoRenew`, `recordActivity`; the worker's `auto-renew.ts` |
| QuantumRecoveryRegistry | `contracts/common/QuantumRecoveryRegistry.sol` and the app's use of it |

Checklists: the ethskills EVM audit set
(`github.com/austintgriffith/evm-audit-skills`), pinned at revision
`ffe4b670e78e1945bcf275f79d4b7b0481bcff35` and fetched on demand: general,
precision-math, erc20, signatures, access-control, proxies, governance and
dos, as each area needed. One read-only reviewer per area, then
deduplication and verification here. Already-triaged items in
`static-analysis.md` were not re-reported.

## Mainnet state checked (2026-11-02, block 26,330,344)

- `TransferEOALegacyRouter.pullVault()` and `legacyImplementation()` match
  `contract-addresses.json`; `verify-governance.ts` passes 27/27.
- No `TransferEOALegacyAutoRenewSet` or `TransferEOALegacyAutoRenewed` event
  since the feature shipped: no legacy has opted in, so the auto-renew
  findings below have affected no one, and the attestor key exposed in the
  2026-10-21 Railway incident never renewed anything.
- Of 7 live EOA legacies: none has a direct USDT allowance to its clone
  (M-2), one has a non-WETH storage token but nothing pullable right now
  (M-4), none is an activated legacy still bound in the vault (M-1).
- UpgradeTimelock: 2 operations ever scheduled, none left open (L-2).

## Findings and what was done

No Critical or High. Severity is the reviewer's, confirmed here.

| Id | Finding | Live today | Done 2026-11-02 | Left |
|---|---|---|---|---|
| AR-M | The worker renewed on activity the countdown had already counted: it compared the owner's nonce with its own last attestation (0 at first), so an opt-in or check-in transaction counted as new activity, and an owner who checked in and then died got one renewal (a delay of nearly a full period). | No opt-ins | Worker: renew only when the owner's nonce is above its value at the block where the countdown last restarted (`getLastTimestamp`, historical read; skip if unavailable), tested | none |
| AR-L1 | Renewals look like check-ins to beneficiaries: the subgraph indexes no auto-renew event, and the worker sends the same "was reset" email. | No opt-ins | | subgraph handlers; a distinct email when the tx carries `TransferEOALegacyAutoRenewed` |
| AR-L2 | With a period of 30 days or less the renewal window never closes, so an owner sending cheap transfers made the attestor send `recordActivity` every tick. | No opt-ins | Worker: renewals at least a day (or half the period) apart | relayer/attestor key split (founder) |
| M-1 | An activated legacy stays bound in the vault (release happens on delete only); its beneficiaries can front-run the owner's next create, use the new permit, and pull the new allowances through the old legacy. | No such binding | | app: when `boundLegacy(owner)` is not live, create with an empty bundle first (re-binds), then set allowances; contract: in feat/train-2026-11, not deployed |
| M-2 | The clone's direct ERC-20 rail is `try IERC20.transferFrom` with a `bool` return: USDT returns nothing, the decode failure is not caught, and the whole claim (and its fee pull) reverts. In every EOA clone since 2025-08. | No direct USDT allowance | | contract: in feat/train-2026-11, not deployed; app: route USDT through Permit2 only |
| M-3 | The code admin key moves `setPullVault` / `setLegacyImplementation` without the timelock; the app read the vault live and signed unlimited permits for whatever it returned. | Key not compromised | App pins the vault (`pullVault` in the generated addresses, `PullVaultMismatchError`); `verify-governance.ts` checks vault and implementation; the worker alerts on `PullVaultSet`, `ActivityAttestorSet` and an implementation change; `upgrade-timelock.md` corrected | router: in feat/train-2026-11, not deployed; app: pin the implementation before direct approvals |
| M-4 | The unswap claim swaps a non-WETH storage token with the caller's minimum, which the app set to 0: sandwichable. | 1 legacy, nothing pullable now | App quotes the router (`getTokenToEthAmountOut`) and accepts at most 2% less; the claim card points to the no-swap claim | contract: in feat/train-2026-11, not deployed (`_swapAdminFee` unchanged by decision, see `docs/plans/train-2026-11.md`) |
| L-1 (vault) | Delete revokes only the ERC-20 approvals, never the Permit2 allowance to the vault, which the owner's next legacy inherits. | | | app: Permit2 `lockdown` per (token, vault) on delete |
| L-2 | A ready timelock operation never expires and anyone may execute it; `verify-governance.ts` reported pending ones as fine. | None open | Script fails on a ready, unexecuted operation | cancel superseded operations as a rule (runbook) |
| SV-L1 | ShieldVault's listing rule did not require a truthful transfer return value; a token that moves funds but returns `false` would be paid twice through `owed`. | Not with wstETH, USDC, USDT, WETH | Listing rule in `shield-vault.md` | none |
| QR-L | The dashboard counted ShieldVault veto digests (same registry, scheme 5) as the account's quantum recovery path. | Any ShieldVault user with a sheet | App counts only commitments not registered by a ShieldVault (v1 or v2), tested | document that scheme 5 carries two preimage formats |

Info items, recorded and not acted on: ShieldVault trusts ERC-1271
signatures completely (a wallet that accepts anything harms only its own
positions); payee addresses are not checked against the token contract
(client-side check to add); two ShieldVault comments describe old
behaviour (`collectFees` pays the current `feeRecipient`; a sheet holder
must filter `PositionOpened` by owner); a position with no veto and no
fallback locks for good if the key is lost (warn in the UI); the dashboard
quantum digest is a bare `keccak256(secret)`, safe only for a future
verifier that does not take a plain on-chain reveal; the registry has no
invariant test of its own; `UpgradeTimelock.sol` NatSpec still names the
maintainer as PROPOSER and CANCELLER (deployed source, left as is).

ShieldVault v3 (2026-11-09, `contracts/shield/ShieldVaultV3.sol`, built and
tooling-verified, not deployed; `shield-vault.md` "v3") folds in the
ShieldVault items: SV-L1 on-chain (a payout the token reports as failed
owes only what stayed in the vault), the payee check against the token
contract (on-chain for withdrawal addresses, beneficiaries and signed-claim
destinations; not for the recovery wallet, which is inside the commitment),
the two stale comments, and QR-L's note that scheme 5 carries two preimage
formats (`shield-vault.md`, "Scheme 5 carries two preimage formats"). The
ERC-1271 trust and the warning for a holding with neither sheet nor
fallback stay as recorded: no contract change.

## Checked and fine (summary)

- **ShieldVault:** reentrancy guards on every token-moving function,
  bounded loops, fee rounding, owed accounting for blocklisted payees and
  paused tokens, EIP-712 domains and typehashes, per-purpose nonces, no
  admin reach into positions, the low-gas payout griefing path (Q9)
  infeasible.
- **LegacyPullVault:** `bind` router-only with the clone codehash and owner
  checked, `pull` and `release` only by the bound legacy, no cross-owner
  pull, no admin or initializer.
- **Clone and router:** clone deploy and init in one transaction, owner
  immutable, vault pinned at init, appended storage (router slots 12-16,
  clone slot 25), sponsored authorisations bound to legacy, chain, router
  and nonce.
- **Governance:** the timelock administers itself, `updateDelay` only
  through itself, EXECUTOR open by design, all mainnet proxies under
  `DefaultProxyAdmin`, owned by the timelock.
- **Auto-renew:** a compromised attestor can delay activation by at most 12
  months plus one period, never accelerate it or touch funds; the owner can
  always disable; renewals and claims can never both be valid.
- **QuantumRecoveryRegistry:** writes only to the caller's own history,
  append only, no admin, no proxy; events complete; the app's hashing
  matches the contract.

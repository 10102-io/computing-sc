# LegacyPullVault — one permanent, verified Permit2 spender

Status: **live on mainnet** (2026-07-30, see §6c). Companion frontend work
tracked in `computing/docs/DEFERRED.md` (`permit2-spender-trust`).

## 1. Problem

Create-flow v2 registers the creator's Permit2 `AllowanceTransfer` batch with
the **CREATE2-predicted legacy clone** as spender. At signing time that
address has no code, so Blockaid/MetaMask classify it as an "untrusted EOA"
and show a red *"This is a deceptive request"* interstitial — the canonical
drainer fingerprint — on the happy path of every create. Three independent
expert reviews (2026-07-28) converged: the trigger is **who** the spender is,
not the unlimited amount, and a per-user counterfactual spender can never be
allowlisted, Etherscan-verified, or given an ERC-7730 clear-signing
descriptor. See `computing/docs/DEFERRED.md → permit2-spender-trust`.

## 2. Design

One new contract plus surgical changes to the EOA router and clone impl.

### `contracts/common/LegacyPullVault.sol` (new, ~1.5 KiB)

Immutable, admin-free singleton. Constructor pins `(router proxy address,
clone implementation)` and derives the EIP-1167 runtime **codehash** of the
implementation.

| Function | Access | Behavior |
|---|---|---|
| `bind(owner, legacy)` | router only | requires genuine pinned-codehash clone, `legacy.getLegacyOwner() == owner`, and no existing **live** binding (a non-live binding — deleted/claimed — may be replaced). |
| `release(owner)` | bound legacy only | clears the binding (called from the clone's delete path). |
| `pull(owner, token, to, amount)` | bound legacy only | `PERMIT2.transferFrom(owner, to, amount, token)` — Permit2 enforces the owner's signed amount + expiration per pull. |
| `boundLegacy(owner)` / `cloneCodehash()` | view | discovery for clones, frontend, and audits. |

### Router (`TransferEOALegacyRouter`)

- `address public pullVault` — **appended** storage (packs into slot 14 after
  `createPaused`; verified append-only via `dump-storage-layouts.ts`).
- `setPullVault(address)` — `onlyCodeAdmin`, same role that swaps the clone
  implementation (vault and impl rotate together; `address(0)` disables).
- `createLegacyV2` accepts the permit bundle spender being **either** the
  vault (preferred) **or** the fresh clone (pre-vault frontends unchanged).
- `_createLegacyCore` binds `owner → legacy` in the vault after clone
  initialization (clone path only — the codehash pin rejects full-bytecode
  deploys by design). Bind failure fails the create (not best-effort),
  otherwise a vault-spender permit would be unusable at claim time.

### Clone impl (`TransferEOALegacy`)

- **Pins its vault at `initialize`** in appended storage (`pullVault`,
  slot 25 — new clones only; no initializer signature change). Read from the
  router via a guarded staticcall, so routers that predate the vault surface
  degrade to "no vault" instead of failing the create. All later vault
  interactions use the pinned address — see the rotation rule in §4 for why
  this matters (HIGH finding in the review round).
- Claim path picks, per token, the **most generous of three rails**:
  direct ERC-20 allowance, Permit2-with-clone-as-spender, Permit2-via-vault
  (only when this clone is the owner's bound legacy). Same
  `min(balance, allowance)` semantics as before. The admin-fee pull rides the
  same guarded rails: a non-pullable fee is forfeited, never a claim-wide
  revert.
- `deleteLegacy` releases the binding in the pinned vault, best-effort
  (bind-over-non-live is the backstop if release ever fails).

## 3. Trust model (deliberately narrower than router-as-spender)

- The vault has **no admin and no upgrade path**; behavior frozen at deploy.
- Only the legacy **bound to an owner** can move that owner's funds, only
  through Permit2's per-owner accounting, only within the signed
  amount/expiration envelope.
- First-write-wins: an owner with a live legacy can never be re-pointed, even
  by a hostile router upgrade.
- Residual risk, honestly: a compromised code admin could bind a
  genuine-bytecode clone with attacker config to an owner with **no** live
  binding — but that role can already swap the clone impl for new creates
  today, so the vault does not widen the admin trust surface. Pair with a
  timelocked proxy admin (separate track).
- Owner escape hatches unchanged: Permit2 `lockdown`/`approve(0)` and
  `deleteLegacy` at any time.

## 4. Rotation rule

The codehash pin means **a new clone implementation requires a new vault**.
`scripts/deploy-pull-vault.ts` reads the router's current
`legacyImplementation()` and pins exactly that; always run it after
`deploy-eoa-clone-impl.ts`.

Rotation is safe for existing legacies **by construction**: each clone pins
the vault address in its own storage at `initialize` (appended slot, new
clones only) and pulls through that pinned vault forever. A `setPullVault`
rotation therefore only affects *future* creates — it can never strand the
already-signed permits of a pre-rotation legacy whose owner may since have
died. (The first cut resolved the vault live via `router.pullVault()`, which
the adversarial review flagged as a HIGH: rotation would have orphaned every
pre-rotation vault permit. Fixed by pinning.)

## 5. Deployment + trust-registry checklist (per network)

1. Upgrade router proxy (vault-aware impl) — `upgrade-router-proxy.ts`.
2. (If rotating impl) `deploy-eoa-clone-impl.ts`.
3. `deploy-pull-vault.ts` — deploys, wires, Etherscan-verifies, saves to
   `contract-addresses.json`.
4. Sourcify-verify the vault.
5. Register the vault + dapp domain with Blockaid (report.blockaid.io) and
   MetaMask's false-positive portal — now possible because the spender is
   **one stable address**.
6. Submit an ERC-7730 clear-signing descriptor for
   `Permit2.permit(... spender = vault)` so wallets render a named permission.
7. Frontend: sign permit batches with `spender = router.pullVault()` when
   set; fall back to predicted-clone spender otherwise. Update
   `useApprovalAmount` to also read the vault allowance.
8. Subgraph: optionally index `LegacyBound`/`LegacyReleased` for audit UX.

## 6. Test coverage

`test/LegacyPullVault.spec.ts` (17 cases): vault-spender create → bind →
claim through vault (60/40 split); pre-vault clone-spender back-compat;
spender-mismatch revert; bind gating (router-only, codehash pin vs EOA and
non-clone contract, owner mismatch, live-binding protection); pull gating;
delete → release → re-create; claim-tombstone → rebind-over-non-live;
lockdown revocation; mixed rails; vault-unset fallback; empty-bundle create +
later signature-less `Permit2.approve` top-up (the future top-up UX).
`MockPermit2` gained the canonical `approve()` for that last case.

## 6b. Sepolia rehearsal — 2026-07-30 (PASSED)

Full deploy train executed against live Sepolia + canonical Permit2:

| Step | Result |
|---|---|
| Router proxy upgrade | impl `0x29Eec75dC5113a4d69eE044fcAF49c9EdbC3344F`, Etherscan-verified |
| New clone impl | `0x0600e9D8A2B5F6c896C56B7D06acF9F13A8e13ED`, wired + verified |
| LegacyPullVault | `0x2FaB98a58211F7FF48F78E8880c0F0e6A5e6E5f3`, wired + verified |
| Activity attestor | deployer key (rehearsal only — dedicated worker key before mainnet) |

E2E smoke (`scripts/smoke-vault-autorenew.ts`, fresh throwaway owner, real
Permit2): create with vault as spender → clone at predicted address, binding
registered, clone pinned the vault, Permit2 allowance names the vault;
premium + `setAutoRenew`; `recordActivity` reset the timer, nonce replay and
non-attestor both rejected on-chain; trigger lowered → beneficiary claim
pulled the full balance **through the vault rail**. Sourcify verification
deferred (API v1 brownout — use the v2 flow before mainnet). Ops note:
public-RPC `estimateGas` under-quoted a small write by ~5% (OOG at 98%);
the smoke script now sets explicit gas margins — keep that habit for the
mainnet runbook.

## 6c. Mainnet deployment — 2026-07-30 (COMPLETE)

Full train executed from branch tip `6664137` (190 tests passing; storage
layout re-verified append-only against the live create-flow-v2 impl before
sending anything). All proxies upgraded in place — public addresses
unchanged. Total spend: 8,279,644 gas ≈ 0.0088 ETH at ~1 gwei.

| Step | Address | Tx |
|---|---|---|
| Router impl (new) | `0x355BBf74B91e021f18Cee0de191b295B4159E4A1` | deploy `0x1917d3c5e3efd0290bcf3d0c50418a9514699a6e70ae2d5efcb0321b110d4d74`, upgrade `0xe61cd6e60f9f3fbae915d5bee04e051b033d96bac190a544dfc32df27597ec34` |
| Clone impl (new) | `0xdDea11D92dDD0746Dbe2899f35A79a145660a7C3` | deploy `0xb86efdc144b3d9bd9855db531c612911f367c4616bbb738366803b17a2d67bef`, wire `0x53d62350f2823741741444799fe01b815268deb6054f89b7d1a855574f269e44` |
| LegacyPullVault | `0x95F0981026C7e804fD6ba8bE738cA7c380C7f978` | deploy `0x20915319da71a1b03b787d0259be39ebb6aa458e1620613e24e783ee7dc79276`, wire `0x01f2a1ce6bb16f3efb4c36c508270be18e5d20fd23de7e4e8fa2f0f96b65d485` |
| Activity attestor | `0x4B05aC1b0BF109A9CE30dCEc2831990d694d74D0` (dedicated worker key) | wire `0x80e7f26105097e804b339ce7d2f5ac79e21765171781ec94b1c0e9b83912eed7` |

Vault pinned codehash `0xc2ded76c91a0a870733a530572a9a5df666fc45106611e1551e4eaf75834d9f3`
(= keccak of the EIP-1167 clone of the new impl, verified post-deploy).
Post-deploy read-only suite: proxy impl, `pullVault()`, `activityAttestor()`,
codehash, `AUTO_RENEW_WINDOW`/`BUDGET`/`CHECKIN_AUTH_MAX_TTL` all PASS; state
preservation spot-checked on existing legacies #1 and #2 (owners + triggers
intact, both expose `getTriggerActivationTimestamp`). Router impl, clone impl
and vault Etherscan-verified; proxy page relinked via `verify-proxies.ts`.
Sourcify deferred — API v1 brownout window runs through 2027-01-08; use the
v2 flow when doing the §5 trust-registry pass.

## 7. Adversarial review round (findings → fixes)

An independent security review of the first cut surfaced, and this branch
fixes, the following:

- **HIGH — vault rotation stranded pre-rotation permits.** The clone read
  `router.pullVault()` live; after a rotation the old vault became
  undiscoverable and a dead owner can't re-sign. Fix: the clone pins the
  vault in its own storage at `initialize` and uses only the pinned address
  (`_vaultAllowance`, `deleteLegacy` release). Regression test: create →
  rotate to a second vault → claim still pulls through the pinned one.
- **MEDIUM — unguarded admin-fee pull could brick a claim batch.** A single
  non-pullable fee (revoked underlying approval, stale rail) reverted the
  whole claim. Fix: the fee pull now rides the same guarded rail helper as
  beneficiary transfers and forfeits the fee on failure; `_swapAdminFee` only
  runs on measured receipts. Tests now run with a **nonzero fee** (the old
  fixture's zero fee had left the path untested): fee-through-vault-rail and
  sabotaged-rail-doesn't-brick-the-batch.
- **MEDIUM (pre-existing) — no reentrancy guard on the EOA router.** Claim
  paths loop over arbitrary caller-supplied token addresses; an ERC-777-style
  token could re-enter `activeLegacy` mid-distribution and re-run it. Fix:
  `ReentrancyGuardTransient` (EIP-1153, zero storage slots — layout-safe on
  the live proxy) with `nonReentrant` on `activeLegacy`, `activeLegacyFor`,
  `activeLegacyAndUnswap`. Probe test (`MockReentrantERC20`) asserts the
  re-entry fails and distribution happens exactly once.
- **INFO — vault spender accepted with the clone path disabled.**
  `createLegacyV2` now rejects a vault-spender bundle when
  `legacyImplementation` is unset (binding could never happen, the permit
  would be dead weight).

Confirmed non-issues from the same review: codehash pin is byte-exact for OZ
Clones v5.5.0, cross-owner pulls blocked at three layers, bind/permit
ordering atomic, storage append safe (router slot 14, clone slot 25).

Full suite after the review round: 175 passing.

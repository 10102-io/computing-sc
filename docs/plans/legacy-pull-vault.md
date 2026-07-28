# LegacyPullVault — one permanent, verified Permit2 spender

Status: **code complete** on `feat/legacy-pull-vault` (2026-07-28). Not yet
deployed. Companion frontend work tracked in `computing/docs/DEFERRED.md`
(`permit2-spender-trust`).

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

- **No storage or initializer changes.** The clone discovers the vault
  through `router.pullVault()` (guarded staticcall; older routers, unset
  vault, or missing Permit2 degrade to "no allowance", never a revert).
- Claim path now picks, per token, the **most generous of three rails**:
  direct ERC-20 allowance, Permit2-with-clone-as-spender, Permit2-via-vault
  (only when this clone is the owner's bound legacy). Same
  `min(balance, allowance)` semantics as before.
- `deleteLegacy` releases the binding, best-effort (bind-over-non-live is the
  backstop if release ever fails).

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
`deploy-eoa-clone-impl.ts`. Old-vault bindings keep serving their existing
legacies (clones resolve the vault via the router — after a rotation, the
frontend should prompt affected owners to re-sign against the new vault, or
existing per-clone/direct rails continue to cover them).

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

`test/LegacyPullVault.spec.ts` (13 cases): vault-spender create → bind →
claim through vault (60/40 split); pre-vault clone-spender back-compat;
spender-mismatch revert; bind gating (router-only, codehash pin vs EOA and
non-clone contract, owner mismatch, live-binding protection); pull gating;
delete → release → re-create; claim-tombstone → rebind-over-non-live;
lockdown revocation; mixed rails; vault-unset fallback; empty-bundle create +
later signature-less `Permit2.approve` top-up (the future top-up UX).
`MockPermit2` gained the canonical `approve()` for that last case. Full suite:
171 passing.

# EOA activity auto-renew — Phase 1 (router-side)

Status: code complete on `feat/legacy-pull-vault` (rides the same router
upgrade train as the LegacyPullVault). Design round: 2026-07-28 (ROADMAP
track 4); implementation: 2026-07-30.

## Problem

The product promise is "we monitor your wallet activity" — but an EOA
legacy's inactivity countdown only resets on an explicit check-in
transaction. Ordinary wallet activity (sends, swaps) is invisible to the
clone, so active owners must still remember to check in, and the detail page
carries an apologetic disclaimer. EOA nonces are unreadable on-chain, so the
countdown cannot observe activity by itself; someone has to attest to it.

## Shape

Router-only (upgradeable proxy — covers **existing** legacies; zero clone
changes). An off-chain attestor (the reminder-worker, which already polls
owner nonces in `owner-activity.ts`) calls `recordActivity(legacyId,
observedNonce)` when it sees the owner's transaction count rise near the
deadline. The router then resets the clone timer exactly as a check-in
would (`activeAlive(owner)` — the clone's own gates still apply).

Rejected alternatives (design memo): on-chain state proofs (the MPT →
binary-tree migration would strand an immutable verifier) and ERC-7702
delegation (MetaMask only signs its own delegator).

## Four hard bounds (all revert loudly)

1. **Opt-in** — `setAutoRenew(legacyId, enabled)`, owner-only,
   premium-gated at enable AND re-checked at every renewal (a lapsed
   subscription pauses renewals; reminder emails take over). Default OFF.
   Disable is always allowed, premium or not.
2. **Monotonic nonce** — each attestation must cite a strictly higher
   owner nonce than the last recorded one. The baseline survives
   disable/re-enable toggles, so an old observation can never be replayed.
3. **Near-deadline window** — attestations land only within
   `AUTO_RENEW_WINDOW` (30 days) of the activation deadline: ~one renewal
   per period, and the timeline is never quietly extended mid-period.
4. **Budget** — renewals stop `AUTO_RENEW_BUDGET` (365 days) after the
   owner's last REAL check-in (direct `avtiveAlive` or owner-signed
   sponsored `activeAliveFor`), which refills the budget. `recordActivity`
   deliberately does NOT refill it — an attestation can't extend its own
   leash.

## Trust model, honestly stated

A fully compromised attestor key can only **delay** activation, by at most
the remaining budget (≤ 12 months past the owner's last real check-in). It
can never accelerate activation, never claim, never move funds, never touch
non-opted-in legacies. The code admin can rotate or zero the attestor
(`setActivityAttestor`); zeroing pauses all renewals without touching
owners' opt-ins.

Consent copy (frontend): "we watch this wallet's public transaction count;
after 12 months of auto-renewals we ask you to check in for real."

## Storage / layout

Appended after `pullVault`: `activityAttestor` (slot 15) and
`mapping(legacyId => AutoRenewState{enabled, lastNonceSeen, budgetAnchor})`
(slot 16, struct packs into one slot). Verified append-only via
`dump-storage-layouts.ts`.

## Worker integration (Phase 1b, `legacy-tooling`)

- Attestor = a dedicated hot key held by the reminder-worker; funded for
  gas; wired via `setActivityAttestor`.
- Worker flow per opted-in legacy: read `autoRenewState` + clone deadline →
  if within window, budget not spent, and current owner nonce >
  `lastNonceSeen` → send `recordActivity(legacyId, nonce)`.
- Every bound is enforced on-chain, so a worker bug fails loudly (revert)
  instead of silently shifting timelines.

## Phase 0 (independent, no contracts)

Near-deadline email with a one-click gasless check-in link (owner signs
`CheckInAuth`, worker relays `activeAliveFor`). Ships from `legacy-tooling`
whenever; not gated on this upgrade.

## Tests

`test/EOAAutoRenew.spec.ts` (7 cases): owner/premium gating on the toggle,
happy-path renewal, all four bounds (attestor-only, opt-in, monotonic nonce,
window), toggle-replay protection, budget exhaustion + refill by real
check-in, deadline-only-moves-away, premium-lapse pause, deleted-legacy
rejection.

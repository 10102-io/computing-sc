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
   Disable is always allowed, premium or not. Enable also fails loudly when
   the feature could never fire: on a tombstoned legacy
   (`AutoRenewLegacyNotLive`) and when the inactivity trigger exceeds
   `AUTO_RENEW_BUDGET + AUTO_RENEW_WINDOW` (~395 days), where the renewal
   window would only ever open after the budget is spent
   (`AutoRenewInfeasible`). Note: the guard runs at enable time — if the
   owner later *raises* the trigger past the cliff via
   `setActivationTrigger`, renewals silently stop (reminder emails take
   over); the frontend should warn on that edit.
2. **Monotonic nonce** — each attestation must cite a strictly higher
   owner nonce than the last recorded one. The baseline survives
   disable/re-enable toggles, so an old observation can never be replayed.
3. **Near-deadline window** — attestations land only within
   `AUTO_RENEW_WINDOW` (30 days) of the activation deadline, and never at
   or after it (`AutoRenewTooLate`): ~one renewal per period, the timeline
   is never quietly extended mid-period, and a claimable legacy can never
   be re-armed by an attestation (only the owner's own check-in does that).
4. **Budget** — renewals stop `AUTO_RENEW_BUDGET` (365 days) after the
   owner's last REAL check-in (direct `avtiveAlive` or owner-signed
   sponsored `activeAliveFor`), which refills the budget. `recordActivity`
   deliberately does NOT refill it — an attestation can't extend its own
   leash.

## Trust model, honestly stated

A fully compromised attestor key can only **delay** activation. Stated
precisely (review L1 wording): the *last* renewal can land up to 12 months
after the owner's last real check-in, and activation then follows one
further full inactivity period — so the worst-case delay is **12 months
plus one inactivity period** past the natural deadline (~15 months for a
90-day trigger). It can never accelerate activation, never claim, never
move funds, never touch non-opted-in legacies, and never re-arm an
already-claimable legacy (`AutoRenewTooLate`). One unavoidable edge: a
mempool-watching compromised attestor can front-run the owner's own
`setAutoRenew(id, false)` with one final renewal — bounded to a single
period, and the owner's disable still lands. The code admin can rotate or
zero the attestor (`setActivityAttestor`); zeroing pauses all renewals
without touching owners' opt-ins.

**Exact budget-refill set** (documented per review L4): the budget anchor
refills ONLY on the two owner check-in paths (`avtiveAlive`,
owner-signed `activeAliveFor`) and re-anchors on an owner's
`setAutoRenew(true)` toggle (an equally owner-authenticated consent
renewal). Owner *config* actions (`setActivationTrigger`, distribution
edits, `withdraw`, swaps, deposits) reset the clone's inactivity timer but
deliberately do NOT refill the budget — the budget measures "how long since
the owner last confirmed this feature should keep running", not general
liveness. Pinned by test.

Consent copy (frontend): "we watch this wallet's public transaction count
and renew for you when you're active; after 12 months of renewals we ask
you to check in yourself. If our systems were ever compromised, the worst
possible outcome is your beneficiaries' claim being delayed — never
redirected, never accelerated."

## Adversarial review round (findings + dispositions)

An independent security review found no HIGH issues; three findings, two
fixed and one accepted:

- **M1 (fixed)** — the budget refill happens at *relay* time of a sponsored
  check-in, so a relayer hoarding an owner-signed `CheckInAuth` with a
  far-future deadline could stretch the worst-case delay leash. Fix:
  `activeAliveFor` now rejects deadlines more than `CHECKIN_AUTH_MAX_TTL`
  (1 hour) in the future (`CheckInDeadlineTooFar`). A check-in is proof of
  life *now*; its signature must be fresh. Worker note: sign `CheckInAuth`
  deadlines ≤ 1 hour out.
- **L2 (fixed)** — the renewal window had no upper bound, so an attestation
  landing after the deadline could re-arm an already-claimable legacy (claim
  sniping). Fix: `recordActivity` reverts with `AutoRenewTooLate` once
  `block.timestamp >= beneficiariesTrigger`. The claim window belongs to the
  beneficiaries; only the owner's own check-in can recover a lapsed legacy.
- **L1 (accepted, fail-safe)** — a compromised attestor could poison
  `lastNonceSeen` with `type(uint64).max`, permanently bricking auto-renew
  for that legacy. Accepted: this fails SAFE — renewals stop, reminder
  emails take over, and activation proceeds on schedule. Any owner-callable
  nonce reset would weaken the replay protection (bound 2) for a pure
  availability gain in an already-compromised scenario; not worth it.

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
  Implemented: `computing/services/reminder-worker/src/auto-renew.ts`
  (env-gated by `EOA_ROUTER_ADDRESS` + `ATTESTOR_PRIVATE_KEY`).
- Every bound is enforced on-chain, so a worker bug fails loudly (revert)
  instead of silently shifting timelines.
- **Do not conflate attested renewals with owner responsiveness** (review
  I2): `recordActivity` emits the same `TransferEOALegacyActivedAlive` as a
  real check-in; the dedicated `TransferEOALegacyAutoRenewed` event is the
  disambiguator. Reminder emails asking the owner to "check in for real"
  near budget exhaustion must NOT be suppressed by attested renewals.
- **Pre-wiring runbook step** (review I3): before `setActivityAttestor` on
  mainnet, confirm every live full-bytecode EOA legacy vintage exposes
  `getTriggerActivationTimestamp` (added in phase 3, 2025-12-01). Older
  vintages either revert (fail-safe) or return `(0,0,0)` via the
  `GenericLegacy` stub, which silently voids the window bound (still
  delay-only). If any pre-phase-3 vintage exists, exclude it in the worker.

## Phase 0 (independent, no contracts)

Near-deadline email with a one-click gasless check-in link (owner signs
`CheckInAuth`, worker relays `activeAliveFor`). Ships from `legacy-tooling`
whenever; not gated on this upgrade.

## Tests

`test/EOAAutoRenew.spec.ts` (15 cases): owner/premium gating on the toggle,
happy-path renewal, all four bounds (attestor-only, opt-in, monotonic nonce,
window), toggle-replay protection, budget exhaustion + refill by real
check-in, deadline-only-moves-away, premium-lapse pause, deleted-legacy
rejection, post-deadline attestation rejection (L2), far-future
`CheckInAuth` deadline rejection (M1), loud-enable guards (infeasible
trigger / tombstoned legacy / unknown id), attestations-never-refill +
toggle-re-anchor semantics (L4), sponsored-check-in-refills vs
config-action-does-not, attestor rotation + zeroing kill switch,
max-uint64 nonce poisoning (accepted L1, fail-safe), and multi-legacy
isolation + event payload assertions.

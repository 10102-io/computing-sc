# `computing-sc` finish-line milestone

**Status**: Scoping / not started
**Created**: 2026-06-18
**Purpose**: Single index for "everything we want to do to the contracts to
reach a durable long-term state with the latest Ethereum capabilities." The goal
stated by the founder: do *all* remaining smart-contract work in one coordinated
milestone, with **no deferred contract items left on `computing-sc`** — while not
disturbing parallel frontend/admin/subgraph work. An external security audit is
a *future* step (see §6), not a current gate.

This doc is deliberately short — it's the **map**. The heavy design already
lives in `create-flow-v2.md`; this page exists so a fresh reader (or a fresh
chat) can see the whole board at a glance and not re-scope work that is already
done.

---

## 1. The headline

After reconciling the plans against on-chain reality on **2026-06-18**, the
pre-audit milestone is effectively **one thing**:

> **Create-flow v2** — Permit2 + EIP-5792 single-confirm create, off-chain
> beneficiary PII, and sponsored claims / sponsored owner check-in — all in one
> `TransferEOALegacyRouter` + clone-impl redeploy.

Everything else people might *remember* as "still to do on the contracts" has
already shipped (see §3). Create-flow v2 is the only remaining
storage-layout-touching, audit-worthy change. So it *is* the audit milestone.

Full design: [`create-flow-v2.md`](./create-flow-v2.md) (Permit2 deep-dive,
witness binding, migration, sponsored `…For` entrypoints in §12a, audit
strategy in §13, storage-layout safety in §14).

---

## 2. On-chain inventory (mainnet, read 2026-06-18)

Sizes the migration / coexistence surface. Read directly from the routers via
public RPC (`_legacyId` / `timelockCounter` getters):

| Surface | Count | Source |
|---|---|---|
| EOA legacies (cumulative ever created) | **31** | `TransferEOALegacyRouter._legacyId()` |
| Timelocks (cumulative ever created) | **7** | `TimeLockRouter.timelockCounter()` |
| Multisig legacies | not externally readable | `LegacyFactory._legacyId` is `internal` — count via subgraph / `MultisigLegacyCreated` event scan |
| Premium wallets | **3** (all ETH subs) | audit-followup read 2026-05-29; 0 USDC/USDT subs ever |

Takeaway: the ETL / coexistence surface is **tiny** (tens of legacies, single-
digit premium users). Migration risk is dominated by *correctness* (storage
layout, Permit2 witness), not *volume*.

---

## 3. Already done — do NOT re-scope these

These were genuine "before audit" candidates in older notes; they have since
shipped. Listed here so they don't creep back into scope.

| Item | Status | Evidence |
|---|---|---|
| **EIP-1167 clone cutover** for EOA legacies | ✅ shipped | `contract-addresses.json` (`TransferEOALegacyImpl`), `EOALegacyFactory._cloneLegacy` |
| **Safe-source Transfer legacy line** | ✅ hard-sunset (source-deleted v2026.05.18) | `contract-addresses.json` `_deprecated.TransferLegacyRouter_sunset` |
| **Chainlink Automation + Functions email path** | ✅ retired, shipped mainnet + Sepolia 2026-06-08 | [`chainlink-email-retirement.md`](./chainlink-email-retirement.md) (Phase B), reminder-worker live |
| **2nd-round audit follow-ups** (M-2′ `onlyLegacy` spoof, carry-overs 1–3) | ✅ resolved by Phase B (3 by deletion, 1 by `SafeERC20`) | [`audit-2nd-round-fixes-delta.md`](./audit-2nd-round-fixes-delta.md) |

---

## 4. Chainlink — what *actually* remains (the clarification)

The founder's recollection was correct: "most of it is already removed; the
only thing left is premium subscriptions." Precisely:

- **Retired (code, shipped):** Chainlink **Automation** (`PremiumAutomationManager`
  upkeep registration) and Chainlink **Functions** (the `PremiumMail*`
  contracts' inline-JS HTTP sends). These were the LINK-burning products. Gone
  from the live email path; scheduling + delivery moved off-chain to
  `services/reminder-worker`.
- **Still present, and we keep it — the "premium subscriptions" piece:**
  `PremiumRegistry` reads three Chainlink **Data Feeds** (`AggregatorV3Interface`
  — ETH/USD, USDC/USD, USDT/USD) to price USD subscription plans in tokens
  (`getETHPrice` / `getUSDCPrice` / `getUSDTPrice`). Data Feeds are **free
  reads — no LINK burn, no opex tax**. This is the standard, correct way to
  price a USD plan on-chain. **Not** an audit blocker and **not** in scope to
  remove. (If we ever want to drop the Chainlink dependency entirely we'd swap
  to a TWAP or a signed price oracle — a *separate*, optional follow-up, not
  part of this milestone.)
- **Residual cosmetic-only references:** stale comments mentioning "register
  Chainlink Automation cronjob" in both routers, the deprecated
  `__deprecatedPremiumAutomationManager` storage slot in `PremiumSetting`
  (kept for layout safety), and `MockChainlinkAutomation.sol` (test mock). These
  are harmless; clean up opportunistically inside the v2 router redeploy, not as
  their own task.
- **Ops teardown: ✅ done.** The mainnet Automation upkeep was cancelled, the
  Functions subscription closed, and the remaining LINK withdrawn. Nothing
  recurring left. (`link-funding-runbook.md` is fully superseded.)

**Net:** Chainlink is *out* of the pre-audit contract scope. Nothing to delete,
nothing to refactor, nothing to tear down — just a benign price-feed dependency
we deliberately keep.

---

## 5. Cross-repo touch radius

Create-flow v2 is **not** `computing-sc`-only. Sequencing matters so parallel
minor work isn't disturbed. Full deploy sequence in `create-flow-v2.md` §11.

| Repo | What changes | Coupling |
|---|---|---|
| `computing-sc` | new `TransferEOALegacyRouter` impl + clone impl, storage-layout bump, Permit2 witness, `…For` sponsored entrypoints, timelock Permit2 variants | **the audit target** |
| `computing-admin` | new off-chain metadata endpoints (PII home) + EIP-712-signed write auth | additive; can land early behind a flag |
| `computing` (frontend) | new create flow (Permit2 sign + EIP-5792 grouping), metadata API client, address-only fallback rendering | gated behind a feature flag until contracts are live |
| `computing-subgraph` | drop PII fields, new event signatures, dual-read window | coordinated with the on-chain cut |
| ETL (one-shot) | `scripts/migrate-metadata-to-api.ts` snapshot of the 31 EOA legacies' on-chain names/emails → metadata API | run once at cutover |

**Non-disruption rule:** the contract work happens on its own branch and only
merges at deploy time. Frontend/admin changes land behind feature flags so the
in-flight minor fixes on `dev` are never blocked by the milestone.

---

## 6. Framing — the "long-term state, latest-Ethereum-capabilities" milestone

Decision (2026-06-18): the goal isn't "pass an audit," it's **reach a durable
end-state create/claim flow that uses everything modern Ethereum offers.**
Create-flow v2 *is* that milestone — one coherent redeploy, not a stack of
separate asks. The UX it delivers:

- **Single-confirm create** — Permit2 collapses N per-token `approve` txs into
  one off-chain signature; EIP-5792 batches sign+create into one atomic wallet
  confirmation (3–5 prompts → 1 on supporting wallets).
- **Gasless claims** — sponsored `activeLegacyFor` lets a beneficiary with an
  empty wallet claim without holding ETH (the highest-impact UX gap today).
- **Sponsored owner check-in** — `activeAliveFor` lets 10102 reset the
  inactivity timer when it detects the owner is active.
- **~55–60% less create gas + free/instant nickname edits** — from moving
  beneficiary PII off-chain (also the GDPR win).
- **7702-ready** — the `…For` design doesn't build on EIP-7702 (wallet support
  still maturing) but deliberately leaves the door open to adopt it later.

### Decisions already made

- **Proxy/admin keys: keep as-is for now.** The admin key is upgrade authority
  only — it never gates user create/claim (those are permissionless). Moving it
  to a multisig is a future trust-minimization step, not a functional or UX
  requirement. Out of this milestone's scope.
- **External audit: future, not now.** Noted for when we go for a public
  security review; not gating v2 design/implementation today.

### Still-open design forks (resolve at detailed v2 design)

1. **Sponsorship trust + authorization model** (`create-flow-v2.md` §12a / §17 Q8):
   permissionless relay for `activeLegacyFor` vs 10102-keeper for the premium
   `activeAliveFor`; single-shot signed check-in vs time-bounded keeper
   authorization for passive recurring reset.
2. **EIP-5792 wallet support matrix** at ship time (MetaMask / Rabby / Coinbase /
   WalletConnect / Safe) — determines whether the happy path is truly 1 prompt
   or a 2-prompt fallback. Doesn't block design; informs UX copy.
3. **Mainnet migration window** — acceptable subgraph cut + bounded
   metadata-display gap during cutover (analogous to the Phase B email gap,
   already accepted). Tiny surface: 31 EOA legacies, 7 timelocks.

---

## 7. Suggested sequence from here

1. Lock `create-flow-v2.md` detailed design (resolve its §17 open questions,
   esp. the sponsorship authorization model).
2. Implement on a `computing-sc` milestone branch: Router V4 + clone V2 +
   Permit2 witness + `…For` entrypoints + timelock Permit2; storage-layout
   snapshot + `validateUpgrade` in CI. (Branch-isolated so parallel `dev`
   work is never blocked.)
3. `computing-admin` metadata endpoints + `computing` create-flow v2 behind
   feature flags; `computing-subgraph` v2 alongside.
4. Sepolia deploy → E2E (create v2, Permit2 pulls, gasless claim, email-worker,
   off-chain metadata) → mainnet + one-shot ETL + subgraph cut.
5. (Future) external security review + multisig admin, when we decide to harden
   the trust model for a public audit.

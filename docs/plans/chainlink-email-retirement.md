# Phase B — Chainlink retirement + off-chain email worker

**Status**: In progress — single lean end-state upgrade (see §10). B-1 + notify event coded/tested; end-state contract surgery underway.
**Priority**: Next `computing-sc` milestone (carries three 2nd-round audit follow-ups)
**Created**: 2026-05-29
**Target networks**: mainnet + Sepolia
**Touch radius**: `computing-sc` (contract deletions + `PremiumRegistry`/`PremiumSetting` upgrades),
`computing/services/reminder-worker` (NEW — sibling to the existing `email-proxy`),
`computing/services/email-proxy` (extend to accept reminder templates + a worker auth path),
`computing-subgraph` (notify events), Chainlink Automation/Functions decommission
(upkeep cancel + LINK withdraw + subscription teardown)

> **UPDATE 2026-06-01 (later) — END-STATE SUB-STEP 1 LANDED + STRATEGY COLLAPSED:**
> Decided with you to do the **full end-state in ONE upgrade** (dropped the 2-deploy
> emit-alongside/cutover split — you accept a bounded email gap; details + Sepolia-first
> sequencing in §10). Resolved the post-deletion notify home → **Option (d)**: EOA router
> calls a slim `onlyRouter notifyActivatedTransfer` (non-spoofable); rich per-bene amounts
> reconstructed worker-side from Transfer events (§10 RESOLVED block).
> **Sub-steps 1–3 done + green (PremiumSetting 25512 → 18886 bytes, 5690 headroom; 84 passing):**
> - **(1)** deleted `triggerActivationTransferLegacy` + spoofable `onlyLegacy` (**M-2′ closed
>   structurally**), added `notifyActivatedTransfer(legacy, activatingBene)` (`onlyRouter`),
>   wired both EOA-router activation paths to call it (best-effort try/catch), removed the
>   legacy clone's dead mail call, simplified `MockPremiumLegacy` + its test. (→ 21929)
> - **(2)** made `triggerOwnerResetReminder` + `triggerActivationMultisig` **emit-only** (dropped
>   the `premiumSendMail` calls); removed the now-unused `ArrayUtils` import. (→ 20255)
> - **(3)** converted all 24 string-`require`s to custom errors (verified no test asserts the
>   old strings — the test helper only matches custom-error sigs). (→ 18886)
>
> **UPDATE 2026-06-01 (later still) — "DUE" VIEW DONE (separate helper, +9 tests, 93 passing):**
> Built `contracts/premium/PremiumReminderView.sol` — a **standalone, stateless, read-only**
> contract (NOT bolted onto PremiumSetting, per the architecture concern) that re-expresses
> `PremiumAutomation.checkUpkeep`'s *timing* as `dueReminders(legacy)` /
> `dueRemindersBatch(legacy[])`. Returns the open `NotifyLib.NotifyType` windows; dedup is
> intentionally omitted (worker owns the sent-ledger). Gates on premium / live / armed
> (Safe-guard for multisig, skipped for EOA). Underflow-safe window math. Constructor takes
> `(setting, defaultNotifyAhead)`; deploy standalone (no proxy). `MockPremiumLegacy` extended
> with configurable triggers/type/live (non-breaking). Tests: `test/PremiumReminderView.spec.ts`.
> Next in the dependency chain: subgraph indexes `LegacyEmailNotifyRequested`.
>
> **UPDATE 2026-06-01 (later still) — SUBGRAPH DONE (codegen + build green):**
> `computing-subgraph` now indexes `LegacyEmailNotifyRequested` → new immutable `NotifyRequested`
> entity (legacy, creator, layer, notifyType, block/ts/tx). Touched: `abis/PremiumSetting.json`
> (+event), `subgraph.yaml` (PremiumSetting eventHandlers +1), `schema.graphql` (+NotifyRequested),
> `src/premium-setting.ts` (handler), `tests/premium-setting*` (real test replacing the broken
> `handleInitialized` scaffold). `graph codegen` + `graph build` both pass. NOTE: `graph test`
> (matchstick) can't run on Windows ("Unsupported platform") — the test is written to repo
> conventions and runs on Linux/CI. Next: reminder-worker (needs a hosting decision from you).
>
> **UPDATE 2026-06-01 (later still) — WORKER + PROXY DONE (typecheck + build green):**
> - **reminder-worker** scaffolded at `computing/services/reminder-worker` (Railway Node/Hono +
>   Postgres, per your hosting decision). Implements §11.3 end to end: `recipient` +
>   `sent_ledger` tables (idempotent boot migration); AES-256-GCM at-rest encryption with
>   per-record HKDF keys + per-row salt (crypto-shred erasure); `POST /ingest`, `POST /erase`,
>   `POST /run`, `GET /health` (shared-secret auth); scheduler with an **event pass** (subgraph
>   `NotifyRequested` → recipients → dedupe → decrypt → proxy send → ledger, ERC-20 amount
>   reconstruction from the activation tx logs for ActivatedTransfer) and a **due pass**
>   (`PremiumReminderView.dueRemindersBatch` → time-based reminders). `npm run typecheck` +
>   `npm run build` both green. Documented follow-ups in its README: per-type recipient
>   audience confirmation, email-variable enrichment from the subgraph, native-ETH amounts
>   (need trace API), token symbol/decimals.
> - **email-proxy** (`computing/services/email-proxy`): added the worker shared-secret
>   rate-limit bypass (`x-worker-secret`, constant-time) + generic `variables` passthrough
>   (extra string keys forwarded to Mailjet). Typecheck green; `.env.example` updated.
>
> **UPDATE 2026-06-01 (later still) — DEPLOY TOOLING READY (compiles clean):**
> - `scripts/deploy-premium-endstate.ts` — single bundled, idempotent release:
>   (1) upgrade `PremiumRegistry` impl (B-1 SafeERC20), (2) upgrade `PremiumSetting` impl
>   (end-state), (3) deploy standalone `PremiumReminderView` (reads the legacy
>   `PremiumAutomationManager.defaultNotifyAhead()` for timing parity, falls back to
>   `DEFAULT_NOTIFY_AHEAD` env / 7d). Owner-checks the ProxyAdmin, verifies on Etherscan,
>   prints the worker env (`REMINDER_VIEW_ADDRESS`, `CHAIN_ID`). `ONLY=registry,setting,view`
>   to run a subset. Sepolia-first, then mainnet. Does NOT touch Chainlink.
> - `scripts/verify-premium-endstate.ts` — read-only post-deploy sanity (impl match,
>   `notifyActivatedTransfer` present, view wired + callable, optional WATCHED_LEGACIES dump).
>
> **UPDATE 2026-06-01 (ingest auth) — WALLET-SIG AUTH DONE (build green):**
> Decision: browser authenticates to the worker's `/ingest` + `/erase` via an
> **EIP-712 wallet signature** (no secret in the browser). Worker recovers the
> signer and checks it on-chain: ingest requires signer == legacy `creator()`;
> erase allows creator OR the recipient itself (zero-legacy = self-erase-all).
> Short-lived `deadline` (≤ now+1h) + data-bound message prevent replay/tamper;
> chainId in the domain prevents cross-chain reuse; fails closed if `creator()`
> is unreadable. Shared-secret path retained for server-to-server callers.
> New `src/auth-sig.ts` + `legacyCreator()` in `chain.ts`; round-trip + tamper
> rejection verified. Signing scheme documented in the worker README for the FE.
> NEXT (frontend, now UNBLOCKED): build the browser ingest client that signs +
> POSTs — pairs with the on-chain PII strip.
>
> **Remaining work is GATED on you / Sepolia (not pure coding):**
> - **PII strip + `clear*PII`** (§5.5) — COUPLED to a `computing` frontend change: the frontend
>   must POST PII to the worker `/ingest` instead of writing it on-chain. Do together.
> - **Chainlink teardown** — delete automation/mail contracts + wiring + `PremiumAutomation.spec.ts`.
>   Do only AFTER the worker is proven sending real emails on Sepolia (irreversible-ish).
> - **Single end-state deploy** — needs Railway worker + Postgres provisioned, the
>   `EMAIL_ENC_KEY` secret, a Sepolia run, then mainnet upgrade. Needs your infra/keys.
>
> **Older remaining notes (still valid):**
> - **PII strip + `clear*PII`** (§5.5): drop email/name from setter signatures + events + stop
>   writing to storage (keep slots for proxy safety). COUPLED: frontend must reroute PII to the
>   worker `/ingest` instead of the contract. The triggers no longer read PII (done in step 2),
>   so the only remaining on-chain PII writers are the config setters + their events.
> - **On-chain "due" view** (§5.1): reuse `PremiumAutomation.checkUpkeep` timing logic as a
>   `view` the worker polls. ENABLES the worker.
> - **Chainlink teardown**: remove `premiumSendMail`/`premiumAutomationManager` wiring +
>   `setUpReminder` + cronjob queue from `PremiumSetting`, delete the automation/mail contracts
>   + `PremiumAutomation.spec.ts`. BIGGER — deletes the live Chainlink path; do once worker is proven.
> - **Dead-code strip** in `TransferLegacyEOAContract` (`summary`/`receipt`) — risky (interleaved
>   with live distribution); do with focused coverage.
>
> **UPDATE 2026-06-01:** B-1 SafeERC20 fix is **coded + tested** (§5.3, 23/23 green,
> awaiting bundle). Email-storage question **resolved → Option B** (off-chain encrypted
> store owned by the worker; Lit deferred to Phase C) — see new **§11** + contract impact
> in **§5.5** (events/storage stop carrying PII). Next code task: B-2 step 1 (PII-free
> `LegacyEmailNotifyRequested` emit-alongside). The 2026-05-29 block below is retained for
> the M-2′/on-chain-read history.
>
> **MONDAY PICKUP — status as of Fri 2026-05-29 (delete when doc is finalized)**
>
> Where we are: full design draft done (§1–9). Decisions confirmed with you:
> Mailjet kept + routed via existing email-proxy; on-chain "due" check stays
> on-chain; mail/automation contracts left inert (strip later); B-1/B-2 split.
> Nothing is committed to code yet — this is the review checkpoint.
>
> **On-chain check RAN (mainnet, read-only) — results locked the scope:**
> - `transferLegacyContractRouter` on mainnet = **address(0)** → **M-2′ is
>   reachable on mainnet TODAY**, not just Sepolia. (script:
>   `scripts/audit-followup-readonly.ts`.)
> - `usdt()` = `0xdAC1…ec7` = **classic Tether** (no bool return) → raw
>   `transferFrom` reverts. `usdc()` = real USDC.
> - PlanSubcribed history = **3 ETH subs, zero USDT/USDC ever** → the SafeERC20
>   fix is a **silent** correctness fix, no live users affected.
>
> **M-2′ DECISION — MADE 2026-05-29: Option A (accept + document until B-2).**
> Rationale: impact is email-only phishing against 3 mainnet premium wallets (no
> fund risk), and the B-2 deletion of `triggerActivationTransferLegacy` is the
> real, complete fix — so no contract upgrade is spent on an interim patch that
> wouldn't fully close it anyway ("reject-zero" is not a real fix; see §4.1).
> M-2′ is tracked as a known accepted risk until B-2 ships (§4.1).
>
> **NEXT ACTION (Monday): draft B-1 = the silent SafeERC20 fix only** (unblocks
> USDT/USDC subscriptions, currently 100% broken on mainnet). M-2′ is NOT in B-1.
>
> Discovery already done (don't re-read to resume):
> - `onlyLegacy` (PremiumSetting.sol L100-108) has exactly ONE consumer:
>   `triggerActivationTransferLegacy` (L320-409). Deleting that fn deletes the
>   only path that dereferences a caller-supplied `router()` → M-2′ gone.
> - `triggerActivationMultisig` (L299) + `triggerOwnerResetReminder` (L271) are
>   `onlyRouter` (not spoofable). Callers: MultisigLegacyContractRouter.sol:302,
>   TransferLegacyEOAContract.sol:794, TransferLegacyEOAContractRouter.sol:263.
> - `PremiumAutomationManager.sol` = Chainlink **Automation**. Unlimited LINK
>   approve at L99-100; per-user CREATE2 cron deploy at L131-155; withdrawLINK L221.
> - `PremiumMail{Activated,BeforeActivation,ReadyToActivate}.sol` = Chainlink
>   **Functions** consumers (Sepolia Functions router 0xb83E…38D0, run JS → Mailjet).
> - `PremiumRegistry.sol`: `usdt`/`usdc` typed `ERC20` (L17-18); raw `transferFrom`
>   at L169 (USDT) + L182 (USDC), no SafeERC20.
> - `deploy/init/0.set_up_legacy.ts` passes `SUNSET_TRANSFER_ROUTER = AddressZero`
>   to `PremiumSetting.setParams` → fresh deploys start with the spoofable slot at 0.
> - `scripts/_archive/verify-phase-a.ts:97-100` asserts slot === AddressZero as the
>   Phase-A *success* condition (so Sepolia is currently in the M-2′-live state).
> - `create-flow-v2.md` §8 sketched an event-emit email refactor but explicitly
>   left Chainlink Automation in place. **This doc supersedes that stance** —
>   Phase B removes Automation *and* Functions.

---

## 1. Summary

Today the premium email-reminder system rides on **two** Chainlink products:

1. **Chainlink Automation** schedules the time-based reminders. `PremiumAutomationManager`
   deploys a per-user `PremiumAutomation` cron contract via CREATE2 and registers it
   as an upkeep; the upkeep fires `performUpkeep` → `sendNotifyFromCronjob`.
2. **Chainlink Functions** sends the actual email. Each `PremiumMail*` contract is a
   Functions consumer that builds a request, the DON runs off-chain JS, and that JS
   posts to Mailjet.

This couples our notification UX to LINK funding, two Chainlink subscriptions, and a
DON we don't control — and it forces the on-chain contracts to carry PII-shaped call
data and string fan-out logic that exists only to feed emails. Phase B replaces both
with a **Railway worker** that reads notify events from the subgraph and posts to
Mailjet directly, and deletes the on-chain machinery that existed to serve Chainlink.

Doing this also **resolves three of the four 2nd-round audit follow-ups for free**,
because the code that carries those bugs is exactly the code Phase B deletes. See §4.

---

## 2. Current architecture

```
  user sets reminder cfg
        │
        ▼
  PremiumSetting.setReminderConfigs ──► on-chain PII (names/emails) in legacyCfgs/userConfigs
        │
   (time passes)
        │
  Chainlink Automation upkeep  ──►  PremiumAutomation.performUpkeep
        │                                   │
        │                                   ▼
        │                         PremiumAutomationManager.sendNotifyFromCronjob (onlyCronjob)
        │                                   │  _handleBeforeActivation / _handleReadyToActivate / …
        │                                   ▼
        │                         PremiumMailRouter (onlyManager fan-out)
        │                                   │
        ▼                                   ▼
  legacy activation path            PremiumMail{BeforeActivation,ReadyToActivate,Activated}
  (TransferLegacyEOAContract,            │  = Chainlink Functions consumers
   MultisigLegacyContractRouter)         ▼
        │                         Chainlink Functions DON runs JS ──► Mailjet ──► recipient
        ▼
  PremiumSetting.triggerActivation*  ──► PremiumMailRouter ──► (same Functions path)
```

Key properties of the current design:
- **LINK is a hard dependency** for every reminder. `PremiumAutomationManager` keeps an
  unlimited LINK approve to the registrar + registry (L99-100) and auto-tops-up upkeeps
  (`_fundKeepupIfNeeded`, L225-231).
- **PII lives on-chain.** `PremiumSetting.legacyCfgs[*].beneficiaries[i].{name,email}` and
  `userConfigs[*]` are read inside the trigger functions and passed inline to the mail path.
- **Three activation triggers** feed the mail path: `triggerActivationTransferLegacy`
  (`onlyLegacy`, L320), `triggerActivationMultisig` (`onlyRouter`, L299),
  `triggerOwnerResetReminder` (`onlyRouter`, L271).

---

## 3. Target architecture

```
  user sets reminder cfg (UI) ──► reminder-worker ingest endpoint
        │                          └─► ENCRYPTED email store (off-chain, per-row deletable,
        │                              keyed by chainId+legacy+recipient — §11)
        ▼
  on-chain contracts EMIT events only (no PII, no string fan-out):
     • LegacyEmailNotifyRequested(chainId, legacy, creator, layer, recipients[], notifyType)
     • emitted by the activation paths + a new time-reminder emitter
        │
        ▼
  computing-subgraph indexes the events (durable, replayable log)
        │
        ▼
  reminder-worker (NEW Railway service, computing/services/reminder-worker)
     • scheduler loop: calls the on-chain "due" view (see §5.1) for registered legacies
       (replaces Chainlink Automation's checkUpkeep/performUpkeep)
     • event consumer: reads LegacyEmailNotifyRequested (replaces Chainlink Functions)
     • resolves recipient emails from DB
     • dedupes against a small KV sent-ledger keyed by chainId:legacy:notifyType:periodBucket
     • POSTs to the EXISTING email-proxy /send (does NOT re-implement Mailjet auth)
        │
        ▼
  email-proxy /send (existing Railway service — owns Mailjet creds, chunking)
        │
        ▼
     Mailjet ──► recipient
```

### 3.1 Reusing the existing `email-proxy` (don't rebuild it)

`computing/services/email-proxy` already exists on Railway: a stateless Hono service that
holds the Mailjet credentials, exposes `POST /send`, validates, rate-limits per-IP, and
forwards to Mailjet v3.1. Today it serves the **frontend's** manual "send legacy
instructions" emails — it is *not* on the automated reminder path (that path is still
Chainlink Functions → 10102 mail service → Mailjet).

Phase B makes the new `reminder-worker` the proxy's second client. The proxy stays the
single Mailjet-credential boundary; the worker adds the durability the proxy deliberately
omits (its README lists "no persistent rate-limit store", "no analytics", in-memory only).
Two small proxy changes are required:

1. **Template variables.** `validate.ts` hard-codes the instruction-email variable shape
   (`beneficiary_name`, `owner_name`, `legacy_id`, …). Reminder templates use different
   variables, so the proxy needs either a per-`templateId` schema or a generic
   `variables: Record<string,string>` passthrough. Recommend the generic passthrough with
   a light allowlist of known template IDs.
2. **Worker auth + rate-limit bucket.** The per-IP in-memory limiter will throttle a
   server-to-server worker doing batch sends from one IP. Add a shared-secret header that
   bypasses (or gets a separate, higher) bucket. CORS is already a non-issue for the worker
   (no `Origin` header → the proxy's CORS check returns null and allows the server call).

### 3.2 Bonus: this fixes the documented duplicate-email trade-off

`computing-docs/architecture/email-reminders.md` documents a known limitation: because
Chainlink Functions fans out across multiple oracle nodes and Mailjet doesn't dedupe,
**the same reminder can arrive multiple times**. A single `reminder-worker` with a
KV sent-ledger eliminates this — one sender, idempotency-keyed. Worth calling out
in the release notes as a UX win, not just an infra change.

Design goals:
- **No LINK, no DON, no Chainlink subscription.** Reminders become a worker cron.
- **Idempotent + durable.** A small sent-ledger keyed by a deterministic idempotency key.
  A worker restart or a subgraph re-org replay never double-sends.
- **No PII on-chain.** Events carry addresses + an enum, never names/emails. The recipient
  emails live in the worker's **off-chain encrypted store** (Option B, §11), resolved by
  `(chainId, legacy, recipient)` at send time.
- **Portable.** The worker is a plain Node service (no platform-locked primitives), so the
  follow-up dual-provider failover (Fly.io/Render) is a deploy target, not a rewrite.

Safety property (unchanged from create-flow-v2 §8, restated): the worker has **no
privileged on-chain authority**. Worst case if an event is spoofed in the indexer: a
spurious "someone may have claimed your legacy" email. Annoying, never fund-moving. The
worker additionally verifies each event originated from a known contract address.

---

## 4. Security-findings absorption (the reason we bundled this)

Your 2nd-round auditor flagged one new issue (M-2′) and three carry-overs. Here's
exactly how each lands in Phase B.

### 4.1 M-2′ — `onlyLegacy` spoof — **resolved structurally (deletion)**

`onlyLegacy` (PremiumSetting.sol L100-108) trusts `IPremiumLegacy(msg.sender).router()`,
a getter the caller controls. When the sunset router slot is `address(0)` — which is the
*current Sepolia state* and the *fresh-deploy default* (see deploy/init/0) — an attacker
contract returning `router()==address(0)` and `creator()==<victim>` passes the check and
calls `triggerActivationTransferLegacy` with attacker-crafted asset/beneficiary content,
sending a phishing-grade "your legacy was activated" email to the victim's real address.

`onlyLegacy` has **exactly one consumer**: `triggerActivationTransferLegacy`. Phase B
moves that function's job to event emission and **deletes both the function and the
modifier**. With no code dereferencing a caller-supplied `router()`, the entire bug class
is gone — not patched, removed. **This deletion (in B-2) is the real fix.**

> **CONFIRMED ON-CHAIN (2026-05-29):** the mainnet slot reads `address(0)`, so M-2′ is
> reachable on **mainnet today**, not only Sepolia. This corrects the audit's framing
> ("not currently exploitable on production") — it assumed the dormant address was
> retained; the Phase-A wiring set it to zero on both networks.

> **Important correction to our own earlier interim idea:** "reject `address(0)` in
> `setParams`" (or "point the slot at a live router") does **not** actually close M-2′.
> The attacker's contract controls what its own `router()` getter returns — it can return
> a *real* router address just as trivially as `0`. So the spoof passes regardless of
> whether the slot is zero or a live address. The zero state only makes the laziest
> version (a contract that returns the default `0`) work without the attacker looking up a
> router address. **The only complete fixes are:**
> 1. **Structural deletion** of `triggerActivationTransferLegacy` (B-2) — preferred.
> 2. **Allowlist check** in `onlyLegacy`: verify `msg.sender` is a legacy the claimed
>    router actually deployed (e.g. `IRouter(router).isLegacy(msg.sender)` or a
>    PremiumSetting-side registry populated at create time). Closes the class without the
>    full Phase B, but is a `PremiumSetting` upgrade (bigger than one line) — viable if we
>    want M-2′ closed in **B-1** rather than waiting for B-2.
>
> Mitigating context: impact is **email-only phishing** (no fund movement), and the
> premium target set on mainnet is **3 wallets** (only premium creators are reachable, and
> there are 3 ETH subscribers).
>
> **DECISION (2026-05-29): Option A — accept + document until B-2.** No interim contract
> upgrade; M-2′ is an accepted known risk until the B-2 deletion removes it. Operational
> guard in the meantime: the activation email is **not** a security-bearing channel — our
> templates already tell recipients we never ask them to sign/connect via email (see
> `computing-docs/architecture/email-reminders.md` privacy note), which blunts the phishing
> value. Do not market the activation email as authoritative; on-chain state is the source
> of truth for any real activation.

### 4.2 USDT/USDC raw `transferFrom` — **fixed in the registry upgrade (SafeERC20)**

`PremiumRegistry.subcribeWithUSDT/USDC` (L169/L182) call `ERC20.transferFrom` and the
0.8 ABI decoder expects a `bool` return. Mainnet Tether returns no data → the call
reverts → USDT subscriptions cannot succeed on real Tether. We switch both paths to
`SafeERC20.safeTransferFrom`. One import, two line changes, plus a regression test using a
no-return-bool mock token.

> **CONFIRMED ON-CHAIN (2026-05-29):** `usdt()` = `0xdAC1…ec7` (classic Tether, no bool
> return), `usdc()` = real USDC, and **zero** USDT/USDC subscriptions have ever occurred
> on mainnet (3 ETH subs only). So this is a **silent** correctness fix — it unblocks a
> path that was 100% broken, with no live users to migrate. Good candidate to ship early
> in **B-1**.

### 4.3 `triggerActivationTransferLegacy` array-OOB — **moot (function deleted)**

The L361 loop indexes `beneficiaries[i]` by `cfgBeneficiaries.length` and can OOB-revert
if a user re-points beneficiaries without re-syncing. Since the function is deleted in
§4.1, the bug disappears. The replacement emitter iterates only over indexed recipient
addresses with no cross-array indexing.

### 4.4 Unlimited LINK allowance — **moot (Automation retired)**

`PremiumAutomationManager` (L99-100) keeps `type(uint256).max` LINK approvals. Phase B
decommissions Automation entirely (§5.3, §6), so the contract — and its allowance — is
retired. Remaining LINK is withdrawn via `withdrawLINK` before teardown.

**Net:** M-2′ resolved by deletion; USDT/USDC fixed by SafeERC20; the other two vanish
with the code that carried them. All four follow-ups close inside this one release.

---

## 5. On-chain contract changes (`computing-sc`)

### 5.1 New notify event + emitters — **DONE (code, 2026-06-01)**
- Added (final, lean signature — see size note below):
  `event LegacyEmailNotifyRequested(address indexed legacy, address indexed creator, uint8 layer, uint8 notifyType)`
  with `enum NotifyType { OwnerReset, ActivatedMultisig, ActivatedTransfer }` (0/1/2).
  - **No `recipients[]`**: recipient *addresses* are already indexed from the config events
    (`LegacyReminderUpdated`/`BeneficiariesEmailSync`), so the worker joins this trigger
    signal to the recipient set it already holds. Omitting the array also avoids on-chain
    array-building (the expensive part) — see size note.
  - **No `chainId`**: the subgraph + worker are per-network, so the chain is implicit.
  - `notifyType` here (0/1/2) is **distinct** from the legacy Chainlink automation
    `notifyType` (1–7 reminder stages seen in `PremiumAutomation`); the subgraph/worker map
    between them. This new event is the only one the worker consumes post-cutover.
- **Emit-alongside (Deploy 1, non-breaking):** all three triggers
  (`triggerOwnerResetReminder`, `triggerActivationMultisig`, `triggerActivationTransferLegacy`)
  now `emit` the signal **before** the `premiumSendMail == address(0)` guard and after the
  `isPremium(creator)` check — so the new path fires for premium legacies independent of the
  Chainlink-era mail wiring (and keeps firing after that wiring goes inert). The inline
  `premiumSendMail.*` calls are untouched in Deploy 1 (removed at cutover, Deploy 2).
- Tests: `test/PremiumSettingNotify.spec.ts` (4 passing) + `contracts/mock/MockPremiumLegacy.sol`.
  Full related suite (PremiumRegistry/Automation/Multisig/EOA) green (52 passing).

> **⚠ BYTECODE CEILING — affects Deploy 1.** `PremiumSetting` sits right at the 24576-byte
> EIP-170 limit. The naive first cut (event carrying `chainId` + `address[] recipients`, built
> via 3 helpers) pushed the impl to **25512 bytes — undeployable on mainnet.** Fixed by (a) the
> lean event above and (b) converting the `onlyPremium`/`onlyRouter`/`onlyLegacy` string-revert
> messages to **custom errors** (`PremiumOnly`/`RouterOnly`/`OnlyLegacy`) — net result **under
> 24576**. Implication: Deploy 1 has ~zero headroom; any *further* additive change to
> `PremiumSetting` before the Deploy-2 deletions must be size-checked. The Deploy-2 removal of
> `triggerActivationTransferLegacy` reclaims the bulk of the room back.

- **Keep the "is a reminder due?" logic on-chain** as a plain `view` (reuse the existing
- **Keep the "is a reminder due?" logic on-chain** as a plain `view` (reuse the existing
  `Automation.checkUpkeep` computation — it reads per-legacy timestamps + `PremiumSetting`
  windows). The worker calls this view instead of Chainlink Automation calling
  `performUpkeep`. This preserves the "due" determination on-chain (the worker cannot
  email before the chain agrees the window is open) while moving only the *cron trigger*
  off-chain — the decentralization-preserving option you leaned toward in §7.5.

### 5.2 Deletions
- `PremiumSetting.triggerActivationTransferLegacy` (L320-409) — **delete**.
- `PremiumSetting.onlyLegacy` modifier (L100-108) — **delete** (no remaining consumer).
- `IPremiumSetting.triggerActivationTransferLegacy` (interface L20) — **delete**;
  update the one caller, `TransferLegacyEOAContract.sol:794`, to emit/return instead.
- `PremiumAutomationManager` + `PremiumAutomation` — **retire** (stop deploying new cron
  contracts; keep bytecode on-chain for existing upkeeps until cancelled in §6).
- `PremiumMail{Router,BeforeActivation,ReadyToActivate,Activated}` — **retire** the
  Functions-send role. Whether to delete the contracts or leave them inert pending a
  later storage cleanup mirrors create-flow-v2 §8's staged approach (decision in §7).

### 5.3 `PremiumRegistry` upgrade
- **B-1 — DONE (code, 2026-06-01):** added `using SafeERC20 for IERC20;` and switched the
  `subcribeWithUSDT`/`subcribeWithUSDC` transfers to `IERC20(address(usdt/usdc)).safeTransferFrom`.
  Storage/getters untouched (`usdt`/`usdc` stay `ERC20` slots → no layout change). New mock
  `contracts/mock/MockNoReturnERC20.sol` (Tether-style, returns no bool) + 2 regression tests
  in `test/PremiumRegistry.spec.ts` ("[Audit follow-up] SafeERC20 tolerates no-bool-return
  tokens"). Full `PremiumRegistry.spec.ts` suite green (23 passing). **Not yet deployed.**
- Drop the LINK-related wiring that only existed to fund Automation (audit 4.4) — deferred to
  B-2 (it's part of the Automation teardown, not the token fix).
- Storage layout must be verified identical (it's a proxy) — append-only, no reorder.

### 5.4 `PremiumSetting` storage
- The three router slots + `onlyLegacy` removal: the modifier is code, not storage, so it's
  safe to delete. The router *storage slots* stay (don't reorder a proxy); they simply
  stop being read by any spoofable path. `onlyRouter` still uses them legitimately.

### 5.5 Email-PII removal (Option B — emails go off-chain)
Today `PremiumSetting` stores PII on-chain and — worse for erasure — **emits it in event
args**: `userConfigs[*].{ownerName,ownerEmail}` and `legacyCfgs[*]` `EmailMapping[]`
(`email`/`name`) for cosigners/beneficiaries/second+third line, written by the config
setters and surfaced in `UserConfigUpdated(..., string name, string email, ...)`,
`setReminderConfigs`, `BeneficiariesEmailSync`, etc. Option B moves these off-chain:

- **Stop emitting PII (most important — events are immutable).** New event variants carry
  **no `name`/`email` strings**, only the address + a config version/flag. This is the part
  that can't be undone later, so it must land in the same upgrade that introduces the
  off-chain store. (The old PII-bearing events stay in historical logs — see §11.2 erasure
  caveat.)
- **Stop writing PII to storage.** Config setters (`setUserConfig`/`updateUserConfig`/
  `setReminderConfigs`/`syncBeneficiariesEmails`) drop the email/name string params (or
  accept them and ignore) — the frontend instead POSTs the email to the worker's encrypted
  ingest endpoint (§11.3). `timePriorActivation` + the address-keyed structure stay on-chain
  (that's the "is a reminder due?" input the §5.1 view needs).
- **Keep the storage slots, don't reorder (proxy).** The `string` PII slots remain in the
  struct layout but stop being populated; a later storage-strip release can reclaim them.
- **Best-effort erasure of existing values.** Add an owner-callable `clearLegacyPII` /
  `clearUserPII` that overwrites the current on-chain `ownerEmail`/`email`/`name` strings to
  empty for the 3 live premium wallets (current values are mutable; only the historical
  event logs are immutable — §11.2).
- The `getUserData`/`getBeneficiaryData`/`getSecondLineData`/`getThirdLineData` getters that
  the triggers used to feed `premiumSendMail` are no longer needed by the email path (the
  worker resolves emails off-chain); leave them or drop them per the §7.4 inert-vs-strip call.

---

## 6. Migration / rollout

Ordering matters because Automation upkeeps are live and hold LINK.

1. **Ship the worker first (dark).** Deploy the Railway worker + subgraph notify-event
   handlers reading from the *new* events, but keep Chainlink running in parallel. Verify
   the worker would send the same emails (log-only / dry-run mode) for a full reminder cycle.
2. **Deploy contracts.** Upgrade `PremiumSetting` (emitters + deletions) and `PremiumRegistry`
   (SafeERC20). Sepolia first, full integration pass, then mainnet.
3. **Flip the worker live**, disable dry-run. Now both paths could email — so immediately:
4. **Cancel Chainlink upkeeps**, withdraw LINK (`withdrawLINK`), tear down the Automation
   registration and the Functions subscription. This stops the old path.
5. **Frontend** stops calling the deprecated reminder setters for new legacies; moves PII
   capture to the `computing-admin` DB endpoints.
6. **Subgraph** redeploy/reindex coordinated with step 2.

Rollback: if the worker misbehaves after step 3, re-enable dry-run (worker stops sending)
and the contracts still emit harmlessly; we have not yet cancelled upkeeps until we're
confident, so step 4 is the point of no return.

---

## 7. Decisions

1. **Mailjet — CONFIRMED** (keep for now). The worker routes through the existing
   `email-proxy` rather than calling Mailjet directly (§3.1).
2. **Two on-chain reads — DONE 2026-05-29** (`scripts/audit-followup-readonly.ts`):
   - mainnet `transferLegacyContractRouter()` = **address(0)** → M-2′ reachable on mainnet
     today.
   - `usdt()` = classic Tether, **0** USDT/USDC subs ever → SafeERC20 fix is silent.
3. **Release split — RECOMMENDED B-1 / B-2** (sequencing/risk only, no relation to Gnosis
   Safe — see naming note below):
   - *B-1 (small, fast):* `PremiumRegistry` → `SafeERC20.safeTransferFrom` (confirmed silent
     fix; unblocks USDT/USDC subscriptions). **M-2′ is NOT in B-1** — DECIDED Option A
     (accept + document until B-2's deletion is the real fix; see §4.1).
   - *B-2 (the big lift):* `reminder-worker` + event refactor + Chainlink teardown, which is
     what structurally deletes `onlyLegacy`/`triggerActivationTransferLegacy` (the real M-2′ fix).
   - > **Naming note:** "**SafeERC20**" is OpenZeppelin's wrapper for tokens whose
     > `transfer/transferFrom` don't return a bool (mainnet USDT). It is **unrelated** to
     > the "**Safe**-source Transfer" legacy flow (Gnosis Safe multisig) that was sunset in
     > v2026.05.18. The B-1/B-2 split is purely about shipping the cheap token fix before
     > the large retirement; it has nothing to do with Safe wallets.
4. **Mail/Automation contracts — RECOMMENDED leave inert, strip later.** These are
   upgradeable proxies holding storage. Two ways to retire them:
   - *Leave inert:* stop calling them; they stay deployed doing nothing. Zero new
     storage-layout risk, zero redeploy. (create-flow-v2 §8 chose this.)
   - *Delete now:* remove source + run a storage-cleanup upgrade — a second proxy
     storage-layout change on top of B-2's, for cosmetic benefit.
   Recommend **leave inert** in B-2, and schedule a separate storage-strip release later if
   we ever want the slots back. (This is the question you said you weren't sure about — it's
   just "unplug it" vs. "unplug it and also rip the wiring out of the wall today.")
5. **Time-reminder trigger — DECIDED: on-chain `view`.** Per your lean, keep the "is it
   due?" computation on-chain (reuse `checkUpkeep` logic as a `view`); the worker calls it
   and only the cron trigger moves off-chain. Preserves the trust property; see §5.1 + §9.

---

## 8. What deliberately stays unchanged
- Legacy **claim / activation fund movement** — entirely separate from the email path; untouched.
- `onlyRouter` and the legitimate router storage slots in `PremiumSetting`.
- The EOA + Multisig create/activation flows (only their *email emit* changes).
- Premium subscription pricing, plans, and the ETH subscription path (already SafeERC20-free
  by design — native value, not a token).

---

## 9. On the "plan must survive 10102" principle

Your original vision (and `email-docs/architecture/email-reminders.md`) is that the plan
stays executable even if 10102 vanishes — emails are *additive*, never load-bearing. This
design **does not regress that**, and here's the honest accounting of why:

- The **claim path was always email-independent.** A beneficiary can activate via the app
  or Etherscan straight from on-chain state. That doesn't change.
- The **email layer was never actually decentralized.** Even today it terminates at
  Chainlink Functions → 10102's mail service → Mailjet — all centralized hops. Chainlink
  Automation gave *decentralized scheduling*, but the delivery was always centralized, and
  we paid LINK for scheduling a fundamentally centralized convenience feature. That's the
  mismatch you flagged ("chainlink is too expensive for emails").
- What we keep on-chain: the **"is a reminder due?" determination** (§5.1) and the
  **opt-in reminder config**. The worker can't fabricate a "due" state the chain disagrees
  with. So the *integrity* of when reminders fire stays trustless; only the *cron trigger
  and delivery* — already centralized — move to a service we run cheaply.

Net: we trade LINK-funded decentralized scheduling (of a centralized delivery feature) for
a cheap worker, while preserving every property that makes "the plan survives us" true.
If full decentralization of *delivery* ever becomes a goal, it's a separate effort (e.g.
a decentralized notification protocol) and unaffected by this design.

---

## 10. B-2 execution sequence + what's on whose plate

B-2 is not one code change — it's a coordinated cutover across 4 systems with a hard
dependency chain. The keystone is the on-chain event: the subgraph can't index what the
contracts don't emit, the worker can't read what the subgraph doesn't have, and the
frontend PII capture feeds the worker's lookups.

```
contract event (computing-sc) ─► subgraph indexes it ─► worker reads + sends ─► cutover
        │                                                      ▲
        └──────────── frontend/admin PII capture ──────────────┘
```

### Deploy strategy — SINGLE lean end-state upgrade (REVISED 2026-06-01)

**Decision (2026-06-01, with you):** drop the two-deploy emit-alongside/cutover split. Do the
**full end-state in one contract upgrade.** Rationale: the only thing the split bought was
running the new worker "dark" against still-live Chainlink to avoid an email-reminder gap —
and you've accepted a bounded gap (emails are additive; the inheritance claim path is
email-independent, §9). Carrying a permanently bloated contract + a second mainnet upgrade
to buy that safety net isn't worth it. One deploy = a lean contract immediately + M-2′ fixed
structurally now (not "documented until later").

What the single upgrade does (all at once):
- **B-1** SafeERC20 in `PremiumRegistry` (already coded).
- Keep the lean `LegacyEmailNotifyRequested` event (already coded) as the *only* notify path.
- **Delete** `triggerActivationTransferLegacy` + `onlyLegacy` → biggest function gone + M-2′
  closed structurally. Re-home the "assets transferred" emit (see open design Q below).
- **Remove** the inline `premiumSendMail.*` calls from the two kept triggers (they become
  emit-only) and drop the `premiumSendMail`/automation wiring that only fed Chainlink.
- **Stop writing/emitting email PII** (§5.5) + add the best-effort `clear*PII` erasure setter.
- Add the on-chain "is due?" `view` (§5.1) — **or** put it on a small separate read-only
  helper if `PremiumSetting` is still tight after the deletions (it shouldn't be — the
  deletions reclaim far more than the view adds).
- **Efficiency pass:** convert the remaining ~15 string-`require`s to custom errors while
  we're in here (cheap bytecode win + cleaner).

**The gap is bounded, not open-ended — mandatory sequencing:**
1. Build worker + subgraph + email-proxy changes (all off-chain, cheap, editable anytime).
2. Deploy the end-state contracts to **Sepolia**, point the worker at them, confirm it
   actually sends real emails end-to-end for each notify type.
3. **Then** the single mainnet upgrade + flip the worker live + Chainlink teardown
   (cancel upkeeps, withdraw LINK, tear down Functions sub).

This is just test-on-Sepolia-then-prod — NOT a second mainnet contract deploy.

> **RESOLVED (2026-06-01) — Option (d): re-home to an `onlyRouter` emit driven by the EOA
> router.** EOA activation is already router-driven (`TransferLegacyEOAContract.activeLegacy`
> is `onlyRouter`), and the EOA router is an **upgradeable proxy** that already calls into
> `PremiumSetting` (cron setup). So: delete `triggerActivationTransferLegacy` + `onlyLegacy`;
> add a slim `notifyActivatedTransfer(address legacy, address activatingBene)` guarded by the
> existing (non-spoofable) `onlyRouter`; the EOA router calls it during activation instead of
> the legacy clone calling in via the spoofable `onlyLegacy`.
> - Why not "legacy emits its own event": legacy contracts are **non-upgradeable EIP-1167
>   clones**, so existing legacies would never emit it. Router-driven covers old + new.
> - Why not the allowlist-fix on `onlyLegacy`: keeps the fat function (defeats "lean").
> - **Email richness — DECIDED: preserve detail, reconstructed off-chain.** The lean notify
>   event carries only `(legacy, creator, layer, notifyType)`. The per-beneficiary asset
>   amounts that the deleted function passed inline are **reconstructed by the worker** from
>   the ERC-20 `Transfer` (and ETH) events of the activation tx (via the subgraph), so the
>   "assets transferred" email keeps its "you received X USDC + Y ETH" detail without any
>   PII or rich calldata on-chain. This is worker/subgraph work, not contract work.

> **STORAGE-LAYOUT NOTE (proxy):** stripping email PII is logic + write changes; do NOT
> reorder/remove the existing `userConfigs`/`legacyCfgs` storage slots (proxy safety). Stop
> populating them and overwrite existing values to empty via `clear*PII`. A later cosmetic
> storage-strip release can reclaim slots if ever wanted. With only 3 live premium wallets,
> erasure migration is trivial.

### What's on MY plate (code, no action from you)
1. `computing-sc` END-STATE upgrade: keep the notify event (done); **delete**
   `triggerActivationTransferLegacy`+`onlyLegacy`; make the kept triggers emit-only; strip
   PII (§5.5) + `clear*PII`; add the "due" `view`; string-`require`→custom-error pass.
   Resolve the ActivatedTransfer-emit home (open Q above). Tests + size check.
2. `computing-subgraph`: index `LegacyEmailNotifyRequested` into a `NotifyRequested` entity. Tests.
3. The `reminder-worker`: scheduler loop, subgraph reader, **encrypted email store +
   sent-ledger** (§11.3), posts to `email-proxy`. **Hosting TBD — leaning Cloudflare Workers +
   Cron Triggers + D1 over Railway + Postgres.** Includes the encrypted `/ingest` endpoint the
   frontend/admin calls (replacing the on-chain PII write) + the `/erase` endpoint (§11.3).
4. `computing/services/email-proxy`: generic `variables` passthrough + worker shared-secret
   bypass for the rate limiter (§3.1).
5. Single upgrade+verify script for `PremiumRegistry` + `PremiumSetting` (reuses the proven
   `upgrade-premium-registry.ts` pattern). Sepolia first, then mainnet.

### Worker hosting + data store (revised for Option B — emails now off-chain)
Per the §11 decision the worker now owns **two** durable things, not one:
1. an **encrypted email store** — recipient emails/names at rest, keyed by
   `(chainId, legacy, recipient)`, per-row deletable for GDPR erasure (§11.3); and
2. a **sent-ledger** — the dedupe flag ("already sent reminder X for legacy Y this window?").

Because (1) needs per-row reads, encrypted blobs, and **deletion** (right-to-erasure), a
pure KV flag store is no longer sufficient; we want a small queryable, row-deletable table.
Options:
- **Cloudflare Workers + Cron Triggers + D1 (SQLite)** — RECOMMENDED. Fully managed, cron-
  native, nothing to provision but the Worker. D1 holds two tables: `recipient` (encrypted
  email blob + key ref) and `sent_ledger`. KV optionally fronts the sent flag for speed.
  Encryption key lives in a Worker secret / Cloudflare Secrets Store (not in D1).
- **Railway cron + Postgres addon** — if you'd rather keep it beside `email-proxy`; same
  two-table schema, key in a Railway secret. Heavier to run but co-located.
- Either way the worker still POSTs to the Railway `email-proxy` for the Mailjet send, so
  delivery still depends on Railway; true cross-provider DR is a separate follow-up.
- **Decryption authority stays with the worker** (server-held key) — the pragmatic Option-B
  posture. A later Phase C can move that authority to a Lit Protocol condition-gated key so
  we're no longer the sole party able to read emails (§11.4); the at-rest store is designed
  so that upgrade is additive, not a rewrite.

### What's on YOUR plate (infra — flagged now, NOT needed yet)
I'll tell you the moment each is actually required; nothing to do today.
- **Pick the worker host** (Cloudflare Workers + D1, or Railway + Postgres).
- **Provision it** when we get there: a Cloudflare Worker + D1 database (+ optional KV), OR
  a Railway service + Postgres — plus env vars (proxy URL, shared secret, subgraph URL,
  RPC URL) and **one new secret: the email-store encryption key** (§11.3).
- **Run the bundled mainnet upgrade** (Deploy 1) — needs your deployer key + a little ETH.
  I prepare + test on Sepolia; you run mainnet (or approve me running it).
- **Chainlink teardown at cutover (Deploy 2):** cancel the Automation upkeeps + withdraw
  remaining LINK + tear down the Functions subscription (your Chainlink account).

### Status
- B-1 code: **done, tested** (§5.3). Awaiting bundle.
- Email-storage decision: **MADE 2026-06-01 — Option B** (off-chain encrypted; §11).
- B-2 step 1 (PII-free `LegacyEmailNotifyRequested` + emit-alongside in all 3 triggers):
  **DONE + tested 2026-06-01** (§5.1; 4 new + 52 related tests green; impl back under the
  24576-byte limit via lean event + custom-error conversion).
- **Next up:** B-2 step 2 — on-chain "is a reminder due?" `view` (reuse `checkUpkeep` logic),
  then subgraph indexing (step 3). NOTE the ~zero bytecode headroom warning in §5.1 — the
  due `view` is read-only logic but still adds code to `PremiumSetting`; size-check it, and
  if it doesn't fit, it can live on a small separate read-only helper contract instead.

---

## 11. Email storage decision (Option B — off-chain encrypted)

**DECISION (2026-06-01): Option B — store emails OFF-CHAIN in an encrypted, per-row-
deletable store owned by the `reminder-worker`, with a server-held decryption key.** The
on-chain plaintext email/name fields stop being written and (critically) stop being emitted
in events (§5.5). A decentralized condition-gated key network (Lit Protocol) is the only
viable *encrypted* upgrade and is deferred to **Phase C** (§11.4), not B-2.

This was decided after three parallel research streams (crypto/privacy tech; production
dApp PII practice; decentralization norms). They converged:

### 11.1 Why Option B (and why not the alternatives)

| Option | What it is | Verdict |
|---|---|---|
| **A — plaintext on-chain (current)** | emails in contract storage + event logs | **Reject.** Recognized anti-pattern; EDPB 2025 treats plaintext PII on an immutable chain as a near-automatic GDPR violation (immutability defeats right-to-erasure). This is the one clearly wrong answer. |
| **B — off-chain encrypted DB, server-held key** | ciphertext in worker store, worker decrypts at send time | **CHOSEN.** Only option that cleanly satisfies the hard constraint (*automated sender must read plaintext at send time*), supports GDPR deletion, and drops into the planned worker. What every comparable production dApp (Safe, Lens, Farcaster clients) does. |
| **C — decentralized storage (IPFS/Arweave/Ceramic)** | encrypted blobs on permanent/public storage | **Reject for now.** Their encryption decrypts for the *user's* wallet, not a headless sender; Arweave/IPFS permanence reintroduces the erasure problem. Wrong fit for "server-readable email." |
| **D — encrypted on-chain via condition-gated key net (Lit/tACo)** | ciphertext off-chain, decryption gated by an on-chain condition, released to the worker | **Defer to Phase C.** Genuinely decentralized and fits the constraint, but EDPB still says keep ciphertext off the immutable L1, so emails don't truly return on-chain anyway — its real value is removing *us* as the sole decryptor. Additive on top of B. |

Tech that sounds relevant but **isn't** for this use case: **FHE** (Zama/Fhenix/Inco) and
**time-lock** (Shutter/drand) make the email *public* on reveal — opposite of what we want;
**zkEmail** *proves facts about* an email, it doesn't store or send one.

### 11.2 GDPR posture (the actual driver)
EDPB Guidelines 02/2025: store personal data **off-chain**, keep at most a non-identifying
reference on-chain, and design so deleting the off-chain data/keys satisfies erasure.
- Going forward: emails live only in the worker's encrypted store; on-chain events carry
  addresses + an enum, never strings (§5.5). Erasure = delete the row / destroy the per-
  record key (crypto-shredding).
- **Honest caveat:** historical PII-bearing event logs (`UserConfigUpdated(..., email)`,
  etc.) already on mainnet **cannot be erased** — they're immutable. Mitigants: only **3
  premium wallets** are affected; we add the best-effort `clear*PII` overwrite of current
  storage (§5.5); and we stop emitting PII from the upgrade onward. Document this residual
  in the DPIA / privacy note rather than pretend it's fully reversible.

### 11.3 `reminder-worker` data model + erasure flow (implementation-ready)
Two tables (D1/SQLite or Postgres). The encryption key is a **worker secret**, never in the
DB. Each row is encrypted with AES-256-GCM under a key derived per-record (so a single row
can be crypto-shredded by dropping its key salt, and a global key rotation re-wraps).

```
recipient(
  id              TEXT PRIMARY KEY,         -- hash(chainId|legacy|recipientAddr)
  chain_id        INTEGER NOT NULL,
  legacy          TEXT NOT NULL,            -- legacy contract address (lowercased)
  recipient_addr  TEXT NOT NULL,            -- on-chain address the event references
  role            TEXT NOT NULL,            -- owner|beneficiary|cosigner|secondLine|thirdLine
  enc_email       BLOB NOT NULL,            -- AES-256-GCM(email)
  enc_name        BLOB,                     -- AES-256-GCM(display name), optional
  key_salt        BLOB NOT NULL,            -- per-record salt; deleting it crypto-shreds the row
  iv              BLOB NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
)

sent_ledger(
  idem_key        TEXT PRIMARY KEY,         -- hash(chainId|legacy|notifyType|periodBucket)
  recipient_id    TEXT NOT NULL,
  sent_at         INTEGER NOT NULL,
  mailjet_msg_id  TEXT
)
```

Endpoints the worker exposes (auth: shared-secret, same pattern as the email-proxy bypass):
- `POST /ingest` — `{chainId, legacy, recipientAddr, role, email, name?}` → encrypts +
  upserts a `recipient` row. Called by the frontend/admin when a user sets/edits reminder
  config (replacing today's on-chain config write of PII).
- `POST /erase` — `{chainId, legacy, recipientAddr}` or `{recipientAddr}` → deletes the
  row(s) and destroys the `key_salt` (crypto-shred). Backs the GDPR right-to-erasure.
- `GET /due` (internal cron) — scheduler loop: for registered legacies, call the on-chain
  "due" view (§5.1), and for `LegacyEmailNotifyRequested` events from the subgraph, resolve
  `recipient` rows, dedupe via `sent_ledger`, decrypt in-memory, POST to `email-proxy`,
  then write `sent_ledger`. Plaintext email exists only transiently in worker memory.

Send-time flow: subgraph event (addresses only) → worker looks up `recipient` rows by
`(chainId, legacy, recipientAddr)` → `idem_key` check against `sent_ledger` → decrypt →
POST `email-proxy /send` with `variables` → on 2xx, insert `sent_ledger`. Idempotent across
restarts and re-org replays.

### 11.4 Phase C (optional, not B-2): remove ourselves as sole decryptor via Lit
If "the company can never read user emails" becomes a product promise (a strong story for an
*inheritance* product specifically), wrap the same off-chain ciphertext with **Lit
Protocol**: a Lit Action decrypts-and-only-then-sends when the on-chain "due" condition is
true, triggered by the worker's API key rather than a human wallet (~$0.01/reminder, prod-
ready 2026). The §11.3 schema already isolates ciphertext from key material, so this is an
additive swap of "worker decrypts with its own key" → "Lit network releases plaintext to the
worker on condition," not a re-architecture. **tACo/Threshold** is a heavier alternative
(run a node cohort, pay in DAI). Not scheduled; recorded so B-2 doesn't foreclose it.

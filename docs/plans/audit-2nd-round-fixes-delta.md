# Fixes-delta — 2nd-round audit follow-ups

**For**: external security reviewer
**From**: 10102 dev
**Date**: 2026-05-29
**Re**: disposition of the four follow-ups from the post-v2026.05.18 review
**Companion**: full design in `docs/plans/chainlink-email-retirement.md` (Phase B)

---

## TL;DR

All four follow-ups are addressed by one upcoming release ("Phase B": Chainlink
Automation + Functions retirement + off-chain email worker). Three are resolved by
**deleting** the code that carried them; one is a `SafeERC20` swap in a `PremiumRegistry`
upgrade we're doing anyway. No item is being silently deferred.

---

## Item-by-item

### M-2′ — `onlyLegacy` spoof when the sunset router slot is zero
**Disposition: resolved structurally by deletion.**
`onlyLegacy` (PremiumSetting.sol L100-108) is dereferenced by exactly one function,
`triggerActivationTransferLegacy` (L320-409). Phase B converts that function's job to
event emission and deletes both the function and the modifier. No remaining code trusts a
caller-supplied `router()`, so the class is removed rather than patched.

**Correction to the report's severity framing (now confirmed on-chain):** the review
assumed production retains the dormant router address, so M-2′ "is not currently
exploitable." We read the slots on mainnet on 2026-05-29
(`scripts/audit-followup-readonly.ts`): `transferLegacyContractRouter` is **`address(0)`
on mainnet** (and Sepolia). So **M-2′ is reachable on mainnet today**, not merely
conditional — the Phase-A wiring set the slot to zero on both networks.

**Second correction — to a mitigation we'd floated ourselves:** "reject `address(0)` in
`setParams`" (or pointing the slot at a live router) does **not** close M-2′. The attacker
implements `router()` on their own contract and can return a *real* router address as
easily as `0`; the comparison passes either way. The zero state only enables the laziest
spoof. The genuine fixes are (1) the Phase B structural deletion of
`triggerActivationTransferLegacy` (removing the only caller-supplied-`router()` deref), or
(2) an allowlist in `onlyLegacy` verifying `msg.sender` is a router-registered legacy.

**Severity in context:** impact is email-only phishing (no on-chain value movement), and
only premium *creators* are reachable — there are **3 premium wallets on mainnet** (all
ETH subscribers; see carry-over 1).

**Decision (2026-05-29): accept + document until the Phase B (B-2) deletion**, which is the
complete fix. We're not spending an interim contract upgrade on a partial patch (reject-zero
doesn't close it). M-2′ is tracked as a known accepted risk; the activation email is treated
as non-security-bearing in the interim (our templates already state we never ask recipients
to sign/connect via email), which removes most of the phishing leverage.

### Carry-over 1 — `subcribeWithUSDT/USDC` raw `transferFrom`
**Disposition: fixed via SafeERC20 in the Phase B `PremiumRegistry` upgrade.**
Your read is correct, and confirmed on-chain: `PremiumRegistry.usdt()` is classic Tether
(`0xdAC1…ec7`, no bool return), so the 0.8 decoder reverts and USDT subscriptions can't
succeed. We're switching L169/L182 to `SafeERC20.safeTransferFrom` with a no-return-bool
mock token regression test. **On-chain history shows 0 USDT/USDC subscriptions ever on
mainnet (3 ETH subs only)** — so this is a silent correctness fix unblocking a fully-broken
path, no live users to migrate. To answer your question directly: no, no one has
successfully subscribed via USDT on mainnet — consistent with the revert.

### Carry-over 2 — `triggerActivationTransferLegacy` array-length OOB
**Disposition: moot — the function is deleted (see M-2′).**
The L361 `beneficiaries[i]` / `cfgBeneficiaries.length` mismatch disappears with the
function. The replacement event emitter does no cross-array indexing.

### Carry-over 3 — `PremiumAutomationManager` unlimited LINK allowance
**Disposition: moot — Chainlink Automation is retired.**
Phase B replaces Automation with an off-chain Railway scheduler; the manager contract and
its `type(uint256).max` approvals are decommissioned. Remaining LINK is withdrawn via
`withdrawLINK` before teardown.

---

## On-chain confirmations (read-only, 2026-05-29)
Both open items from the draft are now answered (`scripts/audit-followup-readonly.ts`):
1. mainnet `transferLegacyContractRouter()` = `address(0)` → M-2′ live on mainnet.
2. `usdt()` = classic Tether; `usdc()` = real USDC; `PlanSubcribed` history = 3 ETH, 0
   USDT/USDC → SafeERC20 fix is silent.

---

## What we are NOT changing
Legacy claim/activation fund movement, `onlyRouter` and the legitimate router slots, the
create/activation flows themselves (only their email-emit step), and subscription pricing.
The `EIP712LegacyVerifier.onlyRouter` shape you noted is unchanged and remains non-exploitable
(`msg.sender` can't be `address(0)` in a normal call; only `onlyLegacy` dereferenced a
caller-supplied getter, and that's the one being deleted).

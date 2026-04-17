# 10102 Computing Legacy × Safenet — Integration Brief

**Audience**: Safe Foundation, Safenet Transaction Checker providers, Safenet Validator operators.
**Author**: 10102 Labs (Computing Legacy).
**Status**: Discussion draft. Not a formal partnership proposal — we want to surface compatibility questions early, before Safenet exits Beta.
**Contact**: info@10102.io (general) · security@10102.io (security / responsible disclosure)

---

## 1. Who we are

10102 Labs ships **Computing Legacy**, a non-custodial inheritance and timelock protocol for Ethereum. Users configure on-chain legacies that distribute their assets to named beneficiaries after a period of inactivity, with no centralized trigger or off-chain trust assumption.

- App: https://www.10102.io/apps/computing-legacy/
- Docs: https://docs.10102.io
- FAQ: https://www.10102.io/apps/computing-legacy/faq/
- Contracts: https://github.com/10102-io/computing-sc (verified on Etherscan)
- Frontend: https://github.com/10102-io/computing

We support three legacy shapes:

1. **EOA Transfer Legacy** — an on-chain router that pulls pre-approved ERC-20s from the owner's EOA to beneficiaries at trigger time. No Safe involvement.
2. **Safe Transfer Legacy** — same pattern, but the owner is a Safe multisig. Assets approved from the Safe are pulled to beneficiaries.
3. **Multisig Inheritance Legacy** — a Safe-native flow where the owner's Safe installs a Module and a Guard; on inactivity, the Module executes transfers from the Safe to beneficiaries.

Plus a standalone **Timelock** product (time-locked release of ERC-20/721/1155 to owner or beneficiary), which does not touch Safe.

## 2. Why we're writing

Two reasons, in priority order:

1. **Compatibility**: our Multisig Inheritance flow installs a `TransactionGuard` on the user's Safe. Safenet also installs a `TransactionGuard`. Safe accepts only one at a time. Today, a user cannot run both. We'd like to explore whether there's a pattern (guard chaining, module-level attestation, a Safenet-aware evolution of our Guard) that restores compatibility.

2. **Distribution / attestation**: our routers are open-source, audited, and publicly documented. We'd like Safenet Validators and Transaction Checkers to recognize our call patterns as low-risk so end users don't hit needless friction when setting up a legacy on a Safenet-protected Safe.

## 3. On-chain footprint (mainnet)

| Contract | Address | Purpose |
|---|---|---|
| `MultisigLegacyRouter` | `0x7c7bf503DF70eBE3520f65Cc0Ff1aF093Fa85038` | Deploys per-user `MultisigLegacyContract`, manages config |
| `TransferLegacyRouter` | `0x7e173738f0bE8B4bDbA28CF91b0F5B0263Aa4b0C` | Safe-owner transfer flow |
| `TransferEOALegacyRouter` | `0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b` | EOA transfer flow (no Safe) |
| `LegacyDeployer` | `0xdb6B6487e020479120dd3e596Ff5A530eD7C88a7` | CREATE2 deployer for legacy contracts |
| `SafeGuard` (per-Safe) | deployed per user | Tracks `lastTimestampTxs` for the inactivity trigger |
| `TimeLockRouter` | `0x2B947E3c348c81409f8e8fc5ef8F65d9dFf76A42` | Timelock (no Safe) |

All implementations are upgradeable behind `DefaultProxyAdmin` (`0xA41299408EB78D67B9b599e38E3259C11A005145`). Full list of verified deployments, including Sepolia and prior versions, is in `contract-addresses.json` of the public repo.

## 4. Transactions a Safenet Validator would observe

These are the concrete call patterns that show up on a user's Safe when they use our Multisig Inheritance product. For each, we flag properties that might interest Validator rule authors.

### 4.1 Setup — user enables our Module and Guard

Single `execTransaction` from the Safe owner(s), target = the Safe itself, `data` = `multiSend` of:

1. `enableModule(MultisigLegacyContract)` — allows the per-user legacy contract to call `execTransactionFromModule`.
2. `setGuard(SafeGuard)` — installs our per-Safe Guard.
3. `MultisigLegacyRouter.createLegacy(...)` — records config (beneficiaries, trigger duration, etc.) on the router.

**Risk properties**:
- The module being enabled is a freshly-deployed `MultisigLegacyContract` whose `creator` and beneficiaries are set in the same transaction and become immutable.
- `enableModule` target is deterministic via CREATE2 and derivable from the router + Safe address pair.
- No drain path: the Module can only execute `transfer`/`safeTransferFrom` calls with `to` ∈ `{beneficiaries}` and only *after* the inactivity trigger condition evaluates true.

### 4.2 Activity tracking (passive)

Every subsequent `execTransaction` on the Safe triggers our Guard's `checkTransaction`, which updates `lastTimestampTxs = block.timestamp`. This is **the entire mechanism** by which we detect owner activity.

**This is the Safenet intersection point.** See §5.

### 4.3 Beneficiary claim (post-trigger)

Executed by *anyone* (typically a beneficiary or a watcher), target = `MultisigLegacyContract`:

1. `MultisigLegacyContract.execute(...)` calls `ISafeWallet.execTransactionFromModule(...)` to transfer assets.

**This does not go through `execTransaction`** and therefore **does not invoke the TransactionGuard**. It invokes the `ModuleGuard` slot if one is installed (Safe ≥1.4). We do not install a ModuleGuard.

**Risk properties**:
- The Module only executes if `block.timestamp ≥ lastTimestampTxs + activationTrigger`.
- Distribution amounts are bounded by beneficiary percentages fixed at setup.
- No function on the Module allows transfers to addresses outside the fixed beneficiary set.

### 4.4 Owner "heartbeat" / reset

Any owner-side transaction (including a no-op `execTransaction` to self) resets the Guard timestamp and extends the trigger. We have a dedicated "Check-in" button in the UI that issues this exact transaction.

## 5. The Guard compatibility question

Safe v1.3+ has one `TransactionGuard` slot, settable via `setGuard`. Our inactivity trigger is fundamentally derived from **the timestamp of the last `execTransaction`**, which we read via our own Guard.

If a user installs the Safenet Guard, `setGuard` overwrites ours. Consequences:

- Pre-setup: we simply fail to install our Guard (or overwrite Safenet's — bad for the user).
- Post-setup, if the user later installs Safenet: our trigger's `lastTimestampTxs` freezes at the last transaction before Safenet replaced our Guard. That's actually **fail-safe in the "wrong" direction** — it means inactivity can be falsely detected much earlier than intended, potentially triggering the legacy while the owner is still active. This is a safety hole we need to close.

**Options we're exploring, in increasing order of invasiveness:**

**A. Coexistence via guard chaining.** A thin "CompositeGuard" that holds references to multiple downstream guards and forwards `checkTransaction` / `checkAfterExecution` to each. Either we or Safe Foundation ships this as a canonical pattern. User installs the composite; it delegates to Safenet + our Guard in order. Minimal change for us; new shared infrastructure for the ecosystem.

**B. Drop our Guard; track activity differently.** Options:
- Snapshot `safe.nonce()` at setup and on each user "check-in"; derive activity from nonce progression. Weakness: we only know the *current* nonce, not when it changed, so we can't derive a timestamp without off-chain indexing.
- Require explicit on-chain "heartbeat" calls to our Module. Weakness: this is a UX regression — today any Safe activity counts as liveness.
- Use a subgraph-driven attested timestamp pushed on-chain by a keeper, trust-minimized via a multi-signer attestation. Weakness: re-introduces off-chain trust.

**C. Safenet-aware Guard.** Our Guard becomes a wrapper that *delegates* the `checkTransaction` hook to the Safenet Guard (if one is configured) and then records our timestamp. Would require a stable Safenet Guard interface we can call into. Probably needs Safe Foundation's cooperation and a published interface spec.

**D. ModuleGuard-only activity signal.** Move our state update into a `ModuleGuard` slot (distinct from `TransactionGuard`, available in Safe ≥1.4), which wouldn't conflict with Safenet. But `ModuleGuard` only fires on `execTransactionFromModule`, which our users don't call pre-activation, so this doesn't give us an activity signal.

We believe **Option A (guard chaining)** is the cleanest ecosystem pattern — it solves our problem and prevents the next Safe app from hitting the same wall. We'd happily contribute a reference `CompositeGuard` implementation if there's interest in standardizing it.

## 6. What we'd like from this conversation

Ordered by how much it would help end users:

1. **Guidance on the Guard collision**. Is guard chaining on Safe's roadmap? Is there a sanctioned workaround? Would Safe Foundation be interested in a community-contributed `CompositeGuard`?
2. **Validator rule recognition** for our `MultisigLegacyRouter`, `MultisigLegacyContract` template (verifiable via `LegacyDeployer`), `TransferLegacyRouter`, `TransferEOALegacyRouter`, and the standard `enableModule(<CREATE2-derivable>)` + `setGuard(<our SafeGuard>)` setup transaction. Happy to provide ABI specs, audit artifacts, and test vectors.
3. **Introduction to relevant Transaction Checkers** so we can publish a risk profile document in the format their rule engines consume.
4. **Feedback** on whether any of our transaction patterns are likely to trip default validator rules we haven't anticipated.

## 7. Audit & verification status

- Contracts verified on Etherscan (mainnet + Sepolia).
- Audit reports: https://github.com/10102-labs/audits
  - Inheritance contracts: [`10102-Inheritance-report.pdf`](https://github.com/10102-labs/audits/blob/main/10102-Inheritance-report.pdf)
- Test coverage: public CI in the `computing-sc` repo.
- Upgrade authority: `DefaultProxyAdmin` owned by a Safe multisig held by the 10102 team. We can share the owner set on request; migration to a community-governed admin is on our roadmap.

## 8. Appendix — Contact & next steps

- General / partnership: **info@10102.io**
- Security / responsible disclosure: **security@10102.io**
- Preferred follow-up: async via email, or a 30-min call if helpful.

We're not asking for funding, a listing, or any formal partnership. This is a technical alignment conversation — we think Safenet is heading in the right direction, we've shipped infrastructure that intersects with it in one specific place, and we'd rather design that intersection together than retrofit it later.

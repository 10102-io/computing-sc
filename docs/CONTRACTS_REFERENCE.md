# Contract Reference

Quick reference for what each deployed and core contract does in the 10102 Computing ecosystem. The system is organized around **Legacy** (inheritance/forwarding), **Term** (compliance), **Premium** (subscriptions & notifications), and **Timelock** (delayed release of assets).

---

## Core / Common

| Contract | Purpose |
|----------|---------|
| **Payment** | Central fee and withdrawal contract. Holds claim fee (basis points), WITHDRAWER/OPERATOR roles; withdraws ERC20 and ETH. Other contracts send fees here; operators set `claimFee` and `isActive`. |
| **LegacyDeployer** | Create2 factory for legacy contracts. Only callable by the three routers (Multisig, Transfer, TransferEOA). Deploys user legacy contracts and optional SafeGuard from deterministic salts; exposes `getNextAddress` for pre-computing addresses. |
| **LegacyRouter** | Base contract (not deployed alone). Holds `BENEFICIARIES_LIMIT` (32) and internal helper for beneficiary count checks; inherited by the three legacy routers. |
| **LegacyFactory** | Base factory logic used by Multisig and Transfer routers to interact with LegacyDeployer (Create2, nonce). |
| **EOALegacyFactory** | Factory logic for EOA-based legacies (no Safe/Guard); used by TransferEOALegacyRouter. |
| **SafeGuard** | Safe (Gnosis) Guard contract. Attached to a Safe wallet; tracks `lastTimestampTxs`, enforces rules on outgoing txs (e.g. inactivity triggers). Used by multisig and transfer legacies that use a Safe. |

---

## Term (Compliance)

| Contract | Purpose |
|----------|---------|
| **EIP712LegacyVerifier** | Terms-of-service verifier. Stores EIP-712 signed “legacy” records (user, legacyAddress, timestamp, signature). Only the three legacy routers can record signatures. Validates timestamp window and replay (signatureUsed). Owner sets router addresses. |

---

## Legacy – Inheritance (Multisig)

| Contract | Purpose |
|----------|---------|
| **MultisigLegacyRouter** | Router for multisig (Safe-based) legacies. Creates legacies with multiple beneficiaries and min required signatures; uses LegacyDeployer + SafeGuard. Integrates EIP712LegacyVerifier (ToS) and PremiumSetting; emits creation/config/beneficiary/trigger updates. |
| **MultisigLegacyContract** | Per-user legacy logic (created via router + LegacyDeployer). Implements multisig distribution and activation rules. |

---

## Legacy – Forwarding (Transfer)

| Contract | Purpose |
|----------|---------|
| **TransferLegacyRouter** _(sunset)_ | Safe-based transfer-legacy router. **Hard-sunset v2026.05.18** — frontend-hidden, source removed, no deploy script; bytecode remains on-chain but is unreachable through the app. Wiring slots downstream pass `address(0)`. Kept here for historical context only. |
| **TransferLegacyContract** | Per-user transfer legacy (created via router). Holds distribution rules and executes transfers on activation. |
| **TransferEOALegacyRouter** | Router for EOA-only transfer legacies (no Safe/Guard). Same distribution model as TransferLegacyRouter but creates plain contracts via EOALegacyFactory. Uses verifier, Payment, Uniswap, WETH. |
| **TransferLegacyEOAContract** | Per-user EOA transfer legacy (created via TransferEOALegacyRouter). |

---

## Legacy – UI / Config

| Contract | Purpose |
|----------|---------|
| **Banner** | Configurable banner content for the app. OPERATOR can set heading, subtitle, and up to 3 features (name, description, CTA, CTA link) per type (LEGACY, TIMELOCK). Enforces max lengths. |

---

## Whitelist

| Contract | Purpose |
|----------|---------|
| **TokenWhiteList** | Access-controlled whitelist of ERC20 token addresses. Admin adds/removes tokens; used by TimeLockRouter to restrict which tokens can be timelocked. `getWhitelist()` returns currently whitelisted tokens. |

---

## Premium – Registry & Settings

| Contract | Purpose |
|----------|---------|
| **PremiumRegistry** | Premium plans and payment. Holds USDT/USDC and **active Chainlink price feeds** (USDT/USD, USDC/USD, ETH/USD via `AggregatorV3Interface.latestRoundData`); defines plans (USD price, duration, active). DEPOSITOR/OPERATOR roles; users subscribe to plans; receives payments and can deposit to Payment contract. **Chainlink price feeds remain in active use here** — only Automation/Functions were retired (see Premium – Notifications below). |
| **PremiumSetting** | Central premium and notification config. Stores per-user: premium expiry, “time prior to activation”; per-legacy: cosigners, beneficiaries, second/third line contacts, watchers, private codes. Links to PremiumRegistry and the legacy routers. **Email notifications now emit-only:** the activation/reminder triggers emit `LegacyEmailNotifyRequested(legacy, creator, layer, notifyType)`, consumed off-chain by the reminder-worker (no on-chain Chainlink mail call). Deprecated Chainlink-era storage slots (e.g. the mail/automation manager wiring) are retained for proxy storage-layout safety but no longer drive any on-chain path. |

---

## Premium – Notifications (off-chain since Phase B, 2026-06-02)

Email scheduling and delivery were moved **off-chain** to a reminder-worker (Mailjet, routed through the existing `email-proxy`). On-chain contracts now only **emit** a notify signal; an off-chain worker resolves recipients (from its own encrypted store) and sends. This retired Chainlink **Automation** (upkeep scheduling) and Chainlink **Functions** (email delivery) from the email path. **Chainlink price feeds are unaffected and remain active in `PremiumRegistry`.**

| Contract | Purpose |
|----------|---------|
| **PremiumReminderView** | Standalone, stateless, read-only contract that re-expresses the old `PremiumAutomation.checkUpkeep` *timing* as `dueReminders(legacy)` / `dueRemindersBatch(legacy[])`. The reminder-worker polls it to decide which notify windows are open (the chain still gates "is a reminder due?"). Constructor takes `(setting, defaultNotifyAhead)`; deployed standalone, no proxy. |
| `PremiumSetting` emit | `LegacyEmailNotifyRequested(legacy, creator, layer, notifyType)` — emitted by the reset/activation triggers; indexed by `computing-subgraph` and consumed by the reminder-worker. Replaces the on-chain Chainlink Functions mail dispatch. |

> **Retired (source deleted from repo; proxies remain on-chain but inert):** `PremiumAutomationManager` + per-user `PremiumAutomation` cronjobs (Chainlink Automation) and `PremiumMailRouter` / `PremiumMailBeforeActivation` / `PremiumMailReadyToActivate` / `PremiumMailActivated` (Chainlink Functions). Their mainnet proxy addresses are kept in `contract-addresses.json` for the record (e.g. `PremiumAutomationManager` `0x03db2dcED84AEcb21F9e399f4dC7B71302537265`). Pending operational teardown: cancel the Automation upkeep + Functions subscription and withdraw remaining LINK (see CHANGELOG).

---

## Timelock

| Contract | Purpose |
|----------|---------|
| **TimeLockRouter** | Entry point for creating and managing timelocks. Supports regular (fixed unlock time), soft (buffer-based), and gift timelocks. Accepts ETH (can swap via Uniswap to a whitelisted token) and ERC20/721/1155; delegates to TimelockERC20, TimelockERC721, TimelockERC1155. Uses TokenWhiteList and Uniswap router. |
| **TimelockERC20** | Holds ERC20 (and ETH-as-ERC20) timelocks. Creates locks with unlock time, owner, recipient, optional “withdraw as ETH” swap; soft locks use buffer time. Only callable by TimeLockRouter. |
| **TimelockERC721** | Same idea for ERC721 tokens; lock by token id; router-only. |
| **TimelockERC1155** | Same for ERC1155 (token id + amount); router-only. |
| **TimelockHelper** | Shared enums and helpers (e.g. LockType, LockStatus) used by the timelock contracts. |

---

## Proxies & Deployment

| Name | Purpose |
|------|---------|
| **DefaultProxyAdmin** | OpenZeppelin proxy admin used by upgradeable contracts (EIP712LegacyVerifier, LegacyDeployer, MultisigLegacyRouter, TransferEOALegacyRouter, Banner, PremiumRegistry, PremiumSetting, TimelockERC20/721/1155, TimeLockRouter). Each proxy deployment may create or reuse one admin. It also still administers the now-inert retired proxies (PremiumAutomationManager, PremiumMail*) and the sunset TransferLegacyRouter, which remain on-chain. `PremiumReminderView` is non-proxied. |

---

## Test / Mock (deployed only on hardhat, localhost, sepolia)

| Contract | Purpose |
|----------|---------|
| **ERC20Token** (as ERC20Token_USDC, ERC20Token_USDT) | Mock ERC20 with mint (owner). Used as test USDC/USDT on testnets and local chains; minted to deployer and optionally added to TokenWhiteList and used by PremiumRegistry. |

---

## Dependency Overview

- **Legacy flows:** LegacyDeployer ← MultisigLegacyRouter, TransferLegacyRouter, TransferEOALegacyRouter. All three routers use EIP712LegacyVerifier and (for premium) PremiumSetting.
- **Premium:** PremiumRegistry (plans, payment, **active Chainlink price feeds**) ↔ PremiumSetting (user/legacy config; emits `LegacyEmailNotifyRequested`). Email scheduling/delivery is **off-chain** (reminder-worker → email-proxy → Mailjet); PremiumReminderView is the on-chain "is a reminder due?" timing anchor the worker polls. The former Chainlink Automation/Mail consumers are retired.
- **Timelock:** TimeLockRouter → TimelockERC20/721/1155; TimeLockRouter uses TokenWhiteList and Uniswap router.
- **Payment:** Receives fees from legacy/timelock flows; PremiumRegistry can deposit there; WITHDRAWER withdraws ERC20/ETH.

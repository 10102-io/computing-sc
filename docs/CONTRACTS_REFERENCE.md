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
| **TransferLegacyRouter** | Router for transfer legacies (Safe-based). Creates legacies with defined distributions (who gets what); uses LegacyDeployer + SafeGuard. Ties in verifier, Payment, Uniswap (e.g. swap), WETH; emits creation/config/distribution/trigger updates. |
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
| **PremiumRegistry** | Premium plans and payment. Holds USDT/USDC and Chainlink price feeds (USD, ETH); defines plans (USD price, duration, active). DEPOSITOR/OPERATOR roles; users subscribe to plans; receives payments and can deposit to Payment contract. |
| **PremiumSetting** | Central premium and notification config. Stores per-user: premium expiry, name/email, “time prior to activation”; per-legacy: cosigners, beneficiaries, second/third line contacts, watchers, private codes. Links to PremiumRegistry, the three legacy routers, PremiumAutomationManager, and PremiumSendMail. |

---

## Premium – Automation & Mail

| Contract | Purpose |
|----------|---------|
| **PremiumAutomationManager** | Chainlink Automation (upkeeps) for premium users. Creates per-user “cronjob” contracts; registers upkeeps with a registrar; adds legacies to upkeeps for reminder/activation checks. Tracks nonces and notifies via PremiumSendMail. |
| **PremiumMailRouter** | Dispatches which mail contract to use. Called by PremiumSetting and PremiumAutomationManager; forwards to MailBeforeActivation, MailReadyToActivate, or MailActivated depending on context. |
| **PremiumMailBeforeActivation** | Sends “before activation” emails (e.g. reminder that a legacy is about to activate). |
| **PremiumMailReadyToActivate** | Sends “ready to activate” emails. |
| **PremiumMailActivated** | Sends “activated” emails (e.g. legacy has activated). |
| **MockPremiumSendMail** | Mock mail sender for tests/dev (deployed as PremiumSendMail in some envs). |

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
| **DefaultProxyAdmin** | OpenZeppelin proxy admin used by upgradeable contracts (EIP712LegacyVerifier, LegacyDeployer, MultisigLegacyRouter, TransferLegacyRouter, TransferEOALegacyRouter, Banner, PremiumRegistry, PremiumSetting, PremiumAutomationManager, PremiumMail*, TimelockERC20/721/1155, TimeLockRouter). Each proxy deployment may create or reuse one admin. |

---

## Test / Mock (deployed only on hardhat, localhost, sepolia)

| Contract | Purpose |
|----------|---------|
| **ERC20Token** (as ERC20Token_USDC, ERC20Token_USDT) | Mock ERC20 with mint (owner). Used as test USDC/USDT on testnets and local chains; minted to deployer and optionally added to TokenWhiteList and used by PremiumRegistry. |

---

## Dependency Overview

- **Legacy flows:** LegacyDeployer ← MultisigLegacyRouter, TransferLegacyRouter, TransferEOALegacyRouter. All three routers use EIP712LegacyVerifier and (for premium) PremiumSetting.
- **Premium:** PremiumRegistry (plans, payment) ↔ PremiumSetting (user/legacy config) ↔ PremiumAutomationManager (upkeeps) ↔ PremiumMailRouter → Mail* contracts.
- **Timelock:** TimeLockRouter → TimelockERC20/721/1155; TimeLockRouter uses TokenWhiteList and Uniswap router.
- **Payment:** Receives fees from legacy/timelock flows; PremiumRegistry can deposit there; WITHDRAWER withdraws ERC20/ETH.

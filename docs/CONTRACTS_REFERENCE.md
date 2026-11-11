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
| **TransferEOALegacyRouter** | Router for EOA-only transfer legacies (no Safe/Guard). Same distribution model as TransferLegacyRouter but creates plain contracts via EOALegacyFactory. Uses verifier, Payment, Uniswap, WETH. Since 2026-11-07 its rotation levers (`setLegacyImplementation`, `setPullVault`, a non-zero `setActivityAttestor`) answer only to the UpgradeTimelock; the code admin is the governance Safe, which keeps the instant `setCreatePaused` and the attestor kill switch (`scripts/safe-call.ts`). |
| **TransferLegacyEOAContract** (`TransferEOALegacy`) | Per-user EOA transfer legacy, an EIP-1167 clone of one implementation per network (created via TransferEOALegacyRouter). Each clone pins its implementation and pull vault forever. Mainnet implementation since 2026-11-07: `0x2E2dE6475fcBE77E7930499981850d37b237924C` (2026-11 train wave A: SafeERC20 payouts, claim fee capped at 50 bps, zero-minimum and co-recipient unswap claims refused). |
| **TransferEOALegacyV3** | Legacy v3, `contracts/forwarding/TransferLegacyEOAContractV3.sol` (2026-11 train wave B): NFTs from NftCollectionWhiteList, each to a named beneficiary; per-share backup lines and an executor (both Premium, off by default). Inherits the wave A clone; no router change. Sepolia: `0x779cD63a41A7164A98C2B2EF5029CC6561FC5cD6` is what the router creates since 2026-11-10 (the first build `0x057cc6baf9b8d5Ee11246C10F602b26Bb5fc3993`, 2026-11-06, keeps its clones). Mainnet: `0xF9B6241Ab7513181C9Ed4F0920E0B008fB9264e9`, deployed 2026-11-11 and scheduled in the timelock (executable from 2026-11-13 20:37 UTC); the router creates it once that batch executes. Not independently audited: the founder moved mainnet ahead of the external review (`docs/security/wave-b-audit-scope.md`), risk accepted. |

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
| **NftCollectionWhiteList** | Admin-managed list of NFT collections with their kind (ERC-721 or ERC-1155) that legacy v3 owners may name (`getCollections()`). Admin: the deployer key, with the governance Safe as co-admin (`add-safe-admin.ts`). Its address is an immutable of the v3 implementation; the list is never read at claim, so a delisting cannot stop an heir. Sepolia `0x0d9B2E96B225f5329841605363E02f35fb50f73B`; mainnet `0xF33e887c6BE3bA8Fb583E14164a9e74FD56c1623` (2026-11-11, empty until collections are vetted), recorded under `train202611` until the wave B batch executes. |

---

## Premium – Registry & Settings

| Contract | Purpose |
|----------|---------|
| **PremiumRegistry** | Premium plans and payment. Holds USDT/USDC and **active Chainlink price feeds** (USDT/USD, USDC/USD, ETH/USD via `AggregatorV3Interface.latestRoundData`); defines plans (USD price, duration, active). DEPOSITOR/OPERATOR roles; users subscribe to plans; receives payments and can deposit to Payment contract. Since 2026-11-07: coupon codes (`setCoupon`, at most 50% off) and registered referrer shares (`setReferrer`, at most 30%, paid from the purchase) through `subscribeWith*(plan, code, referrer)`, recorded by `PlanSubscribedWithCode`; none configured on mainnet (no `CouponSet` or `ReferrerSet` event, read 2026-11-09). **Chainlink price feeds remain in active use here** — only Automation/Functions were retired (see Premium – Notifications below). |
| **PremiumSetting** | Central premium and notification config. Stores per-user: premium expiry, “time prior to activation”; per-legacy: cosigners, beneficiaries, second/third line contacts, watchers, private codes. Links to PremiumRegistry and the legacy routers. **Email notifications now emit-only:** the activation/reminder triggers emit `LegacyEmailNotifyRequested(legacy, creator, layer, notifyType)`, consumed off-chain by the reminder-worker (no on-chain Chainlink mail call). Deprecated Chainlink-era storage slots (e.g. the mail/automation manager wiring) are retained for proxy storage-layout safety but no longer drive any on-chain path. |

---

## Premium – Notifications (off-chain since Phase B, 2026-06-02)

Email scheduling and delivery were moved **off-chain** to a reminder-worker (Mailjet, routed through the existing `email-proxy`). On-chain contracts now only **emit** a notify signal; an off-chain worker resolves recipients (from its own encrypted store) and sends. This retired Chainlink **Automation** (upkeep scheduling) and Chainlink **Functions** (email delivery) from the email path. **Chainlink price feeds are unaffected and remain active in `PremiumRegistry`.**

| Contract | Purpose |
|----------|---------|
| **PremiumReminderView** | Standalone, stateless, read-only contract that re-expresses the old `PremiumAutomation.checkUpkeep` *timing* as `dueReminders(legacy)` / `dueRemindersBatch(legacy[])`. The reminder-worker polls it to decide which notify windows are open (the chain still gates "is a reminder due?"). Constructor takes `(setting, defaultNotifyAhead)`; deployed standalone, no proxy. |
| `PremiumSetting` emit | `LegacyEmailNotifyRequested(legacy, creator, layer, notifyType)` — emitted by the reset/activation triggers; indexed by `computing-subgraph` and consumed by the reminder-worker. Replaces the on-chain Chainlink Functions mail dispatch. |

> **Retired (source deleted from repo; proxies remain on-chain but inert):** `PremiumAutomationManager` + per-user `PremiumAutomation` cronjobs (Chainlink Automation) and `PremiumMailRouter` / `PremiumMailBeforeActivation` / `PremiumMailReadyToActivate` / `PremiumMailActivated` (Chainlink Functions). Their mainnet proxy addresses are kept in `contract-addresses.json` for the record (e.g. `PremiumAutomationManager` `0x03db2dcED84AEcb21F9e399f4dC7B71302537265`). Operational teardown done, verified on chain 2026-11-09: the manager's three per-user Automation upkeeps (KeeperRegistry 2.1 `0x6593…58fD`) were cancelled on 2026-06-02 and hold 0 LINK, the manager holds 0 LINK, and Functions subscription 141 (the mail contracts' subscription on the Functions router `0x65Dc…4bd6`) no longer exists.

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

## Governance and protection (standalone, not upgradeable)

| Contract | Purpose |
|----------|---------|
| **UpgradeTimelock** | OpenZeppelin TimelockController (48h on mainnet, 300s on Sepolia). Owns `DefaultProxyAdmin` and the three timelock vaults, so every implementation swap and vault setting waits in public; since 2026-11-07 it is also the only caller of the EOA router's rotation levers and of LegacyPullVaultV2's `allowImplementation`. The governance Safe is PROPOSER (the maintainer key too, until the Safe is 2-of-3), the guardian hardware key the only CANCELLER. Runbook: `docs/plans/upgrade-timelock.md`. |
| **QuantumRecoveryRegistry** | Append-only registry of post-quantum recovery commitments (hash digests with a scheme id and a context address), timestamped on chain. No admin. Scheme 5 ("plain hash preimage") carries two preimage formats: an account recovery commitment from the app's Home card is `keccak256(secret)` with the account's legacy (or zero) as context; a ShieldVault veto digest is `keccak256(abi.encode(keccak256("10102.ShieldVault.veto.v2"), chainId, vault, owner, secret, recoveryTo))` with the vault as context (ShieldVault v1: tag `…veto.v1`, no `owner`). ShieldVault reads its owner's scheme-5 commitments as veto digests; a reader tells the two apart by the context address, as the app's `useQuantumReadiness` does (checklist audit QR-L). |
| **LegacyPullVault** (v1) | The verified Permit2 spender for EOA transfer legacies created before 2026-11-07 (mainnet `0x95F0981026C7e804fD6ba8bE738cA7c380C7f978`, `LegacyPullVaultV1` in `contract-addresses.json`): creators' permits name this vault, while the authority to pull stays bound to each owner's own legacy clone. Their clones pin it forever. Spec: `docs/plans/legacy-pull-vault.md`. |
| **LegacyPullVaultV2** | The Permit2 spender for legacies created since 2026-11-07 (mainnet `0xC6640962618f9D729032487EC5DEf226BF6F43E3`, `LegacyPullVault` in `contract-addresses.json`). Same guarantees as v1 (router-only `bind`, pulls only by the bound legacy, no upgrade, no admin over bindings or funds), plus `unbind()` for an owner whose bound legacy is no longer live (checklist audit M-1), an add-only codehash allowlist of clone implementations that only the UpgradeTimelock extends, and NFT rails (`pullERC721`, `pullERC1155`) for legacy v3. Design: `docs/plans/train-2026-11.md`. |
| **ShieldVault** | Protected holdings: a supported token behind a 7/30/90-day exit delay, an optional fallback to beneficiaries after a silence period, and a veto that moves everything to a pre-committed recovery wallet by revealing a hash secret. Owned by the governance Safe, whose only powers are token curation, pausing new deposits, and the fee for holdings opened later (at most 50 bps, fixed into each holding at opening, never on a veto) and its recipient; exits are never pausable. Fee 0 since the Safe's `setFee(0)` on 2026-11-09. Spec and threat model: `docs/plans/shield-vault.md`. |
| **ShieldVaultV3** | ShieldVault with the fee taken only on a release to the named people after silence, never on the owner's own exits; a payout the token reports as failed owed only for what stayed in the vault; the token contract refused as a payee. Same ABI and signing domain as v2. Sepolia `0xf62c6Ce336D1b4f14Bd4BA57cc207CFCEFe98C82` (2026-11-10), mainnet `0x1610DC8D25475959D5ba9395c4CE02456B51EB59` (2026-11-11); owner and fee recipient the governance Safe, release fee 25 bps. Not independently audited. `docs/plans/shield-vault.md`, "v3". |

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

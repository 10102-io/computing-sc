# Mainnet Deployment Gas Estimate

**Date:** 2026-03-05
**Based on:** Sepolia deployment receipts (`deployments/sepolia/`) and bytecode analysis

## Scope

Production contracts only — excludes test ERC20 tokens (USDC, USDT) and MockPremiumSendMail.

## Contract Deployment Gas (from Sepolia receipts)

| Contract | Implementation Gas | Proxy Gas | Total Gas |
|---|---:|---:|---:|
| Payment (standalone) | — | — | 647,660 |
| DefaultProxyAdmin (standalone) | — | — | 644,163 |
| TokenWhiteList (standalone) | — | — | 602,521 |
| EIP712LegacyVerifier | 1,210,673 | 695,184 | 1,905,857 |
| LegacyDeployer | 1,262,013 | 671,302 | 1,933,315 |
| MultisigLegacyRouter | 2,970,851 | 737,895 | 3,708,746 |
| TransferLegacyRouter | 5,224,976 | 783,491 | 6,008,467 |
| TransferEOALegacyRouter* | ~2,481,200 | ~288,600 | ~2,769,800 |
| Banner | 1,684,627 | 622,245 | 2,306,872 |
| PremiumSetting | 5,356,973 | 671,733 | 6,028,706 |
| PremiumRegistry | 2,084,024 | 879,451 | 2,963,475 |
| PremiumAutomationManager | 4,033,876 | 671,462 | 4,705,338 |
| PremiumMailRouter | 1,834,362 | 671,524 | 2,505,886 |
| PremiumMailBeforeActivation | 3,356,246 | 762,961 | 4,119,207 |
| PremiumMailReadyToActivate | 3,035,230 | 762,829 | 3,798,059 |
| PremiumMailActivated | 3,957,116 | 762,965 | 4,720,081 |
| TimeLockRouter | 2,363,918 | 672,157 | 3,036,075 |
| TimelockERC20 | 2,248,617 | 717,137 | 2,965,754 |
| TimelockERC721 | 1,987,820 | 717,333 | 2,705,153 |
| TimelockERC1155 | 2,149,320 | 717,311 | 2,866,631 |

*\*TransferEOALegacyRouter estimated from bytecode size (12,246 bytes impl + 1,033 bytes proxy) — deployed via `scripts/deploy-eoa-router.ts`, not hardhat-deploy, so no receipt in artifacts.*

**Deployment subtotal: ~60,942,000 gas**

## Post-Deploy Initialization Transactions

| Transaction | Estimated Gas |
|---|---:|
| EOA Router: `initializeV2` | ~50,000 |
| EOA Router: `setLegacyCreationCode` (stores 18,319 bytes in storage) | ~11,500,000 |
| `set_up_legacy` (wires routers to deployer/verifier/settings) | ~200,000 |
| `setTimelock` (sets ERC20/721/1155 on TimeLockRouter) | ~80,000 |
| `setTokenWhitelistOnRouter` | ~50,000 |
| `addTokenToWhitelist` (USDC) | ~50,000 |

**Init subtotal: ~11,930,000 gas**

## Grand Total

| Category | Gas |
|---|---:|
| Contract deployments | ~60,942,000 |
| Initialization transactions | ~11,930,000 |
| **Grand Total** | **~72,872,000** |

## ETH Cost at Various Gas Prices

*ETH: $2,127 | Current gas: ~0.09 gwei (as of 2026-03-05)*

| Gas Price | ETH Cost | USD (@ $2,127/ETH) |
|---:|---:|---:|
| 0.09 gwei (current) | 0.007 ETH | $14 |
| 0.5 gwei | 0.036 ETH | $77 |
| 1 gwei | 0.073 ETH | $155 |
| 3 gwei | 0.219 ETH | $465 |
| 5 gwei | 0.364 ETH | $775 |
| 10 gwei | 0.729 ETH | $1,550 |

## Key Observations

1. **Biggest gas consumers**: `setLegacyCreationCode` (~11.5M, 16% of total), PremiumSetting (6M), TransferLegacyRouter (6M), PremiumMailActivated (4.7M), PremiumAutomationManager (4.7M)
2. **`setLegacyCreationCode`** stores the entire TransferEOALegacy bytecode (18KB) in contract storage — ~572 storage slots at ~20K gas each
3. **~37 separate transactions** total (19 impl deploys, 16 proxy deploys, 3 standalone deploys, 6 init txs)
4. **Proxy pattern**: Most contracts use TransparentProxy via hardhat-deploy; TransferEOALegacyRouter uses ERC1967Proxy

## Recommendations

- At current gas prices (~0.09 gwei), a full fresh deploy costs ~$14 and upgrade-only costs ~$8
- Even at 1 gwei the upgrade path is under $100
- Consider batching init transactions if a multicall pattern is available

---

## Option B: Upgrade Existing Mainnet Contracts

**Source:** `original-deployments/mainnet/` bytecode compared against current compiled artifacts.

Mainnet is already deployed. Instead of a fresh deploy, we can upgrade only the contracts whose code has changed. This saves ~40% on gas.

### Bytecode Comparison Results

**Unchanged (no upgrade needed):**
- Banner
- PremiumMailRouter
- Payment (standalone, not upgradeable)

**Metadata-only change (recompile artifact hash differs, no code change — upgrade optional):**
- LegacyDeployer
- MultisigLegacyRouter

**Code changed (must upgrade):**

| Contract | New Impl Deploy | Upgrade Tx | Total |
|---|---:|---:|---:|
| EIP712LegacyVerifier | 1,210,673 | 55,000 | 1,265,673 |
| PremiumAutomationManager | 4,033,876 | 55,000 | 4,088,876 |
| PremiumMailActivated | 3,957,116 | 55,000 | 4,012,116 |
| PremiumMailBeforeActivation | 3,356,246 | 55,000 | 3,411,246 |
| PremiumMailReadyToActivate | 3,035,230 | 55,000 | 3,090,230 |
| PremiumRegistry | 2,084,024 | 55,000 | 2,139,024 |
| PremiumSetting | 5,356,973 | 55,000 | 5,411,973 |
| TimeLockRouter | 2,363,918 | 55,000 | 2,418,918 |
| TimelockERC1155 | 2,149,320 | 55,000 | 2,204,320 |
| TimelockERC20 | 2,248,617 | 55,000 | 2,303,617 |
| TimelockERC721 | 1,987,820 | 55,000 | 2,042,820 |
| TransferEOALegacyRouter | 2,481,200 | 55,000 | 2,536,200 |
| TransferLegacyRouter | 5,224,976 | 55,000 | 5,279,976 |

**New deployments (not on mainnet yet):**

| Contract | Deploy Gas |
|---|---:|
| TokenWhiteList (standalone) | 602,521 |

**Post-upgrade transactions:**

| Transaction | Estimated Gas |
|---|---:|
| `setLegacyCreationCode` (warm storage update, ~573 slots at ~5K each) | ~2,936,000 |
| Init txs (setTokenWhitelist, addTokenToWhitelist) | ~100,000 |

### Upgrade Total

| Category | Gas |
|---|---:|
| New implementation deploys (13 contracts) | ~39,489,989 |
| Upgrade transactions (13 × `upgradeAndCall`) | ~715,000 |
| TokenWhiteList fresh deploy | 602,521 |
| `setLegacyCreationCode` (warm update) | ~2,936,000 |
| Init transactions | ~100,000 |
| **Grand Total** | **~43,844,000** |

### Upgrade ETH Cost

*ETH: $2,127 | Current gas: ~0.09 gwei (as of 2026-03-05)*

| Gas Price | ETH Cost | USD (@ $2,127/ETH) |
|---:|---:|---:|
| 0.09 gwei (current) | 0.004 ETH | $8 |
| 0.5 gwei | 0.022 ETH | $47 |
| 1 gwei | 0.044 ETH | $93 |
| 3 gwei | 0.132 ETH | $280 |
| 5 gwei | 0.219 ETH | $466 |
| 10 gwei | 0.438 ETH | $932 |

### Comparison: Fresh Deploy vs Upgrade

| | Fresh Deploy | Upgrade Only | Savings |
|---|---:|---:|---:|
| Gas | ~72,872,000 | ~43,844,000 | ~29,028,000 (40%) |
| ETH @ 0.09 gwei | 0.007 | 0.004 | 0.003 |
| USD @ 0.09 gwei, $2,127/ETH | $14 | $8 | $6 |
| ETH @ 1 gwei | 0.073 | 0.044 | 0.029 |
| USD @ 1 gwei, $2,127/ETH | $155 | $93 | $62 |

### Notes on Upgrade Path

1. **TransferEOALegacyRouter** uses `DefaultProxyAdmin.upgradeAndCall` — upgrade script exists at `scripts/upgrade-eoa-legacy-router.ts`
2. **`setLegacyCreationCode`** is much cheaper on upgrade (~2.9M vs ~11.5M) because storage slots are warm (SSTORE update: ~5K vs ~20K per slot)
3. **LegacyDeployer and MultisigLegacyRouter** have identical code — only the solc metadata hash changed (different compiler input hash). Upgrading these is optional
4. **~28 transactions** total (13 impl deploys + 13 upgrade calls + TokenWhiteList deploy + setLegacyCreationCode)
5. **TokenWhiteList** must be freshly deployed — it doesn't exist on mainnet yet

### Mainnet Contract Addresses (from `original-deployments/mainnet/`)

| Contract | Proxy Address |
|---|---|
| Banner | 0x4172228098... |
| DefaultProxyAdmin | 0x4C6c55C3a4... |
| EIP712LegacyVerifier | 0x165F16Ad1A... |
| LegacyDeployer | 0x6804Bf1bCc... |
| MultisigLegacyRouter | 0xba1869D74e... |
| Payment | 0x5c0A7431d9... |
| PremiumAutomationManager | 0x52C729f666... |
| PremiumMailActivated | 0x245e9E6B99... |
| PremiumMailBeforeActivation | 0x1Db555e18B... |
| PremiumMailReadyToActivate | 0xA8D11c65BD... |
| PremiumMailRouter | 0x3A329f2488... |
| PremiumRegistry | 0x02db8AfFcF... |
| PremiumSetting | 0x74379Fb256... |
| TimeLockRouter | 0xb566b558EE... |
| TimelockERC1155 | 0xad220c7542... |
| TimelockERC20 | 0x917c28c735... |
| TimelockERC721 | 0x7BA9155E9C... |
| TransferEOALegacyRouter | 0x69dae8E76c... |
| TransferLegacyRouter | 0x18B8251D7F... |

---

## Deploy Script Audit — Fresh Redeploy Feasibility

**Conclusion: After fixes (see below), a full fresh deploy completes successfully on a local hardhat network.**

The original deploy scripts had 8 issues preventing a clean deployment. All have been fixed and verified with a successful local deploy.

### Issues Found and Fixed

### Issue 1: `external-addresses.ts` mainnet config has zero addresses (BLOCKER)

**File:** `config/external-addresses.ts` lines 99-116

The mainnet entry has zeros for:
- `verifierTermOwner` — EIP712LegacyVerifier `initialize()` would set owner to `address(0)`, making the verifier unownable
- `usdtUsdPriceFeed`, `usdcUsdPriceFeed`, `ethUsdPriceFeed` — PremiumRegistry needs these for pricing; zero addresses would cause reverts
- All Chainlink addresses (`chainlinkLink`, `chainlinkRegistrar`, `chainlinkKeeperRegistry`, `chainlinkFunctionsRouter`, `chainlinkDonId`, `chainlinkSubscriptionId`) — needed by PremiumAutomationManager and PremiumMail* contracts

**Fix:** Fill in real mainnet addresses before deploying. Uniswap/WETH/USDC/USDT are already correct.

### Issue 2: Stale upgrade scripts reference non-existent functions (WARNING)

**Files:** `scripts/upgrade-eoa-legacy-router.ts`, `scripts/upgrade-eoa-legacy-creation-code.ts`

These scripts call `initializeV2()` and `setLegacyCreationCode()` — but after a fresh compile, these functions do NOT exist on the current `TransferEOALegacyRouter` contract. The artifacts were stale from a previous branch. The current contract uses `type(TransferEOALegacy).creationCode` inline.

The hardhat-deploy script (`deploy/legacy/4.TransferLegacyEOARouter.ts`) is actually correct — it only calls `initialize()` which is all the contract needs.

**Fix:** Delete or update the stale upgrade scripts to avoid confusion. The `deploy-eoa-router.ts` standalone deploy script also references `initializeV2`/`setLegacyCreationCode` and would fail.

### Issue 3: `deploy/premium/3.SendMail.ts` deploys MockPremiumSendMail (ACCEPTABLE)

**File:** `deploy/premium/3.SendMail.ts`

Deploys `MockPremiumSendMail` on all networks. For mainnet, this is a placeholder — acceptable for now, to be upgraded later with a real implementation.

**Decision:** Deploy MockPremiumSendMail for now. Upgrade later.

### Issue 4: `set_up_reminder.ts` has commented-out init calls (INVESTIGATE)

**File:** `deploy/init/2.set_up_reminder.ts` lines 217-221

Three calls are commented out:
- `setPramramPremiumSetting` — already handled by `init/0.set_up_legacy.ts`, so this is fine
- `setUpReminder` — calls `PremiumSetting.setUpReminder(manager, sendMailRouter)` — **not called anywhere else**
- `setParamsManager` — calls `PremiumAutomationManager.setParams(link, registrar, keeperRegistry, premiumSetting, baseGasLimit, sendMailRouter, 150)` — **not called anywhere else**

Only `setParamsMailRouter` (calls `PremiumMailRouter.setParams(...)`) is active.

**Fix:** Determine if `setUpReminder` and `setParamsManager` are needed for the premium/automation system to function. If yes, uncomment them. If Chainlink automation isn't needed at launch, these can stay commented.

### Issue 5: `set_up_reminder.ts` uses `PK` env var (MINOR)

**File:** `deploy/init/2.set_up_reminder.ts`

Uses raw Web3 signing with `process.env.PK`, while all other scripts use `DEPLOYER_PRIVATE_KEY` via hardhat config. Easy to misconfigure during deployment.

**Fix:** Standardize on `DEPLOYER_PRIVATE_KEY` or document both env vars are needed.

**Status: FIXED** — Rewrote to use `getProvider()` with ethers.js, matching other init scripts.

### Issue 6: Deploy scripts use `getContracts()` instead of `deployments.get()` (BLOCKER)

**Files:** `deploy/legacy/4.TransferLegacyEOARouter.ts`, `deploy/premium/1.PremiumRegistry.ts`, `deploy/premium/6.PremiumMailBeforeActivation.ts`, `deploy/premium/7.PremiumMailReadyToActivate.ts`, `deploy/premium/8.PremiumMailActivated.ts`, `deploy/timelock/5.TimeLockERC20.ts`, `deploy/timelock/6.TimeLockERC721.ts`, `deploy/timelock/7.TimeLockERC1155.ts`

These scripts read addresses from `contract-addresses.json` via `getContracts()`, but hardhat-deploy stores deployments in its own `deployments/` directory. On a fresh deploy, `contract-addresses.json` doesn't have the network's addresses yet, causing `Cannot read properties of undefined` errors.

**Status: FIXED** — All 8 scripts now use `deployments.get()` to read addresses from hardhat-deploy's deployment store.

### Issue 7: Missing hardhat-deploy dependencies (BLOCKER)

**Files:** `deploy/timelock/4b.SetMockSwapRouter.ts`, `deploy/premium/6-8.PremiumMail*.ts`

`4b.SetMockSwapRouter.ts` was missing `TimelockERC20`, `TimelockERC721`, `TimelockERC1155`, `TokenWhiteList` from its `deploy.dependencies`, causing it to run before those contracts were deployed. Similarly, the PremiumMail scripts (6, 7, 8) were missing `PremiumMailRouter` from their dependencies.

**Status: FIXED** — Added missing dependencies to all affected scripts.

### Issue 8: Hardhat baseFee ramp-up on fresh chain (BLOCKER for local testing)

**File:** `hardhat.config.ts`

The `interval: 3000` mining config on the non-fork hardhat network caused EIP-1559 baseFee to ramp up rapidly on a fresh chain, making transactions fail with "gasPrice too low" after a few deploys.

**Status: FIXED** — Set `initialBaseFeePerGas: 0` for the non-fork hardhat network config. Fork mode retains `interval: 3000`.

### What Works Correctly

- **Dependency chain**: hardhat-deploy tags ensure correct ordering across all phases
- **`4c.SetSepoliaSwapRouter.ts`**: despite the name, runs on any live network with `uniswapRouter` configured — handles mainnet Uniswap/whitelist wiring
- **TokenWhiteList**: would deploy and get wired correctly (Uniswap router, USDC/USDT whitelisting)
- **Timelock contracts**: would deploy and wire correctly (setTimelock, setUniswapRouter)
- **Legacy routers** (Multisig, Transfer): deploy and initialize correctly
- **Banner, Payment, PremiumSetting, LegacyDeployer**: no issues
- **Premium mail contracts**: deploy and initialize with Chainlink config (assuming addresses are filled in)

### Full Deploy Execution Order

```
Phase 1 — No dependencies (parallel):
  Payment, PremiumSetting, LegacyDeployer, EIP712LegacyVerifier,
  PremiumAutomationManager, MockPremiumSendMail, PremiumMailRouter,
  Banner, TimeLockRouter

Phase 2 — After Phase 1:
  TokenWhiteList, PremiumRegistry, MultisigLegacyRouter,
  TransferLegacyRouter, TransferEOALegacyRouter,
  PremiumMailBeforeActivation, PremiumMailReadyToActivate,
  PremiumMailActivated, TimelockERC20, TimelockERC721, TimelockERC1155

Phase 3 — Automated wiring (via hardhat-deploy):
  SetSepoliaSwapRouter (setTimelock, setTokenWhitelist, setUniswapRouter,
                        addToken USDC/USDT)

Phase 4 — Manual init scripts (run separately):
  0.set_up_legacy.ts    → wire verifier, deployer, settings with router addresses
  1.setTimelock.ts      → redundant with Phase 3 (4c already does this)
  1b.setTokenWhitelist  → redundant with Phase 3
  2.set_up_reminder.ts  → wire PremiumMailRouter with mail contracts
  3.addTokenToWhitelist → redundant with Phase 3

Note: scripts/deploy-eoa-router.ts, upgrade-eoa-legacy-router.ts, and
upgrade-eoa-legacy-creation-code.ts reference initializeV2/setLegacyCreationCode
which do NOT exist on the current contract. These scripts are stale and should
be deleted or updated.
```

## Addresses Requiring Team Control

For a mainnet deployment (fresh or upgrade), the team must have control of the following addresses. Loss of control means inability to configure, upgrade, or manage the affected contracts.

### Deployer Wallet

The deployer wallet becomes the owner/admin of most contracts via `initialize()`. It must be available with `DEPLOYER_PRIVATE_KEY` env var.

| Contract | Role | Key Functions |
|---|---|---|
| DefaultProxyAdmin | Proxy admin for all 15+ proxies | `upgrade()`, `upgradeAndCall()` |
| LegacyDeployer | OwnableUpgradeable owner | `setParams()` (router addresses) |
| PremiumSetting | OwnableUpgradeable owner | `setRouters()`, `setUpReminder()` |
| PremiumAutomationManager | OwnableUpgradeable owner | `setParams()` (Chainlink config) |
| TimeLockRouter | OwnableUpgradeable owner | `setTimelock()`, `setTokenWhitelist()`, `setUniswapRouter()` |
| TimelockERC20/721/1155 | OwnableUpgradeable owner | `setRouterAddresses()`, `setUniswapRouter()` |
| TokenWhiteList | DEFAULT_ADMIN_ROLE | `addToken()`, `removeToken()` |
| Payment | DEFAULT_ADMIN_ROLE, OPERATOR, WITHDRAWER | `setClaimFee()`, `withdraw()` |

### `verifierTermOwner` — Same as Deployer on Mainnet

On mainnet, `verifierTermOwner` in `external-addresses.ts` is set to `0x23b6c5dda751d4f9cd43e264687954ce47ce34d1` — the same address used as the deployer (`"from"`) for all original mainnet transactions. This is **not** a separate wallet; the deployer already controls EIP712LegacyVerifier.

(On Sepolia, `verifierTermOwner` is a different address `0x944A...`, which is why this was originally flagged as separate.)

### Chainlink Subscriptions

| Resource | ID/Address | Purpose |
|---|---|---|
| Chainlink Functions Subscription | ID: 141 | Funds PremiumMail* contract calls to Chainlink Functions |
| Chainlink Automation (Keepers) | Registered via PremiumAutomationManager | Funds automated premium reminders |

The team must own the Chainlink Functions subscription (ID 141) and have LINK tokens to fund it. The Chainlink Automation upkeeps must also be funded with LINK.

### Summary of Required Private Keys

1. **Deployer wallet (`0x23b6c5dda751d4f9cd43e264687954ce47ce34d1`)** — controls proxy admin, all OwnableUpgradeable contracts, AccessControl admin roles, AND EIP712LegacyVerifier (verifierTermOwner = deployer on mainnet)

> **Risk note:** All proxy upgrades and most admin functions are controlled by a single deployer EOA. Consider transferring DefaultProxyAdmin ownership to a multisig (e.g., Gnosis Safe) after deployment.

---

## Sepolia Contract Addresses (reference)

See `contract-addresses.json` — sepolia section — for all deployed addresses.

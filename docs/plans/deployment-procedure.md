# Deployment Procedure

## Prerequisites

Before deploying to any live network:

1. Set environment variables: `DEPLOYER_PRIVATE_KEY`, `RPC` / `SEPOLIA_RPC_URL`, `API_KEY_ETHERSCAN`
2. Populate `config/external-addresses.ts` for the target network (Chainlink, price feeds, Uniswap, WETH, tokens)
3. Create & fund a Chainlink Functions subscription, set `chainlinkSubscriptionId`

---

## Phase 1 — `hardhat deploy` (automated)

Hardhat-deploy resolves the dependency graph and deploys in order.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PHASE 1: hardhat deploy                          │
│                                                                     │
│  ┌─────────────────────── No Dependencies ───────────────────────┐  │
│  │                                                               │  │
│  │  Payment          PremiumSetting       TimeLockRouter         │  │
│  │  Banner           PremiumAutomationMgr PremiumMailRouter      │  │
│  │  EIP712Verifier   LegacyDeployer                             │  │
│  │  TestERC20 (local/sepolia only)                               │  │
│  │                                                               │  │
│  └──────────┬──────────────┬──────────────┬──────────────────────┘  │
│             │              │              │                          │
│             ▼              ▼              ▼                          │
│  ┌──────────────┐ ┌──────────────┐ ┌─────────────────────────────┐  │
│  │ TokenWhiteList│ │ TimelockERC20│ │ PremiumMailBeforeActivation │  │
│  │ (← TestERC20)│ │ TimelockERC721 │ PremiumMailReadyToActivate  │  │
│  │              │ │ TimelockERC1155 │ PremiumMailActivated        │  │
│  │              │ │ (← TimeLock  │ │ (← PremiumMailRouter)       │  │
│  │              │ │    Router)   │ │                             │  │
│  └──────┬───────┘ └──────┬───────┘ └─────────────────────────────┘  │
│         │                │                                          │
│         │                │                                          │
│  ┌──────┴────────────────┴──────────────────────────────────────┐   │
│  │              Contracts needing multiple deps                 │   │
│  │                                                              │   │
│  │  PremiumRegistry        ← PremiumSetting + Payment           │   │
│  │  MultisigLegacyRouter   ← PremiumSetting + LegacyDeployer   │   │
│  │                           + EIP712Verifier                   │   │
│  │  TransferLegacyRouter   ← LegacyDeployer + PremiumSetting   │   │
│  │                           + EIP712Verifier + Payment         │   │
│  │  TransferEOALegacyRouter← (same as TransferLegacyRouter)    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Swap Router Wiring (conditional)                │   │
│  │                                                              │   │
│  │  LOCAL:  SetMockSwapRouter                                   │   │
│  │          → deploy MockWETH + MockUniswapV2Router             │   │
│  │          → TimeLockRouter.setTimelock(ERC20, 721, 1155)      │   │
│  │          → TimeLockRouter.setTokenWhitelist(...)              │   │
│  │          → TimeLockRouter.setUniswapRouter(mock)              │   │
│  │                                                              │   │
│  │  LIVE:   SetSepoliaSwapRouter                                │   │
│  │          → TimeLockRouter.setTimelock(ERC20, 721, 1155)      │   │
│  │          → TimeLockRouter.setTokenWhitelist(...)              │   │
│  │          → TimeLockRouter.setUniswapRouter(real Uniswap)     │   │
│  │          → TokenWhiteList.addToken(USDC, USDT)               │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Phase 2 — Init Scripts (automated)

These now run automatically as part of `hardhat deploy` via the dependency graph.
No manual steps required — just run Phase 1 and everything is wired up.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PHASE 2: Init Scripts (automated)                 │
│                                                                     │
│  set_up_legacy (after legacy routers deploy)                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  EIP712LegacyVerifier.setRouterAddresses(                    │   │
│  │      transferEOA, transfer, multisig)                        │   │
│  │  LegacyDeployer.setParams(                                   │   │
│  │      multisig, transfer, transferEOA)                        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  set_up_reminder (after premium + mail contracts deploy)            │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  PremiumSetting.setUpReminder(manager, sendMailRouter)        │   │
│  │  PremiumAutomationManager.setParams(                         │   │
│  │      link, registrar, keeperRegistry,                        │   │
│  │      premiumSetting, baseGasLimit, sendMailRouter, 150)      │   │
│  │      (skipped on local — requires real Chainlink)            │   │
│  │  PremiumMailRouter.setParams(                                │   │
│  │      mailBefore, mailActivated, mailReady,                   │   │
│  │      premiumSetting, automationManager)                      │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Swap Router + Timelock + Token Whitelist wiring                    │
│  (handled by SetMockSwapRouter / SetSepoliaSwapRouter in Phase 1)  │
└─────────────────────────────────────────────────────────────────────┘
```

## Phase 3 — Post-Deploy (manual)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PHASE 3: Post-Deploy                              │
│                                                                     │
│  1. Add PremiumMail* proxy addresses as consumers on the            │
│     Chainlink Functions subscription (via Chainlink dashboard)      │
│                                                                     │
│  2. Fund PremiumAutomationManager with LINK                         │
│     (if Chainlink Automation is enabled)                            │
│                                                                     │
│  3. Consider transferring DefaultProxyAdmin ownership               │
│     to a multisig (Gnosis Safe)                                     │
│                                                                     │
│  4. Consider transferring EIP712LegacyVerifier ownership            │
│     to a multisig (via transferOwnership)                           │
└─────────────────────────────────────────────────────────────────────┘
```

## Upgrade Path (existing deployment)

For upgrading already-deployed contracts:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    UPGRADE PROCEDURE                                 │
│                                                                     │
│  1. Re-run: hardhat deploy --network <net>                          │
│     (no --reset flag)                                               │
│     → hardhat-deploy detects changed bytecode                       │
│     → deploys new implementation                                    │
│     → calls DefaultProxyAdmin.upgrade() automatically               │
│                                                                     │
│  2. Init scripts re-run automatically if wiring config changed      │
│     (hardhat-deploy tracks execution IDs; use --reset to force)    │
│                                                                     │
│  3. New contracts (e.g. TokenWhiteList on mainnet)                  │
│     → deployed fresh automatically by hardhat-deploy                │
│     → init scripts wire them in automatically                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Contract Dependency Graph

```
                    EIP712LegacyVerifier
                     ▲    ▲    ▲
                     │    │    │
              ┌──────┘    │    └──────┐
              │           │           │
  MultisigLegacyRouter  TransferLegacyRouter  TransferEOALegacyRouter
         ▲    ▲              ▲    ▲                  ▲    ▲
         │    │              │    │                  │    │
         │    └──────┐       │    └──────┐          │    └──────┐
         │           │       │           │          │           │
    LegacyDeployer   │  LegacyDeployer   │    LegacyDeployer   │
                     │                   │                     │
              PremiumSetting      PremiumSetting        PremiumSetting
                     │                   │
                     │              Payment ────────► PremiumRegistry
                     │                                     │
                     └─────────────────────────────────────┘


  TimeLockRouter ──► TimelockERC20
                 ──► TimelockERC721
                 ──► TimelockERC1155
                 ──► TokenWhiteList


  PremiumMailRouter ──► PremiumMailBeforeActivation
                    ──► PremiumMailReadyToActivate
                    ──► PremiumMailActivated
                    ──► PremiumAutomationManager
                    ──► PremiumSetting
```

## Quick Reference: yarn Commands

| Command | Purpose |
|---|---|
| `yarn deploy:local` | Deploy + wire everything to local hardhat node |
| `yarn deploy:sepolia` | Deploy/upgrade + wire everything on Sepolia |
| `yarn deploy:sepolia:fresh` | Fresh deploy on Sepolia (--reset) |

Manual re-run scripts (only needed if re-wiring after config change):

| Command | Purpose |
|---|---|
| `yarn set-up-legacy --network <net>` | Re-wire legacy routers ↔ verifier ↔ deployer |
| `yarn set-up-premium --network <net>` | Re-wire premium mail router with mail contracts |

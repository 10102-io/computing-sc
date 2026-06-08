# Computing SC

Smart contracts for the Computing project by 10102, implemented in Solidity and managed with Hardhat. This repo includes source code, deployment scripts, and tests.

## Quick Start

```bash
npm install
npx hardhat compile
npx hardhat test
```

## Branches & releases

`dev` is the working branch. `main` is kept **identical to `dev`** — releases are cut by fast-forwarding `dev` onto `main` (no squash, no separate `release(...)` commit). A release is marked solely by an annotated [CalVer](https://calver.org/) tag (`vYYYY.MM.DD`, with `.1`, `.2`, … for additional same-day releases) on the release commit, plus a dated entry in [CHANGELOG.md](CHANGELOG.md); push the tag and cut a GitHub Release from it.

This replaces the older squash-merge-with-`release(...)`-commit flow — `main` now matches `dev` 1:1, for simpler branch maintenance.

## Technical Architecture

The Computing ecosystem is a modular suite of smart contracts organised around digital-asset legacy management. Users create "legacy" contracts that govern how their assets are distributed under configurable conditions (multisig, direct transfer, or timelock).

### Module Overview

| Module | Purpose | Key Contracts |
| ----------- | ---------------------------------------- | ------------------------------------------------------------ |
| Common | Core factories and infrastructure | LegacyDeployer, LegacyFactory, EOALegacyFactory, Payment |
| Forwarding | Direct transfer legacies | TransferLegacyContractRouter, TransferLegacyEOAContractRouter |
| Inheritance | Multisig (Safe-based) legacies | MultisigLegacyContractRouter |
| Timelock | Delayed release of ERC-20/721/1155 assets | TimeLockRouter, TimeLockERC20, TimeLockERC721, TimeLockERC1155 |
| Premium | Subscription features and notifications | PremiumRegistry, PremiumSetting, PremiumReminderView |
| Term | EIP-712 Terms-of-Service verification | EIP712LegacyVerifier (VerifierTerm) |
| Whitelist | Token allowlisting for timelock swaps | TokenWhiteList |

### Core Components

- **SafeGuard** — Gnosis Safe Guard that tracks `lastTimestampTxs` and enforces inactivity-trigger rules for Safe-based legacies.
- **LegacyDeployer** — Create2 factory callable only by the three legacy routers; deploys per-user legacy contracts from deterministic salts.
- **Payment** — Central fee and withdrawal contract with WITHDRAWER/OPERATOR roles, claim-fee basis points, and ERC-20/ETH withdrawal.
- **Banner** — Configurable UI banner contract.

### External Integrations

- **Uniswap V2** — Token swaps within transfer legacy and timelock flows (router address per network in `config/external-addresses.ts`).
- **Chainlink** — **Price feeds only** (ETH/USD, USDT/USD, USDC/USD), consumed by `PremiumRegistry` to price premium subscriptions. Chainlink **Automation** (keeper registry) and **Functions** were **retired from the email-reminder path on 2026-06-02** (Phase B): email scheduling/delivery moved off-chain to a reminder-worker (Mailjet), driven by `PremiumSetting` emitting `LegacyEmailNotifyRequested` with timing read from `PremiumReminderView`. The Automation/Mail proxies remain on mainnet but are inert. See [CHANGELOG.md](CHANGELOG.md) and `docs/plans/chainlink-email-retirement.md`.
- **OpenZeppelin** — Upgradeable contracts (UUPS proxies), access control, and standard token interfaces.
- **Safe (Gnosis)** — Smart-account wallets for multisig and transfer legacies.

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Environment configuration

Create a `.env` file in the root directory:

```bash
# Required for deployment
DEPLOYER_PRIVATE_KEY=your_private_key_here

# Required for contract verification
API_KEY_ETHERSCAN=your_etherscan_api_key_here

# Required for premium setup script
PK=your_private_key_here
RPC=your_rpc_url_here
```

### 3. Network configuration

Configured in `hardhat.config.ts`:

| Network | Chain ID | Notes |
| --------- | -------- | ----------------------------------------------------------- |
| hardhat | 31337 | Local dev network; supports mainnet fork via `fork-block.json` |
| localhost | 31337 | Local node (`npx hardhat node`) |
| sepolia | 11155111 | Public testnet |
| mainnet | 1 | Ethereum mainnet |

Solidity compiler: **0.8.20** (primary, via IR) and **0.8.22**. Optimiser enabled with 200 runs.

### 4. Compile contracts

```bash
npx hardhat compile
```

### 5. Run tests

```bash
npx hardhat test
```

Active test files:

- `EOALegacyClone.spec.ts` — EIP-1167 EOA legacy clone flows
- `TransferEOARouterInitializers.spec.ts` — EOA router initialization
- `MultisigActivationTrigger.spec.ts` — Multisig activation-trigger (`uint128`) path
- `PremiumRegistry.spec.ts` — Premium registry (incl. SafeERC20 subscriptions)
- `PremiumSettingNotify.spec.ts` — `LegacyEmailNotifyRequested` emit path
- `PremiumReminderView.spec.ts` — Off-chain reminder due-window view
- `TimeLockRouter.test.ts` — Timelock router
- `TimelockERC20.test.ts` — Timelock ERC-20
- `TokenWhiteList.test.ts` — Token whitelist
- `FormatUnits.spec.ts` — Unit formatting library

### 6. Deployment

Deployment uses **hardhat-deploy** with tag-based scripts and automatic dependency ordering. See [docs/DEPLOY_DEPENDENCIES.md](docs/DEPLOY_DEPENDENCIES.md) for the full dependency graph.

#### Prerequisites

1. `.env` configured with `DEPLOYER_PRIVATE_KEY`
2. Deployer wallet funded with sufficient ETH for gas
3. Network configuration verified in `hardhat.config.ts`

#### Deploy all contracts

```bash
# Deploy everything to a network (respects dependency order automatically)
npx hardhat deploy --network sepolia

# Deploy a specific contract by tag
npx hardhat deploy --network sepolia --tags Payment
```

#### Deployment tags (in dependency order)

**Independent (no dependencies)**

- `Payment` — Central fee contract
- `EIP712LegacyVerifier` — ToS signature verification
- `LegacyDeployer` — Create2 legacy factory
- `Banner` — UI banner
- `PremiumSetting` — Premium configuration
- `TimeLockRouter` — Timelock routing

> **Note:** The `PremiumMail*` and `PremiumAutomationManager` deploy scripts (Chainlink Functions/Automation) were removed when the email path moved off-chain (Phase B, 2026-06-02). `PremiumReminderView` is deployed standalone (no proxy) via `scripts/deploy-premium-endstate.ts`, not by a tagged `hardhat-deploy` script.

**Dependent**

- `TokenWhiteList` — Depends on TestERC20
- `PremiumRegistry` — Depends on PremiumSetting, Payment
- `MultisigLegacyRouter` — Depends on PremiumSetting, LegacyDeployer, EIP712LegacyVerifier
- `TransferEOALegacyRouter` — Depends on LegacyDeployer, PremiumSetting, EIP712LegacyVerifier, Payment

> **Note:** The Safe-source `TransferLegacyRouter` was hard-sunset (v2026.05.18); its deploy script was removed. EOA and Multisig are the only live legacy creation paths. Wiring slots still pass `address(0)` for the sunset router (see `deploy/init/0.set_up_legacy.ts`).
- `TimelockERC20`, `TimelockERC721`, `TimelockERC1155` — Depend on TimeLockRouter
- `SetTimelockSwapRouter` — Runs on any network with a Uniswap router configured (sepolia, mainnet); wires timelock contracts (`setTimelock`), sets token whitelist, configures Uniswap router, and adds USDC/USDT to the whitelist

#### Verify contracts

```bash
npx hardhat verify --network <network-name> <contract-address> <constructor-args>
```

Requires `API_KEY_ETHERSCAN` in `.env`. Sourcify verification is also enabled.

#### Sync UI config

After deployment, generate contract addresses and ABIs for the UI app:

```bash
npm run sync-ui
```

This writes files to `output/sync-ui/`. Copy the contents into the UI repo so that `configs/` and `constants/` land under the UI's `src/` directory.

### 7. Post-deployment setup

After deploying all contracts, run setup scripts to wire contracts together:

#### Setup Legacy Contracts

```bash
npx hardhat run deploy/init/0.set_up_legacy.ts --network <network-name>
# Or: npm run set-up-legacy -- --network <network-name>
```

Configures: EIP712LegacyVerifier, LegacyDeployer, MultisigLegacyRouter, TransferEOALegacyRouter, PremiumRegistry, and PremiumSetting (the sunset `TransferLegacyRouter` slot is wired to `address(0)`).

#### Setup Premium Contracts

Premium wiring (PremiumSetting ↔ PremiumRegistry ↔ legacy routers) is handled by `deploy/init/0.set_up_legacy.ts` (`PremiumSetting.setParams`). The Chainlink-era `deploy/init/2.set_up_reminder.ts` reminder/automation/mail wiring script was **removed when the email path moved off-chain (2026-06-02)** — there is no longer a separate premium-reminder setup step on-chain, and the corresponding `set-up-premium` npm script has been removed. `PremiumReminderView` is deployed standalone via `scripts/deploy-premium-endstate.ts`.

> **Note:** On sepolia and mainnet, timelock wiring (setTimelock, setTokenWhitelist, setUniswapRouter, and adding USDC/USDT to the whitelist) is handled automatically by the `SetTimelockSwapRouter` deploy script. It runs on any network with a Uniswap router configured in `config/external-addresses.ts`.

### npm scripts

| Script | Description |
| ----------------------- | --------------------------------------------------- |
| `npm run compile` | Compile contracts |
| `npm test` | Run tests |
| `npm run node` | Start local Hardhat node (with mainnet fork) |
| `npm run node:fresh` | Start local Hardhat node (no fork) |
| `npm run deploy:local` | Deploy to localhost |
| `npm run deploy:sepolia` | Deploy to Sepolia |
| `npm run deploy:sepolia:fresh` | Deploy to Sepolia (reset all) |
| `npm run set-up-legacy` | Post-deploy legacy + premium wiring |
| `npm run sync-ui` | Generate UI config from deployments |

## Project Structure

```
.
├── config/
│   └── external-addresses.ts   # External contract addresses per network
├── contracts/
│   ├── SafeGuard.sol            # Gnosis Safe Guard
│   ├── common/                  # Deployer, Factory, Router base, Payment, Banner
│   ├── forwarding/              # Transfer legacy contracts and routers
│   ├── inheritance/             # Multisig legacy contracts and routers
│   ├── interfaces/              # All contract interfaces
│   ├── libraries/               # ArrayUtils, FormatUnits, NotifyLib, structs
│   ├── mock/                    # Test mocks (ERC-20/721/1155, Uniswap, Chainlink)
│   ├── premium/                 # Premium registry, settings, and reminder-due view
│   ├── term/                    # EIP-712 ToS verifier
│   ├── timelock/                # Timelock router and token-type handlers
│   └── whitelist/               # Token whitelist for timelock swaps
├── deploy/
│   ├── init/                    # Post-deployment setup scripts
│   ├── legacy/                  # Legacy contract deploy scripts
│   ├── premium/                 # Premium contract deploy scripts
│   └── timelock/                # Timelock contract deploy scripts
├── deployments/                 # hardhat-deploy artefacts (per network)
├── docs/                        # Architecture docs and deployment plans
├── output/sync-ui/              # Generated UI config (ABIs + addresses)
├── scripts/                     # Utility and upgrade scripts
├── test/                        # Hardhat test suite
├── contract-addresses.json      # Deployed contract addresses (all networks)
├── hardhat.config.ts
├── slither.config.json          # Slither static analysis config
└── compiler_config.json         # Solidity compiler config
```

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — Per-release narrative of what each deploy actually ships on-chain
- [CONTRACTS_REFERENCE.md](docs/CONTRACTS_REFERENCE.md) — Detailed reference for every deployed contract
- [DEPLOY_DEPENDENCIES.md](docs/DEPLOY_DEPENDENCIES.md) — Deploy script dependency graph and resume behaviour
- [SECURITY.md](SECURITY.md) — Vulnerability reporting policy

## Release hygiene

Releases on `main` are squash-merges of `dev` with a `release:` prefix.
The commit message on `main` is mechanical; the **narrative lives in
[`CHANGELOG.md`](CHANGELOG.md)**.

For every release:

1. **Draft the `CHANGELOG.md` entry first** — headline the on-chain
   behavior or cost change that matters, not the file list.
2. **Send the draft to the maintainer for sign-off** before
   squash-merging. The commit on `main` and the `CHANGELOG.md` entry
   should land together in the same squash.
3. Mainnet deploys that ship from `dev` ahead of a main-branch release
   (as with the EIP-1167 cutover) get their own `[Unreleased on main —
   already live on mainnet]` entry in `CHANGELOG.md` so the on-chain
   story stays in sync with what users see.
4. Frontend-side changes get their entry in
   `computing/CHANGELOG.md`, not here. Cross-reference when the
   contract and frontend stories are coupled.

## Security

- Keep private keys and `.env` files out of version control.
- Always test on testnets before deploying to mainnet.
- Treat contract upgrades and admin keys as production-critical.
- Report vulnerabilities to security@10102.io (see [SECURITY.md](SECURITY.md)).

## Disclaimer: Use at Your Own Risk

IMPORTANT: The smart contracts in this repository are provided "as is", without warranty of any kind, express or implied.

Financial Risk: Interacting with smart contracts involves inherent risks, including but not limited to technical vulnerabilities, bugs, and permanent loss of funds.
No Liability: In no event shall 10102 or the contributors be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

## Licence and Copyright

Copyright (c) 2026 10102.io - All rights reserved.

This software and associated documentation files are not licensed under any open-source licence. No part of this repository may be copied, modified, distributed, or used for commercial purposes without the express written permission of the copyright holder.

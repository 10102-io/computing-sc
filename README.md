# Computing SC

Smart contracts for the Computing project by 10102, implemented in Solidity and managed with Hardhat. This repo includes source code, deployment scripts, and tests.

## Quick Start

```bash
npm install
npx hardhat compile
npx hardhat test
```

## Technical Architecture

The Computing ecosystem is a modular suite of smart contracts organised around digital-asset legacy management. Users create "legacy" contracts that govern how their assets are distributed under configurable conditions (multisig, direct transfer, or timelock).

### Module Overview

| Module | Purpose | Key Contracts |
| ----------- | ---------------------------------------- | ------------------------------------------------------------ |
| Common | Core factories and infrastructure | LegacyDeployer, LegacyFactory, EOALegacyFactory, Payment |
| Forwarding | Direct transfer legacies | TransferLegacyContractRouter, TransferLegacyEOAContractRouter |
| Inheritance | Multisig (Safe-based) legacies | MultisigLegacyContractRouter |
| Timelock | Delayed release of ERC-20/721/1155 assets | TimeLockRouter, TimeLockERC20, TimeLockERC721, TimeLockERC1155 |
| Premium | Subscription features and notifications | PremiumRegistry, PremiumSetting, PremiumAutomationManager |
| Term | EIP-712 Terms-of-Service verification | EIP712LegacyVerifier (VerifierTerm) |
| Whitelist | Token allowlisting for timelock swaps | TokenWhiteList |

### Core Components

- **SafeGuard** — Gnosis Safe Guard that tracks `lastTimestampTxs` and enforces inactivity-trigger rules for Safe-based legacies.
- **LegacyDeployer** — Create2 factory callable only by the three legacy routers; deploys per-user legacy contracts from deterministic salts.
- **Payment** — Central fee and withdrawal contract with WITHDRAWER/OPERATOR roles, claim-fee basis points, and ERC-20/ETH withdrawal.
- **Banner** — Configurable UI banner contract.

### External Integrations

- **Uniswap V2** — Token swaps within transfer legacy and timelock flows (router address per network in `config/external-addresses.ts`).
- **Chainlink** — Automation (keeper registry), Functions, and price feeds (ETH/USD, USDT/USD, USDC/USD).
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

- `Legacy.spec.ts` — Legacy creation and distribution flows
- `PremiumAutomation.spec.ts` — Premium automation manager
- `PremiumRegistry.spec.ts` — Premium registry
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
- `PremiumMailRouter`, `PremiumMailBeforeActivation`, `PremiumMailReadyToActivate`, `PremiumMailActivated` — Mail notification contracts
- `PremiumAutomationManager` — Chainlink automation
- `TimeLockRouter` — Timelock routing

**Dependent**

- `TokenWhiteList` — Depends on TestERC20
- `PremiumRegistry` — Depends on PremiumSetting, Payment
- `MultisigLegacyRouter` — Depends on PremiumSetting, LegacyDeployer, EIP712LegacyVerifier
- `TransferLegacyRouter` — Depends on LegacyDeployer, PremiumSetting, EIP712LegacyVerifier
- `TransferEOALegacyRouter` — Depends on LegacyDeployer, PremiumSetting, EIP712LegacyVerifier, Payment
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

Configures: EIP712LegacyVerifier, LegacyDeployer, MultisigLegacyRouter, TransferLegacyRouter, TransferEOALegacyRouter.

#### Setup Premium Contracts

```bash
npx hardhat run deploy/init/2.set_up_reminder.ts --network <network-name>
# Or: npm run set-up-premium -- --network <network-name>
```

Configures: PremiumSetting, PremiumRegistry, PremiumAutomationManager, PremiumMailRouter, PremiumMailBeforeActivation, PremiumMailActivated, and integration with legacy routers.

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
| `npm run set-up-legacy` | Post-deploy legacy wiring |
| `npm run set-up-premium` | Post-deploy premium wiring |
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
│   ├── premium/                 # Premium features, automation, mail notifications
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

- [CONTRACTS_REFERENCE.md](docs/CONTRACTS_REFERENCE.md) — Detailed reference for every deployed contract
- [DEPLOY_DEPENDENCIES.md](docs/DEPLOY_DEPENDENCIES.md) — Deploy script dependency graph and resume behaviour
- [SECURITY.md](SECURITY.md) — Vulnerability reporting policy

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

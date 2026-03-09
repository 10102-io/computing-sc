# Computing SC

Smart contracts for the Computing project by 10102, implemented in Solidity and managed with Hardhat. This repo includes source code, deployment scripts, and tests.

## Quick Start

```bash
npm install
npx hardhat compile
npx hardhat test
```

## License and Copyright

Copyright © 2026 10102.io - All rights reserved.

This software and associated documentation files are not licensed under any open-source license. No part of this repository may be copied, modified, distributed, or used for commercial purposes without the express written permission of the copyright holder.

## Disclaimer: Use at your own risk

IMPORTANT: The smart contracts in this repository are provided "as is", without warranty of any kind, express or implied.

Financial Risk: Interacting with smart contracts involves inherent risks, including but not limited to technical vulnerabilities, bugs, and permanent loss of funds.
No Liability: In no event shall 10102 or the contributors be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

## Security

- Keep private keys and `.env` files out of version control.
- Always test on testnets before deploying to mainnet.
- Treat contract upgrades and admin keys as production-critical.

## Technical Architecture

The Computing ecosystem is a modular suite of smart contracts centered around the SafeGuard core. It manages digital assets through various "Legacy" modules:

| Module      | Purpose           | Key functionality                                         |
| ----------- | ----------------- | --------------------------------------------------------- |
| Forwarding  | Transfer legacy   | Handles direct transfer of assets to designated heirs.    |
| Inheritance | Multisig legacy   | Implements multi-signature logic for distributed control. |
| Timelock    | Delayed execution | Enforces mandatory waiting periods before actions.        |
| Premium     | Paid features     | Manages advanced or subscription-based features.          |
| Term        | Compliance        | Verifies off-chain signatures for Terms of Service.       |

Core component: SafeGuard

- Central hub: SafeGuard.sol acts as the main entry point for user interactions.
- Access control: Manages permissions and owner configurations for individual safeguards.
- Module integration: Orchestrates calls between compliance checks and execution logic.

## Getting Started

### 1. Clone the repo

```bash
git clone <repo-url>
cd <repo-name>
```

> **Placeholders:** replace `<repo-url>` and `<repo-name>` with your repo URL and folder name.

### 2. Install dependencies

```bash
npm install
# or
yarn install
```

### 3. Environment configuration

Create a `.env` file in the root directory with the following variables:

```bash
# Required for deployment
DEPLOYER_PRIVATE_KEY=your_private_key_here

# Required for contract verification
API_KEY_ETHERSCAN=your_etherscan_api_key_here
```

**Environment variables:**

- **DEPLOYER_PRIVATE_KEY**: Wallet private key used for deployments. **Never commit this to version control.**
- **API_KEY_ETHERSCAN**: Etherscan API key used for contract verification.

### Network configuration

The project supports the following networks (configured in `hardhat.config.ts`):

- **hardhat**: Local development network (default)
- **sepolia**: Sepolia testnet (public RPC)
- **mainnet**: Ethereum mainnet

To add or modify network configurations, update the `networks` section in `hardhat.config.ts`.

### 4. Compile contracts

```bash
npx hardhat compile
```

### 5. Run unit tests

```bash
npx hardhat test
```

### 6. Deployment guide

#### Prerequisites

1. Ensure your `.env` file is properly configured with `DEPLOYER_PRIVATE_KEY`
2. Make sure your deployer wallet has sufficient funds (ETH) for gas fees
3. Verify the network configuration in `hardhat.config.ts` matches your target network

#### Deployment steps

1. Compile the contracts (if not already done):

```bash
npx hardhat compile
```

2. Deploy contracts in order (see Deployment tags for the complete list):

```bash
# Deploy to Sepolia testnet
npx hardhat deploy --network sepolia --tags <tag-name>

# Deploy to Mainnet (be careful!)
npx hardhat deploy --network mainnet --tags <tag-name>
```

> **Placeholder:** replace `<tag-name>` with a tag from the list below.

3. Verify contracts on Etherscan (after deployment):

```bash
npx hardhat verify --network <network-name> <contract-address> <constructor-args>
```

4. **Sync UI config (after deployment):** To update the UI app with the new contract addresses and ABIs, run:

```bash
npm run sync-ui
```

This writes `configs/contract-addresses.generated.ts` and ABI files under `output/sync-ui/` (in this repo). **Manually copy** the contents of `output/sync-ui/` into the UI repo so that `configs/` and `constants/` land under the UI's `src/` (e.g. copy into `10102-ui/src/` so that `output/sync-ui/configs/` → `10102-ui/src/configs/` and `output/sync-ui/constants/` → `10102-ui/src/constants/`). The UI reads contract addresses from the generated config; no address env vars are required.

#### Deployment tags

Deploy contracts in the following order using the `--tags` parameter:

**Core Contracts**

1. `Banner` - Banner contract
2. `EIP712LegacyVerifier` - Verify Terms of Service signature
3. `LegacyDeployer` - Legacy Deployer contract
4. `MultisigLegacyRouter` - Multisig Legacy Router
5. `TransferLegacyRouter` - Transfer Legacy Router
6. `TransferEOALegacyRouter` - Transfer EOA Legacy Router

**Timelock Contracts**

7. `TimeLockRouter` - Timelock Router
8. `TimelockERC20` - Timelock ERC20
9. `TimelockERC721` - Timelock ERC721
10. `TimelockERC1155` - Timelock ERC1155

**Payment**

11. `Payment` - Payment contract

**Premium Contracts**

12. `PremiumRegistry` - Premium Registry
13. `PremiumSetting` - Premium Setting
14. `PremiumAutomationManager` - Premium Automation Manager
15. `PremiumMailRouter` - Premium Mail Router
17. `PremiumMailBeforeActivation` - Premium Mail Before Activation
18. `PremiumMailReadyToActivate` - Premium Mail Ready To Activate
19. `PremiumMailActivated` - Premium Mail Activated

#### Deployment template

Use this template to deploy all contracts in order:

```bash
# Example: Deploy to Sepolia testnet
npx hardhat deploy --network sepolia --tags Payment
npx hardhat deploy --network sepolia --tags Banner
npx hardhat deploy --network sepolia --tags EIP712LegacyVerifier
npx hardhat deploy --network sepolia --tags LegacyDeployer
npx hardhat deploy --network sepolia --tags PremiumSetting
npx hardhat deploy --network sepolia --tags MultisigLegacyRouter
npx hardhat deploy --network sepolia --tags TransferLegacyRouter
npx hardhat deploy --network sepolia --tags TransferEOALegacyRouter
npx hardhat deploy --network sepolia --tags TimeLockRouter
npx hardhat deploy --network sepolia --tags TimelockERC20
npx hardhat deploy --network sepolia --tags TimelockERC721
npx hardhat deploy --network sepolia --tags TimelockERC1155
npx hardhat deploy --network sepolia --tags PremiumRegistry
npx hardhat deploy --network sepolia --tags PremiumAutomationManager
npx hardhat deploy --network sepolia --tags PremiumMailRouter
npx hardhat deploy --network sepolia --tags PremiumMailBeforeActivation
npx hardhat deploy --network sepolia --tags PremiumMailReadyToActivate
npx hardhat deploy --network sepolia --tags PremiumMailActivated
```

> **Note:** Replace `sepolia` with your target network (e.g., `mainnet`) and ensure each deployment completes successfully before proceeding to the next one.

### Post-deployment setup

> **IMPORTANT:** Before running setup scripts, ensure:
>
> - All contracts have been deployed successfully
> - Your `.env` file is properly configured with:
>   - `DEPLOYER_PRIVATE_KEY` (required for all setup scripts)
>   - `PK` (required for premium setup script)
>   - `RPC` (required for premium setup script)
> - The network configuration matches your deployment network
> - Contract addresses are saved in `contract-addresses.json`

After deploying all contracts, run the following setup scripts in order:

#### 1. Setup Legacy Contracts

```bash
# Set up legacy contracts (MultisigLegacyRouter, TransferLegacyRouter, TransferEOALegacyRouter)
npx hardhat run deploy/init/0.set_up_legacy.ts --network <network-name>

# Example:
npx hardhat run deploy/init/0.set_up_legacy.ts --network sepolia

# Or using npm script:
npm run set-up-legacy -- --network <network-name>
```

This script configures:

- EIP712LegacyVerifier
- LegacyDeployer
- MultisigLegacyRouter
- TransferLegacyRouter
- TransferEOALegacyRouter

#### 2. Setup Timelock Contracts

```bash
# Set up timelock contracts (TimelockERC20, TimelockERC721, TimelockERC1155)
npx hardhat run deploy/init/1.setTimelock.ts --network <network-name>

# Example:
npx hardhat run deploy/init/1.setTimelock.ts --network sepolia

# Or using npm script:
npm run set-up-timelock -- --network <network-name>
```

This script configures:

- TimeLockRouter with TimelockERC20, TimelockERC721, and TimelockERC1155 addresses

> **Note:** On Sepolia and mainnet, timelock setup (setTimelock, setTokenWhitelist, setUniswapRouter, and adding external USDC/USDT to the whitelist) is handled automatically by the deploy script `SetSepoliaSwapRouter`. You only need to run `set-up-timelock` manually for other networks where that script does not run.

#### 3. Setup Premium Contracts

```bash
# Set up premium contracts and reminder system
npx hardhat run deploy/init/2.set_up_reminder.ts --network <network-name>

# Example:
npx hardhat run deploy/init/2.set_up_reminder.ts --network sepolia

# Or using npm script:
npm run set-up-premium -- --network <network-name>
```

This script configures:

- PremiumSetting
- PremiumRegistry
- PremiumAutomationManager
- PremiumMailRouter
- PremiumMailBeforeActivation
- PremiumMailActivated
- Integration with legacy routers

> **Note:** Run these scripts on the same network where you deployed the contracts. Each script will read contract addresses from `contract-addresses.json` for the specified network.

### Important notes

- **Security**: Never share or commit your private keys or `.env` file
- **Mainnet**: Always test thoroughly on testnets before deploying to mainnet
- **Contract Addresses**: Deployed contract addresses are saved in `contract-addresses.json`
- **Verification**: Contract verification requires `API_KEY_ETHERSCAN` in your `.env` file

## Project structure

```
.
├── LICENSE.md
├── README.md
├── SECURITY.md
├── contract-addresses.json     # Deployed contract addresses
├── contracts/
│   ├── SafeGuard.sol
│   ├── common/                 # Deployer, Factory, Generic Contracts
│   ├── forwarding/             # Contracts for Transfer Legacy
│   ├── inheritance/            # Contracts for Multisig Legacy
│   ├── interfaces/
│   ├── libraries/
│   ├── mock/
│   ├── premium/                # Contracts for premium features
│   ├── term/                   # Verify Terms of Service signature
│   └── timelock/               # Contracts for Timelock
├── deploy/
│   ├── init/                   # Post-deployment setup scripts
│   ├── legacy/                 # Legacy contract deployments
│   ├── premium/                # Premium contract deployments
│   └── timelock/               # Timelock contract deployments
├── hardhat.config.ts
├── package.json
├── scripts/
├── test/
└── tsconfig.json
```

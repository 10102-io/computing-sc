# Fix Deploy Scripts for Mainnet Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the 5 issues preventing a clean mainnet deployment via `hardhat deploy --network mainnet`.

**Architecture:** Patch existing deploy scripts and config — no new contracts or architecture changes. MockPremiumSendMail deployed for now, real implementation later.

**Tech Stack:** Hardhat, hardhat-deploy, TypeScript, ethers.js

---

### Task 1: Fill in mainnet external addresses

**Files:**
- Modify: `config/external-addresses.ts:99-116`

**Step 1: Look up mainnet Chainlink addresses**

The following mainnet addresses need to be filled in. The deployer must provide these — they cannot be guessed:

```typescript
mainnet: {
  // Already correct:
  uniswapRouter: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",

  // MUST be filled in:
  usdtUsdPriceFeed: "???",        // Chainlink USDT/USD on mainnet
  usdcUsdPriceFeed: "???",        // Chainlink USDC/USD on mainnet
  ethUsdPriceFeed: "???",         // Chainlink ETH/USD on mainnet
  verifierTermOwner: "???",       // Address that should own EIP712LegacyVerifier
  chainlinkLink: "???",           // LINK token on mainnet
  chainlinkRegistrar: "???",      // Chainlink Automation registrar
  chainlinkKeeperRegistry: "???", // Chainlink Automation keeper registry
  chainlinkFunctionsRouter: "???",// Chainlink Functions router
  chainlinkDonId: "???",          // Chainlink Functions DON ID (bytes32)
  chainlinkSubscriptionId: 0,     // Chainlink Functions subscription ID
}
```

Well-known mainnet addresses for reference:
- Chainlink ETH/USD: `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`
- Chainlink USDC/USD: `0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6`
- Chainlink USDT/USD: `0x3E7d1eAB13ad0104d2750B8863b489D65364e32D`
- LINK token: `0x514910771AF9Ca656af840dff83E8264EcF986CA`
- Chainlink Automation Registrar v2.1: `0x6B0B234fB2f380309D47A7E9391E29E9a179395a`
- Chainlink Keeper Registry v2.1: `0x6593c7De001fC8542bB1703532EE1E5aA0D458fD`

**Step 2: Update the file with correct addresses**

Replace all `ZERO` values in the mainnet block with the correct addresses. `verifierTermOwner` should be the deployer's address or a multisig.

**Step 3: Verify addresses compile**

Run: `npx hardhat compile`
Expected: Compiles successfully (addresses are just strings, no compilation impact — but verifies no syntax errors)

**Step 4: Commit**

```bash
git add config/external-addresses.ts
git commit -m "feat: fill in mainnet external addresses for Chainlink and price feeds"
```

---

### Task 2: Delete stale upgrade scripts

**Files:**
- Delete: `scripts/deploy-eoa-router.ts`
- Delete: `scripts/upgrade-eoa-legacy-router.ts`
- Delete: `scripts/upgrade-eoa-legacy-creation-code.ts`

**Step 1: Verify these scripts reference non-existent functions**

Run: `npx hardhat compile` (should already be done)

Then check:
```bash
grep -n "initializeV2\|setLegacyCreationCode" scripts/deploy-eoa-router.ts scripts/upgrade-eoa-legacy-router.ts scripts/upgrade-eoa-legacy-creation-code.ts
```
Expected: Multiple matches — these functions don't exist on the compiled contract.

**Step 2: Delete the stale scripts**

```bash
rm scripts/deploy-eoa-router.ts
rm scripts/upgrade-eoa-legacy-router.ts
rm scripts/upgrade-eoa-legacy-creation-code.ts
```

**Step 3: Commit**

```bash
git add -u scripts/
git commit -m "chore: remove stale EOA router scripts referencing non-existent initializeV2/setLegacyCreationCode"
```

---

### Task 3: Standardize env var in `set_up_reminder.ts`

**Files:**
- Modify: `deploy/init/2.set_up_reminder.ts`

**Step 1: Replace `PK` with `DEPLOYER_PRIVATE_KEY`**

In `deploy/init/2.set_up_reminder.ts`, change `getUserAddress()` and all references to `process.env.PK` to use `process.env.DEPLOYER_PRIVATE_KEY` instead.

Change the `getWeb3` function to use `process.env.SEPOLIA_RPC_URL ?? process.env.RPC` for consistency with other scripts, or refactor to use `getProvider()` from `scripts/utils`.

Simplest fix — replace the Web3-based signing with the existing `getProvider()` utility that already uses `DEPLOYER_PRIVATE_KEY`:

```typescript
// Replace:
const web3 = getWeb3();
const user = getUserAddress();
const userPk = process.env.PK!;

// With:
const { wallet } = getProvider();
const user = wallet.address;
```

And replace all the raw Web3 `signTransaction` / `sendSignedTransaction` patterns with ethers.js contract calls via the wallet, matching the pattern used in other init scripts.

**Step 2: Test locally**

Run: `HARDHAT_NO_FORK=1 npx hardhat node` (in separate terminal)
Then: `npx hardhat run deploy/init/2.set_up_reminder.ts --network localhost`
Expected: Should fail with "No contract addresses found" (expected — contracts aren't deployed on fresh local), confirming the script parses and runs.

**Step 3: Commit**

```bash
git add deploy/init/2.set_up_reminder.ts
git commit -m "fix: standardize set_up_reminder.ts to use DEPLOYER_PRIVATE_KEY instead of PK"
```

---

### Task 4: Investigate and fix commented-out init calls

**Files:**
- Modify: `deploy/init/2.set_up_reminder.ts` (lines 217-219)

**Step 1: Determine if `setUpReminder` and `setParamsManager` are needed**

Check if `PremiumSetting.setUpReminder(manager, sendMailRouter)` is required for the premium system:

```bash
grep -n "setUpReminder" contracts/premium/PremiumSetting.sol
```

Check if `PremiumAutomationManager.setParams(...)` is required:

```bash
grep -n "function setParams" contracts/premium/PremiumAutomationManager.sol
```

Check if any existing mainnet state already has these set (if upgrading rather than fresh deploying).

**Step 2: If needed, uncomment the calls**

If `setUpReminder` is required for premium automation to work, uncomment line 218.
If `setParamsManager` is required for Chainlink automation, uncomment line 219 (requires Chainlink addresses from Task 1).

Note: `setPramramPremiumSetting` (line 217) should stay commented — it duplicates `init/0.set_up_legacy.ts`.

**Step 3: Commit**

```bash
git add deploy/init/2.set_up_reminder.ts
git commit -m "fix: uncomment required init calls in set_up_reminder.ts"
```

---

### Task 5: Verify full deploy works on local fork

**Step 1: Set up a fresh local node**

```bash
HARDHAT_NO_FORK=1 npx hardhat node
```

**Step 2: Run full deploy**

In a separate terminal:
```bash
npx hardhat deploy --network localhost
```

Expected: All contracts deploy successfully in the correct order. Check for:
- No reverts during proxy initialization
- All contracts saved to `contract-addresses.json` under `localhost`
- `SetSepoliaSwapRouter` is skipped (localhost has no uniswap)
- `SetMockSwapRouter` runs and wires timelock contracts

**Step 3: Run init scripts**

```bash
npx hardhat run deploy/init/0.set_up_legacy.ts --network localhost
npx hardhat run deploy/init/2.set_up_reminder.ts --network localhost
```

Expected: Both complete without errors.

**Step 4: Run tests against the deployed state**

```bash
npx hardhat test --network localhost
```

Expected: Tests pass (or at least no deployment-related failures).

**Step 5: Commit any fixes discovered**

```bash
git commit -m "fix: deployment issues discovered during local verification"
```

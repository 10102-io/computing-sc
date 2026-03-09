# Verifying TransferEOALegacyRouter implementation

The verify script reads the implementation address from **contract-addresses.json** (key `sepolia.TransferEOALegacyRouter.implementation`), so it stays correct after redeploys.

If `npm run verify:TransferEOALegacyRouter-impl` fails with **"bytecode does not match"**, the on-chain contract was built with a slightly different compiler or environment than the current Hardhat build (e.g. different Solidity 0.8.20 build or dependency versions).

## Option 1: Verify in the same session as deploy (recommended)

So the same compilation is used for both deploy and verify, run verify immediately after deploy **without** recompiling:

```bash
npx hardhat deploy --network sepolia --tags TransferEOALegacyRouter --reset
SKIP_COMPILE=1 npm run verify:TransferEOALegacyRouter-impl
```

Or after a full redeploy:

```bash
npx hardhat deploy --network sepolia --reset
# Then, in the same terminal (same artifacts):
SKIP_COMPILE=1 npm run verify:TransferEOALegacyRouter-impl
```

## Option 2: Fresh compile then verify

Run a clean compile, then verify (same compiler in one session):

```bash
npx hardhat clean && npx hardhat compile && npm run verify:TransferEOALegacyRouter-impl
```

## Option 3: Manual verification on Etherscan

1. Open [Sepolia Etherscan Contract Verification](https://sepolia.etherscan.io/verifyContract).
2. **Contract Address:** use `TransferEOALegacyRouter.implementation` from `contract-addresses.json` for the network you deployed to (e.g. sepolia).
3. **Compiler Type:** Solidity (Standard-Json-Input)
4. **Compiler Version:** v0.8.20+commit.a1b79de6
5. **Open Source License:** MIT (or match your repo)
6. Under "Standard Input JSON", use the JSON from your build:
   - After `npx hardhat compile`, find the build info in `artifacts/build-info/` that contains `TransferEOALegacyRouter` (e.g. grep for it). Use that file’s `input` field as the Standard Input JSON.
7. **Contract Name:** `contracts/forwarding/TransferLegacyEOAContractRouter.sol:TransferEOALegacyRouter`
8. **Optimization:** Yes, 200 runs
9. **EVM version:** default (or compiler default)
10. If your build uses **via-IR**, ensure the Standard Input JSON’s `settings.viaIR` is `true` (it’s in the compiler settings inside the JSON).

## Option 4: Re-deploy then verify

Redeploy the proxy (and implementation) so deploy and verify use the same build, then verify in the same run:

```bash
npx hardhat deploy --network sepolia --tags TransferEOALegacyRouter --reset
```

The deploy script already runs verification after deployment; if it still fails, run Option 1 in the same terminal session right after.

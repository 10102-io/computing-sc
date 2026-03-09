# Deploy Script Dependencies

hardhat-deploy runs scripts in dependency order: a script runs only after all of its `deploy.dependencies` have run. Scripts with no dependencies can run in any order (subject to discovery order). This keeps resume behaviour deterministic and avoids redeploying.

## Current dependency graph

| Script (tag)                | Depends on                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Payment                     | —                                                                                                                                   |
| TestERC20                   | — (skipped on mainnet)                                                                                                              |
| TokenWhiteList              | TestERC20                                                                                                                           |
| EIP712LegacyVerifier        | —                                                                                                                                   |
| LegacyDeployer              | —                                                                                                                                   |
| Banner                      | —                                                                                                                                   |
| PremiumSetting              | —                                                                                                                                   |
| PremiumRegistry             | PremiumSetting, Payment                                                                                                             |
| MultisigLegacyRouter        | PremiumSetting, LegacyDeployer, EIP712LegacyVerifier                                                                                |
| TransferLegacyRouter        | LegacyDeployer, PremiumSetting, EIP712LegacyVerifier                                                                                |
| TransferEOALegacyRouter     | LegacyDeployer, PremiumSetting, EIP712LegacyVerifier, Payment                                                                       |
| PremiumMailRouter           | —                                                                                                                                   |
| PremiumMailBeforeActivation | —                                                                                                                                   |
| PremiumMailReadyToActivate  | —                                                                                                                                   |
| PremiumMailActivated        | —                                                                                                                                   |
| PremiumAutomationManager    | —                                                                                                                                   |
| PremiumSendMail             | —                                                                                                                                   |
| TimeLockRouter              | —                                                                                                                                   |
| TimelockERC20               | TimeLockRouter                                                                                                                      |
| TimelockERC721              | TimeLockRouter                                                                                                                      |
| TimelockERC1155             | TimeLockRouter                                                                                                                      |
| SetMockSwapRouter           | TimeLockRouter, TestERC20 (localhost/hardhat only)                                                                                  |
| SetSepoliaSwapRouter        | TimeLockRouter, TimelockERC20, TimelockERC721, TimelockERC1155, TokenWhiteList (sepolia and mainnet when uniswap router configured) |

## Effect on resume

- **Reuse:** For each contract, hardhat-deploy checks `deployments/<network>/<DeploymentName>.json`. If it exists and matches, it reuses (“reusing X at 0x…”).
- **Order:** With the above dependencies, the same order is used every run. So after an interruption, running `npx hardhat deploy --network <network>` again continues from the next script and reuses everything already deployed.
- **No overwriting deploy state:** Do not delete `deployments/<network>/` for a network you want to resume; that would make hardhat-deploy treat everything as new and redeploy.

## If you still see redeploys

1. **Same network:** Ensure you use the same `--network` (e.g. `sepolia`) as the partial run.
2. **Deployments folder:** Confirm `deployments/<network>/` exists and contains the JSON files for contracts you expect to be reused.
3. **Contract/name/args:** Reuse is by deployment id (contract + name + args). If a script was changed to use different args or a different contract name, that deployment is considered new and will deploy again.

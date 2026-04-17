# Solidity Compiler Upgrade Plan

**Status**: Planned  
**Priority**: Low (no functional impact today)  
**Created**: 2026-04-10

## Background

The project currently uses solc 0.8.20 (with a secondary 0.8.22 compiler entry).
Etherscan flags four low-severity known compiler bugs for 0.8.20:

- `LostStorageArrayWriteOnSlotOverflow` — unrealistic slot positions required
- `VerbatimInvalidDeduplication` — requires `verbatim` in assembly (not used)
- `FullInlinerNonExpressionSplitArgumentEvaluationOrder` — viaIR optimizer edge case
- `MissingSideEffectsOnSelectorAccess` — `.selector` on side-effect expressions

None of these affect the current contracts in practice, but upgrading to the
latest stable solc (0.8.28+) would eliminate the warnings and bring access to
newer language features and gas optimizations.

## Scope

- Bump both compiler entries in `hardhat.config.ts` (0.8.20 → latest, 0.8.22 → latest)
- Audit all `pragma solidity` directives in contracts
- Run full test suite — fix any new warnings or compilation errors
- **Storage layout verification** for every upgradeable proxy contract:
  - MultisigLegacyRouter
  - TransferLegacyContractRouter
  - TimelockRouter
  - Any other proxied contracts
- Use `hardhat-upgrades` storage layout checks or manual slot diffing
- Deploy to Sepolia, verify all contracts, run integration tests
- Deploy to mainnet

## Risks

- `viaIR: true` behavior may change between compiler versions → bytecode diff
- OpenZeppelin dependency compatibility (check supported solc range)
- Storage layout must remain identical for all proxy-upgradeable contracts
- Gas costs may shift (optimizer changes between versions)

## Prerequisites

- All current feature work and bug fixes landed and stable
- Full test coverage for affected contracts
- A clean Sepolia environment to validate against

## Notes

This should be done as an isolated task — not combined with feature work or
contract logic changes, so any regressions are clearly attributable to the
compiler change.

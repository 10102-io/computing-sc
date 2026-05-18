/**
 * Shared wiring helper for test fixtures.
 *
 * Centralises the three "router-wire-up" calls that every Phase A test
 * fixture has to perform after deploying the proxies. Each spec had its
 * own copy of this code, and the argument order on each setter differs
 * — the v2026.05.18 Safe-Transfer sunset surfaced an off-by-slot bug
 * across all four specs because the AddressZero placeholder was being
 * passed in the wrong slot in each of the three calls.
 *
 * This helper:
 *  - Takes a single typed `WiringInputs` object so the call sites are
 *    self-documenting and IDE-checked.
 *  - Encapsulates the canonical argument order for each setter so future
 *    contract refactors only need to update this file.
 *  - Defaults `sunsetTransferRouter` to AddressZero, since Safe-source
 *    Transfer was sunset in v2026.05.18 and no current fixture should
 *    pass a non-zero value here.
 */
import { ethers } from "hardhat";

// `any` here matches the codebase convention in test/utils/proxy.ts —
// the project mixes ethers v5 contract instances with hardhat-toolbox's
// HardhatEthersSigner / HardhatEthersProvider types that don't satisfy
// the strict v5 typings. Suppressing here keeps the helper usable across
// all four spec files without forcing a project-wide ethers v6 migration.
type AnySigner = any;
type AnyContract = any;

export interface WiringInputs {
  /**
   * Default signer used to call all three setters (must own / hold admin
   * role on each proxy). Override per-call with the `*Admin` overrides
   * below if a particular proxy was initialised by a different signer.
   */
  admin: AnySigner;

  /** Proxy instances to wire up. */
  premiumSetting: AnyContract;
  premiumRegistry: AnyContract;
  legacyDeployer: AnyContract;
  verifierTerm: AnyContract;
  transferEOALegacyRouter: AnyContract;
  multisigLegacyRouter: AnyContract;

  /**
   * Safe-source Transfer router was sunset in v2026.05.18. Every
   * downstream contract accepts address(0) for that slot. Override only
   * if you're explicitly testing legacy Safe-Transfer wiring.
   */
  sunsetTransferRouter?: string;

  /** Override the signer used for PremiumSetting.setParams. */
  premiumSettingAdmin?: AnySigner;
  /** Override the signer used for LegacyDeployer.setParams. */
  legacyDeployerAdmin?: AnySigner;
  /** Override the signer used for EIP712LegacyVerifier.setRouterAddresses. */
  verifierTermAdmin?: AnySigner;
}

/**
 * Run all three router-wire-up calls in the canonical order.
 * Idempotent on the chain: each setter is a plain write, so calling
 * twice is safe in test contexts.
 */
export async function wireRouters(inp: WiringInputs): Promise<void> {
  const sunset = inp.sunsetTransferRouter ?? ethers.constants.AddressZero;
  const psAdmin = inp.premiumSettingAdmin ?? inp.admin;
  const ldAdmin = inp.legacyDeployerAdmin ?? inp.admin;
  const vtAdmin = inp.verifierTermAdmin ?? inp.admin;

  // PremiumSetting.setParams(
  //   premiumRegistry,
  //   transferLegacyContractRouter (sunset),
  //   transferEOALegacyContractRouter,
  //   multisigLegacyContractRouter
  // )
  await inp.premiumSetting.connect(psAdmin).setParams(
    inp.premiumRegistry.address,
    sunset,
    inp.transferEOALegacyRouter.address,
    inp.multisigLegacyRouter.address
  );

  // LegacyDeployer.setParams(
  //   multisigLegacyRouter,
  //   transferLegacyRouter (sunset),
  //   transferEOALegacyRouter
  // )
  await inp.legacyDeployer.connect(ldAdmin).setParams(
    inp.multisigLegacyRouter.address,
    sunset,
    inp.transferEOALegacyRouter.address
  );

  // EIP712LegacyVerifier.setRouterAddresses(
  //   transferEOALegacyRouter,
  //   transferLegacyRouter (sunset),
  //   multisigLegacyRouter
  // )
  await inp.verifierTerm.connect(vtAdmin).setRouterAddresses(
    inp.transferEOALegacyRouter.address,
    sunset,
    inp.multisigLegacyRouter.address
  );
}

/**
 * Common premium-plan bootstrap used across fixtures: create a single
 * "infinite-duration penny plan" so admin-subscribe paths work in tests.
 * Returns the planId of the newly-created plan.
 */
export async function createTestPremiumPlan(
  premiumRegistry: AnyContract,
  admin: AnySigner
): Promise<number> {
  await premiumRegistry
    .connect(admin)
    .createPlans([ethers.constants.MaxUint256], [1], [""], [""], [""]);
  const next = await premiumRegistry.getNextPlanId();
  return Number(next) - 1;
}

/**
 * The ShieldVault deployments the shared specs run against: v2 (live since
 * 2026-09-29, fee on withdrawals and releases) and v3 (fee on releases only,
 * docs/plans/shield-vault.md "v3").
 */
export const SHIELD_VARIANTS = [
  { label: "ShieldVault", contract: "ShieldVault", feeOnWithdraw: true },
  { label: "ShieldVaultV3", contract: "ShieldVaultV3", feeOnWithdraw: false },
] as const;

export type ShieldVariant = (typeof SHIELD_VARIANTS)[number];

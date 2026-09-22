/**
 * Minimal Safe{Wallet} execution helper for scripts.
 *
 * While the governance Safe has threshold 1 and the deployer key is one of
 * its owners (docs/plans/round-2026-09.md section 8), a script can drive the
 * Safe directly: `execTransaction` accepts a "pre-validated" signature for an
 * owner that is also `msg.sender` (signature bytes = r: owner address padded
 * to 32 bytes, s: 0, v: 1). Once the threshold is raised this helper stops
 * working by design, and operations go through Safe{Wallet} with the
 * calldata printed by `timelock-op.ts` (`TL_ACTION=print`).
 *
 * Nothing here holds a key: the signer comes from Hardhat's configured
 * account (DEPLOYER_PRIVATE_KEY in .env).
 */
import { BigNumber, Contract, Signer, ethers as ethersLib } from "ethers";

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function isOwner(address) view returns (bool)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
];

export interface SafeState {
  owners: string[];
  threshold: number;
}

export async function readSafe(signer: Signer, safeAddress: string): Promise<SafeState> {
  const safe = new Contract(safeAddress, SAFE_ABI, signer);
  const [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]);
  return { owners: owners.map((o: string) => o.toLowerCase()), threshold: BigNumber.from(threshold).toNumber() };
}

/** Pre-validated signature: valid iff `owner == msg.sender` at execution. */
export function preValidatedSignature(owner: string): string {
  return ethersLib.utils.hexConcat([
    ethersLib.utils.hexZeroPad(owner, 32), // r
    ethersLib.utils.hexZeroPad("0x00", 32), // s
    "0x01", // v = 1 -> approved hash / msg.sender is the owner
  ]);
}

/**
 * Execute `to.call(data)` from the Safe with the connected signer as the
 * single approving owner. Throws before sending when the Safe's threshold is
 * above 1 or the signer is not an owner, so the failure mode is a message,
 * not a reverted transaction.
 */
export async function execViaSafe(
  signer: Signer,
  safeAddress: string,
  to: string,
  data: string,
  value: BigNumber = BigNumber.from(0)
): Promise<ethersLib.ContractTransaction> {
  const me = (await signer.getAddress()).toLowerCase();
  const state = await readSafe(signer, safeAddress);
  if (!state.owners.includes(me)) {
    throw new Error(`Signer ${me} is not an owner of Safe ${safeAddress}.`);
  }
  if (state.threshold !== 1) {
    throw new Error(
      `Safe ${safeAddress} has threshold ${state.threshold}; scripts can only drive a threshold-1 Safe. ` +
        `Use TL_ACTION=print and Safe{Wallet}'s Transaction Builder instead.`
    );
  }
  const safe = new Contract(safeAddress, SAFE_ABI, signer);
  return safe.execTransaction(
    to,
    value,
    data,
    0, // CALL
    0,
    0,
    0,
    ethersLib.constants.AddressZero,
    ethersLib.constants.AddressZero,
    preValidatedSignature(me)
  );
}

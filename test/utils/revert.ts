import { ethers } from "hardhat";

/** The first four-byte-or-longer hex string among the places a revert's return data can sit. */
function returnData(err: any): string | undefined {
  return [err?.data, err?.data?.data, err?.error?.data, err?.error?.data?.data].find((d) => typeof d === "string" && /^0x[0-9a-fA-F]{8}/.test(d));
}

/**
 * Whether `err` is the revert `expected` names: a custom error by its signature
 * (`Name()`, `Name(address,uint256)`), or a reason string by a part of it.
 *
 * A custom error is decided by the selector of the return data when the error
 * carries any, and by the message otherwise. Never search the whole error as
 * JSON: Hardhat's stack-trace frames hold the source text of every file on the
 * way, so every error declared in those files would match. The specs' own
 * copies of this helper did that until 2026-11-16, and their reason checks
 * proved only "reverted".
 */
export function revertedWith(err: any, expected: string): boolean {
  const text = [err?.message, err?.reason, err?.errorSignature, err?.error?.message]
    .filter((part) => typeof part === "string")
    .join(" ")
    .toLowerCase();
  const wanted = expected.toLowerCase();
  if (!/^[A-Za-z_]\w*\(.*\)$/.test(expected)) return text.includes(wanted);
  const selector = ethers.utils.id(expected).slice(0, 10).toLowerCase();
  const data = returnData(err);
  if (data) return data.toLowerCase().startsWith(selector);
  return text.includes(wanted) || text.includes(selector);
}

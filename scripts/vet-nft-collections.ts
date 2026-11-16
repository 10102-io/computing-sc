/**
 * Vets NFT collections before they go on NftCollectionWhiteList, on a local
 * fork of the network: nothing is sent to a real network and no key is
 * needed.
 *
 * A legacy v3 hands on an NFT by moving it from the owner's wallet to the
 * beneficiary at claim time, through LegacyPullVaultV2. A collection whose
 * contract refuses that move would leave a named NFT unclaimable, so each
 * candidate is walked through the whole path with one of its real tokens:
 *
 *   1. what the contract is: code, name, ERC-165 answers, an EIP-1967 proxy
 *      behind it or not, an owner and a pause switch if it has them;
 *   2. the list's admin adds it (`addCollection`), and the list records the
 *      kind the contract announces;
 *   3. a current holder gives one token to a fresh wallet (the collection's
 *      own transfer, between two ordinary addresses);
 *   4. that wallet creates a legacy v3 through the router, approves the
 *      vault as operator and names the token for a beneficiary;
 *   5. after the trigger the beneficiary claims, and the token is theirs.
 *
 * Read the source as well (Sourcify or Etherscan) for a transfer hook, a
 * pause, a block list or an operator filter: this run shows that a claim
 * works today, the source shows who could stop it tomorrow.
 *
 * Env (hardhat run forwards no CLI args):
 *   VET_COLLECTIONS = comma list of collection addresses (ERC-721)
 *   VET_ADMIN       = an admin of the list (impersonated on the fork)
 *   VET_NETWORK     = mainnet | sepolia                 (default mainnet)
 *   VET_TOKENS      = optional comma list of `collection:tokenId`, when the
 *                     first ids of a collection are not the ones to try
 *
 * PowerShell:
 *   $env:VET_COLLECTIONS='0x…,0x…'; $env:VET_ADMIN='0x…'
 *   npx hardhat run scripts/vet-nft-collections.ts
 *
 * ERC-1155 collections are added and described but not walked: the smoke of
 * the train covers that kind with a mock (smoke-train-2026-11-b.ts, leg 2).
 */
import { BigNumber, Contract, Wallet } from "ethers";
import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts } from "./utils";

dotenv.config();

// ethers v5 at runtime; the installed typings describe v6 (as in the other scripts).
const provider = ethers.provider as any;
const rpc = (method: string, params: unknown[] = []) => network.provider.request({ method, params });
const ZERO = ethers.constants.AddressZero;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const NFT_ABI = [
  "function name() view returns (string)",
  "function supportsInterface(bytes4) view returns (bool)",
  "function ownerOf(uint256) view returns (address)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function transferFrom(address,address,uint256)",
  "function setApprovalForAll(address,bool)",
];

async function main() {
  if (network.name !== "hardhat") throw new Error("Vetting runs on the in-process hardhat network only (no --network).");
  const net = (process.env.VET_NETWORK ?? "mainnet").toLowerCase();
  const url = net === "mainnet" ? process.env.MAINNET_RPC_URL : net === "sepolia" ? process.env.SEPOLIA_RPC_URL : undefined;
  if (!url) throw new Error(`Set ${net === "sepolia" ? "SEPOLIA_RPC_URL" : "MAINNET_RPC_URL"} in .env (VET_NETWORK is mainnet or sepolia).`);
  const collections = (process.env.VET_COLLECTIONS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ethers.utils.getAddress(s)); // a mixed-case address must carry its checksum: the guard against a typo
  if (collections.length === 0) throw new Error("Set VET_COLLECTIONS (comma list of collection addresses).");
  if (!process.env.VET_ADMIN) throw new Error("Set VET_ADMIN (an admin of the collection list; impersonated on the fork).");
  const adminAddr = ethers.utils.getAddress(process.env.VET_ADMIN);
  const picks: Record<string, BigNumber> = {};
  for (const spec of (process.env.VET_TOKENS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [c, id] = spec.split(":");
    picks[ethers.utils.getAddress(c)] = BigNumber.from(id);
  }
  const book: any = (getContracts() as any)[net];
  if (!book?.TransferEOALegacyRouter?.address) throw new Error(`No TransferEOALegacyRouter recorded for ${net}.`);

  await rpc("hardhat_reset", [{ forking: { jsonRpcUrl: url } }]);
  const forkBlock = await provider.getBlock("latest");
  console.log(`Fork of ${net} at block ${forkBlock.number} (${new Date(forkBlock.timestamp * 1000).toISOString()}). Nothing here reaches ${net}.`);
  await rpc("evm_mine");

  const fund = async (who: string) => rpc("hardhat_setBalance", [who, "0x8ac7230489e80000"]); // 10 ETH, on the fork only
  const as = async (who: string) => {
    await rpc("hardhat_impersonateAccount", [who]);
    await fund(who);
    return provider.getSigner(who);
  };
  const base: BigNumber = (await provider.getBlock("latest")).baseFeePerGas ?? BigNumber.from(0);
  const overrides = { gasPrice: base.mul(2).add(1) };
  const send = async (c: Contract, method: string, args: unknown[]) => {
    const estimate: BigNumber = await c.estimateGas[method](...args, overrides);
    const tx = await c[method](...args, { ...overrides, gasLimit: estimate.mul(13).div(10) });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`${method} reverted`);
    return rc;
  };

  // ── What the network runs ───────────────────────────────────────────────
  const router = await ethers.getContractAt("TransferEOALegacyRouter", book.TransferEOALegacyRouter.address);
  const implAddr: string = await router.legacyImplementation();
  const vaultAddr: string = await router.pullVault();
  const v3impl = await ethers.getContractAt("TransferEOALegacyV3", implAddr);
  const listAddr: string = await v3impl.nftAllowlist();
  const recorded: string | undefined = book.NftCollectionWhiteList?.address;
  console.log(`Router ${router.address} creates clones of ${implAddr}; their NFT list is ${listAddr}, their vault ${vaultAddr}.`);
  if (!recorded || recorded.toLowerCase() !== listAddr.toLowerCase()) {
    throw new Error(`The list in the implementation's code (${listAddr}) is not the recorded NftCollectionWhiteList (${recorded}).`);
  }
  const admin = await as(adminAddr);
  const list = await ethers.getContractAt("NftCollectionWhiteList", listAddr, admin);
  if (!(await list.hasRole(await list.DEFAULT_ADMIN_ROLE(), adminAddr))) throw new Error(`${adminAddr} is not an admin of the list.`);
  const verifier = await ethers.getContractAt("EIP712LegacyVerifier", book.EIP712LegacyVerifier.address);
  const payment = await ethers.getContractAt("Payment", await router.paymentContract());
  const feeBps: BigNumber = await payment.getFee();

  // ── 1 and 2: what each contract is, and the list's answer ───────────────
  type Row = { address: string; name: string; kind: number; tokenId?: BigNumber; holder?: string; result: string; ok: boolean };
  const rows: Row[] = [];
  for (const address of collections) {
    const c = new Contract(address, NFT_ABI, provider);
    const quiet = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await call();
      } catch (e: any) {
        // No such function, or it reverts: that is an answer. Anything else (the
        // fork's upstream: a rate limit, a timeout) is not, and must not print as "no owner()".
        if (e?.code === "CALL_EXCEPTION" || /revert|invalid opcode|not recognized|out of gas/i.test(String(e?.message))) return undefined;
        throw e;
      }
    };
    const code: string = await provider.getCode(address);
    const name: string = ((await quiet(() => c.name())) as string | undefined) ?? "(no name)";
    const is721 = await quiet(() => c.supportsInterface("0x80ac58cd"));
    const is1155 = await quiet(() => c.supportsInterface("0xd9b67a26"));
    const slot: string = await provider.getStorageAt(address, IMPL_SLOT);
    const beacon: string = await provider.getStorageAt(address, BEACON_SLOT);
    const proxy = !/^0x0+$/.test(slot)
      ? `EIP-1967 PROXY of 0x${slot.slice(26)}: its rules can change`
      : !/^0x0+$/.test(beacon)
      ? `EIP-1967 BEACON PROXY (beacon 0x${beacon.slice(26)}): its rules can change`
      : /^0x363d3d373d3d3d363d73[0-9a-f]{40}5af43d82803e903d91602b57fd5bf3$/i.test(code)
      ? `EIP-1167 clone of 0x${code.slice(22, 62)}: read that contract's source`
      : "no proxy (EIP-1967 slots empty, not an EIP-1167 clone)";
    const owner = await quiet(() => c.owner());
    const paused = await quiet(() => c.paused());
    const ownerNote =
      owner === undefined
        ? "no owner()"
        : owner === ZERO
        ? "owner renounced"
        : `owner ${owner} (${(await provider.getCode(owner)) === "0x" ? "a single key" : "a contract"})`;
    console.log(`\n${name}  ${address}`);
    console.log(`  code ${(code.length - 2) / 2} bytes, ${proxy}; ERC-721 ${is721 ?? "no answer"}, ERC-1155 ${is1155 ?? "no answer"}`);
    console.log(`  ${ownerNote}; ${paused === undefined ? "no paused()" : `paused() ${paused}`}`);
    const row: Row = { address, name, kind: 0, result: "", ok: false };
    rows.push(row);
    try {
      const before: number = await list.kindOf(address);
      if (before === 0) {
        const rc = await send(list, "addCollection", [address]);
        console.log(`  addCollection: accepted, ${rc.gasUsed.toString()} gas`);
      } else console.log("  already on the list");
      row.kind = await list.kindOf(address);
      console.log(`  the list records kind ${row.kind} (${row.kind === 1 ? "ERC-721" : row.kind === 2 ? "ERC-1155" : "none"})`);
    } catch (e: any) {
      row.result = `the list refuses it: ${String(e?.reason ?? e?.message ?? e).slice(0, 160)}`;
      console.log(`  ${row.result}`);
    }
  }

  // ── 3: one real token of each ERC-721 collection, into a fresh wallet ───
  const owner1 = Wallet.createRandom().connect(provider);
  const heir = Wallet.createRandom().connect(provider);
  await fund(owner1.address);
  await fund(heir.address);
  console.log(`\nFresh wallets: owner ${owner1.address}, beneficiary ${heir.address}`);
  for (const row of rows) {
    if (row.kind !== 1) {
      if (row.kind === 2) row.result = "ERC-1155: added and described, not walked";
      continue;
    }
    const c = new Contract(row.address, NFT_ABI, provider);
    const ids = picks[row.address] ? [picks[row.address]] : Array.from({ length: 40 }, (_, i) => BigNumber.from(i + 1));
    for (const id of ids) {
      let holder: string;
      try {
        holder = await c.ownerOf(id);
      } catch {
        continue;
      }
      // An ordinary address: a marketplace or staking contract would say less about a holder's own transfer.
      if (holder === ZERO || (await provider.getCode(holder)) !== "0x") continue;
      try {
        await send(c.connect(await as(holder)), "transferFrom", [holder, owner1.address, id]);
        if ((await c.ownerOf(id)) !== owner1.address) throw new Error("ownerOf did not change");
        row.tokenId = id;
        row.holder = holder;
        console.log(`  ${row.name} #${id.toString()}: its holder ${holder} gave it to the fresh owner`);
        break;
      } catch (e: any) {
        console.log(`  ${row.name} #${id.toString()}: the holder's transfer failed (${String(e?.reason ?? e?.message ?? e).slice(0, 120)})`);
      }
    }
    if (!row.tokenId) {
      row.result = picks[row.address]
        ? "the token named in VET_TOKENS could not be moved from an ordinary holder to a fresh wallet"
        : "none of the ids 1 to 40 is held by an ordinary address: name one with VET_TOKENS";
    }
  }

  // ── 4: one legacy v3 that names them all ────────────────────────────────
  const walked = rows.filter((r) => r.tokenId);
  if (walked.length > 0) {
    const ts: number = (await provider.getBlock("latest")).timestamp;
    const sig = await owner1.signMessage(await verifier.generateVersionedMessage(ts));
    const zero = { user: ZERO, percent: 0 };
    const rc = await send(router.connect(owner1), "createLegacyV2WithMaxFee", [
      [{ user: heir.address, percent: 1_000_000 }],
      { lackOfOutgoingTxRange: 60, delayLayer2: 0, delayLayer3: 0 },
      zero,
      zero,
      { permitBatch: { details: [], spender: ZERO, sigDeadline: 0 }, signature: "0x" },
      ts,
      sig,
      feeBps,
    ]);
    const created = rc.logs
      .filter((l: any) => l.address.toLowerCase() === router.address.toLowerCase())
      .map((l: any) => {
        try {
          return router.interface.parseLog(l);
        } catch {
          return undefined;
        }
      })
      .find((p: any) => p && p.name === "TransferEOALegacyCreatedV2");
    if (!created) throw new Error("No TransferEOALegacyCreatedV2 in the create receipt.");
    const legacy = await ethers.getContractAt("TransferEOALegacyV3", created.args.legacyAddress);
    console.log(`\nLegacy v3 #${created.args.legacyId.toString()} at ${legacy.address}, owned by the fresh owner`);
    for (const row of walked) {
      const c = new Contract(row.address, NFT_ABI, owner1);
      const approve = await send(c, "setApprovalForAll", [vaultAddr, true]);
      console.log(`  ${row.name}: vault approved as operator, ${approve.gasUsed.toString()} gas`);
    }
    const named = await send(legacy.connect(owner1), "setNftItems", [
      walked.map((r) => ({ collection: r.address, kind: 1, tokenId: r.tokenId, amount: 1, beneficiary: heir.address })),
    ]);
    console.log(`  setNftItems with ${walked.length} item(s): ${named.gasUsed.toString()} gas`);

    // ── 5: the claim ──────────────────────────────────────────────────────
    const deadline: number = ((await legacy.getTriggerActivationTimestamp())[0] as BigNumber).toNumber();
    await rpc("evm_setNextBlockTimestamp", [deadline + 2]);
    await rpc("evm_mine");
    const claim = await send(legacy.connect(heir), "claimNfts", [walked.map((_, i) => i)]);
    console.log(`  claimNfts for ${walked.length} item(s): ${claim.gasUsed.toString()} gas`);
    for (const [i, row] of walked.entries()) {
      const c = new Contract(row.address, NFT_ABI, provider);
      const now: string = await c.ownerOf(row.tokenId);
      const [, moved] = await legacy.nftItem(i);
      row.ok = now === heir.address && moved.eq(1);
      row.result = row.ok
        ? `#${row.tokenId!.toString()} named, claimed through the vault, now the beneficiary's`
        : `#${row.tokenId!.toString()} did NOT reach the beneficiary (owner ${now}, moved ${moved.toString()})`;
    }
  }

  console.log("\nResult:");
  let failed = 0;
  for (const row of rows) {
    const status = row.ok ? "PASS" : row.kind === 2 ? "SKIP" : "FAIL";
    if (status === "FAIL") failed++;
    console.log(`  ${status} ${row.name} ${row.address}: ${row.result}`);
  }
  console.log(
    failed ? `\n${failed} collection(s) failed. Nothing was sent to ${net}.` : `\nAll walked collections passed. Nothing was sent to ${net}.`
  );
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

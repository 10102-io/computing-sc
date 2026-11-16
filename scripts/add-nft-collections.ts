/**
 * Adds collections to NftCollectionWhiteList, the list a legacy v3 names
 * NFTs from. Vet them first on a fork (scripts/vet-nft-collections.ts): a
 * collection whose contract refuses the claim-time move would leave a named
 * NFT unclaimable.
 *
 * The same call is behind the admin panel's "NFT Allow List" page; this
 * script is for a session that already holds the deployer key. A collection
 * already on the list is skipped, and each address is simulated before it is
 * sent, so the script can simply be run again when a provider error stops
 * it between two collections. Removing one later (`removeCollection`) stops
 * new naming only: an NFT already named stays claimable, but its owner
 * cannot save it again (a new save of the NFT list, or a change of heirs,
 * drops it). The record of what is on the mainnet list and why:
 * docs/security/nft-collections.md.
 *
 * Env (hardhat run forwards no CLI args):
 *   NFT_COLLECTIONS = comma list of collection addresses
 *
 * PowerShell:
 *   $env:NFT_COLLECTIONS='0x…,0x…'
 *   npx hardhat run scripts/add-nft-collections.ts --network mainnet
 *
 * Requires DEPLOYER_PRIVATE_KEY (an admin of the list) in .env.
 */
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

async function main() {
  const network = hre.network.name;
  const [deployer] = await ethers.getSigners();
  const book: any = (getContracts() as any)[network];
  const recorded: string | undefined = book?.NftCollectionWhiteList?.address;
  if (!recorded || !book?.TransferEOALegacyRouter?.address) throw new Error(`No NftCollectionWhiteList or router recorded for "${network}".`);
  const collections = (process.env.NFT_COLLECTIONS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ethers.utils.getAddress(s)); // a mixed-case address must carry its checksum: the guard against a typo
  if (collections.length === 0) throw new Error("Set NFT_COLLECTIONS (comma list of collection addresses).");

  // The list that counts is the one in the code of the clones the router creates.
  const router = await ethers.getContractAt("TransferEOALegacyRouter", book.TransferEOALegacyRouter.address);
  const impl = await ethers.getContractAt("TransferEOALegacyV3", await router.legacyImplementation());
  const live: string = await impl.nftAllowlist();
  if (live.toLowerCase() !== recorded.toLowerCase()) {
    throw new Error(`New legacies read the list ${live}, not the recorded ${recorded}. Nothing sent.`);
  }
  // ethers v5 at runtime; the installed typings describe v6 (as in the other scripts).
  const list = await ethers.getContractAt("NftCollectionWhiteList", recorded, deployer as any);
  console.log(`Network:  ${network}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`List:     ${recorded}, ${(await list.getCollections()).length} collection(s) before`);
  if (!(await list.hasRole(await list.DEFAULT_ADMIN_ROLE(), deployer.address)))
    throw new Error("The deployer is not an admin of the list. Nothing sent.");

  for (const collection of collections) {
    if ((await list.kindOf(collection)) !== 0) {
      console.log(`\n${collection}: already on the list, skipped`);
      continue;
    }
    // Throws on any revert, also one without data, before anything is sent. (A static call would not: ethers v5
    // reads a revert without data as success for a function that returns nothing.)
    await list.estimateGas.addCollection(collection);
    const tx = await list.addCollection(collection);
    console.log(`\n${collection}: addCollection tx ${tx.hash}`);
    const receipt = await tx.wait(1);
    // A node behind the receipt's block can still answer 0: ask again before calling it a failure.
    let kind: number = await list.kindOf(collection);
    for (let i = 0; kind === 0 && i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      kind = await list.kindOf(collection);
    }
    console.log(
      `  block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()}, recorded as ${
        kind === 1 ? "ERC-721" : kind === 2 ? "ERC-1155" : `kind ${kind}`
      }`
    );
    if (kind === 0) throw new Error("The list does not show the collection after the transaction.");
  }
  const after: string[] = await list.getCollections();
  console.log(`\nThe list now holds ${after.length} collection(s):`);
  after.forEach((c) => console.log(`  ${c}`));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

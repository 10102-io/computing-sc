# NFT collections on the list

`NftCollectionWhiteList` is the list a legacy v3 names NFTs from. A
collection is checked against the list when an owner names an item, never
at claim time, so removing a collection later stops new naming only: what
was already named stays claimable. The list on mainnet is
`0xF33e887c6BE3bA8Fb583E14164a9e74FD56c1623`; its admins are the deployer
and the governance Safe.

Being on the list says one thing: an NFT of that collection, named in a
legacy, could be moved to its beneficiary at claim time when we checked.
It is no endorsement and no valuation, and the terms say so (v2026-12,
"Legacy Risks").

## What is checked before a collection is added

`scripts/vet-nft-collections.ts` runs on a local fork of mainnet (no key,
nothing is sent). For each collection it:

1. describes the contract: code present, ERC-165 answer for ERC-721 and
   ERC-1155, whether it is an EIP-1967 proxy, its `owner()` and `paused()`
   where they exist;
2. adds it to the list as the list's admin (impersonated), which is the
   same ERC-165 probe the real transaction makes;
3. takes one real token from an ordinary holder into a fresh wallet;
4. creates a legacy v3 through the router as that wallet, approves the
   vault as operator, names the token (`setNftItems`), lets the deadline
   pass and claims (`claimNfts`);
5. passes only when `ownerOf` then answers the beneficiary.

An ERC-1155 collection is described and added but not walked: its walk has
to be written before the first one goes on the mainnet list.

The source is read too (Sourcify, verified), for what a walk cannot show:
who can pause or block transfers, and whether the code can change.

## The list on mainnet

Added on 2026-11-16 (founder's choice: the three largest by market value
that the list accepts), from the deployer key, with
`scripts/add-nft-collections.ts`.

| Collection | Address | Added in | What the source says |
|---|---|---|---|
| CryptoPunks 721 (the ERC-721 wrapper for CryptoPunks) | `0x000000000000003607fce1aC9e043a86675C5C2F` | `0xb6043af0c04d856ad96bb81ef4dd11d879aa30779e6c360e97386ff4d13144eb`, block 26429835 | No owner, no pause, no proxy, no transfer restriction. 302 punks were wrapped in it on the day. |
| Bored Ape Yacht Club | `0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D` | `0xd586d9cedee777df3c0c645c1b2069dd026cbba21b150e3da358cfebccf202f0`, block 26429841 | Ownership renounced, no pause, no proxy. |
| Pudgy Penguins | `0xBd3531dA5CF5857e7CfAA92426877b022e612cf8` | `0xfc847a44080f3dea0d7dce2425a4dfd44cdd998408efa06a205256349a72dc58`, block 26429842 | `ERC721Pausable`: its owner, a single key (`0xf54c9A0E44a5F5aFd27C7aC8a176A843b9114F1d`), can pause every transfer. Not paused on the day. No proxy. |

The walk of 2026-11-16 (fork of mainnet at block 26429682; the script's
output is `nft-collections-walk-2026-11-16.txt` beside this file, holders
shortened): CryptoPunks 721
#6096, Bored Ape Yacht Club #1 and Pudgy Penguins #1 were named in one
legacy v3 and claimed through `LegacyPullVaultV2`; each ended with the
beneficiary. Gas on the fork, and the same on mainnet for the three adds:
`addCollection` 118,279 / 103,488 / 101,723; an operator approval about
46,000 per collection; `setNftItems` for three items 379,485; `claimNfts`
for three items 377,747.

## What to know about these three

- **CryptoPunks.** The original 2017 contract
  (`0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB`) is not ERC-721 and the list
  refuses it (`NotAnNftCollection`). Only a punk wrapped in CryptoPunks 721
  can be named. The older wrapper, Wrapped Cryptopunks
  (`0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6`, 363 punks on the day), is
  not on the list. An owner who unwraps a named punk no longer holds the
  token the legacy names: nothing moves at claim time for that item.
- **Pudgy Penguins.** While the collection is paused, a named penguin
  cannot move: a claim skips it (a claim that would move nothing at all
  reverts `NothingClaimed` and does not activate the legacy) and it stays
  owed. After the pause it can be claimed by its heir, or by whoever may
  take unclaimed items by then: the heir's backup in its window, the
  second or third line in its period. Nobody at 10102 can lift that pause.
- **Every collection.** The NFT stays in the owner's wallet until the
  claim. It moves only if the wallet still holds it and the approval for
  the vault still stands then.

## Adding or removing a collection

1. Vet: `$env:VET_COLLECTIONS='0x…'; $env:VET_ADMIN='<an admin of the list>'; npx hardhat run scripts/vet-nft-collections.ts`
   (in-process network, forks mainnet; the admin is impersonated, the
   deployer `0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630` is one). When no token id from 1 to 40 is
   held by an ordinary address, name one: `$env:VET_TOKENS='0x…:1234'`.
   Read the source for pause, block lists, transfer hooks and upgrades.
2. Add: `$env:NFT_COLLECTIONS='0x…'; npx hardhat run scripts/add-nft-collections.ts --network mainnet`
   (deployer key), or the admin panel's "NFT Allow List" page, or the Safe.
   The script simulates each add first and skips what is already listed,
   so it can be run again after a provider error.
3. Record it in the table above and in `CHANGELOG.md`.

`removeCollection` (an admin) stops new naming of that collection. It does
not touch items already named: they stay claimable. But an owner cannot
save such an item again: saving the NFT list, or changing heirs or shares
(which clears it), drops an item of a removed collection for good. Use it
when a collection's contract turns hostile to transfers or its code
changes; then tell the owners who named items of it, and say that too.

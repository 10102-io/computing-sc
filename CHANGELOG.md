# Changelog — 10102 Computing (contracts)

This file is the canonical, human-readable narrative of what each release
of the smart-contract repo actually **ships on-chain**. `main` is a
fast-forward of `dev` marked by a CalVer tag; the prose here is where
the headline story lives.

## How this file is maintained

- One entry per tagged release, plus a separate entry
  per **mainnet deploy/upgrade event** if the deploy happens ahead of the
  main-branch release (as with the EIP-1167 cutover below — mainnet was
  cut over from `dev`, the main-branch release follows).
- Headline first — the on-chain behavior or cost change that matters,
  not the file list.
- Entries are **drafted by the release agent, sent to the maintainer for
  sign-off, and only then** committed along with the release. If a
  release underweights its headline, fix it here rather than rewriting
  history on `main`.
- Cross-repo: frontend-side changes get their own entries in
  [`computing/CHANGELOG.md`](../computing/CHANGELOG.md). This file only
  records what lands in the **contracts** repo and on-chain.

## 2026-11-23 — The first version 2 guard on mainnet, verified

[No contract or on-chain change of ours: the legacy is the founder's own
create through the app.]

- **The first Safe legacy with a version 2 guard exists on mainnet**
  since 22:13:47 UTC (block 26480751, legacy 4 on the router), set up
  by its Safe two minutes later. Its guard
  `0x7794c2428D86c7C1b15B9a90789D27C55cb27ec4` and its contract
  `0x14DB2dD5AA7F83e929C72Aa1b383113aC8a6ea9A` are exact matches on
  Sourcify and verified on Etherscan, from the compiler input of the
  build of 2026-11-19; so is Sepolia's first pair. The code at all four
  addresses is that build's, byte for byte. On the chain the guard
  reads version 2, the nonce it noted is the Safe's, it is the Safe's
  transaction guard and module guard, and the router answers "not yet".
  This closes what the entry of 2026-11-21 left open.
- **`scripts/check-impl-code.ts` gives two passing answers**: "byte for
  byte", or "the same code, other metadata" when only the hashes over
  the source text differ. It failed `LegacyDeployer` today, on live
  code that had not changed: `SafeGuard.sol` went into the build of
  2026-11-19 with six line endings unlike the rest of the file, the
  checkout writes them alike since, and the deployer carries the
  guard's code with that hash in it. A checkout with LF line endings
  (CI, any machine but Windows) has other hashes throughout, for the
  same reason. Code that differs in anything that runs still fails.
- **`scripts/verify-etherscan-status.ts` checks every contract in
  `contract-addresses.json`**, and the chain says which of them is a
  proxy. It went by a fixed list of names, and `LegacyDeployer`, one of
  the two contracts upgraded on 2026-11-21, was not on it. Mainnet: 29
  contracts, each verified, each proxy record at its live
  implementation, `LegacyDeployer` included. The script exits 1 now
  when something is unverified or a proxy record is stale.
- **Sepolia: two implementations had no published source**
  (`PremiumMailBeforeActivation`, `PremiumMailActivated`). Both are
  verified on Etherscan and exact matches on Sourcify now, from the
  compiler input in `deployments/sepolia/solcInputs/`, so the check
  passes on both networks.
- **`sync-ui` writes the app's Safe router ABI typed** (`as const`), so
  the app's calls to that router are checked against the live ABI when
  the app builds. The app's calls used a hand-kept ABI until today.

## 2026-11-21 — The Safe legacy fix is live on mainnet

[Released in v2026.11.21. Two implementations behind their proxies: no
storage, event or address change, two new errors on the router. Not
independently audited: three internal reviews, a spec on the Safe's
mainnet bytecode, 27 planted bugs, fork walks of both networks before
and after. The change itself is the entry of 2026-11-19 below; the whole
record is `docs/plans/safe-legacy-guard-2026-11.md`.]

- **The Safe legacy router runs
  `0x062195561F4892F9AC472714c28515553D2FA14F` and `LegacyDeployer`
  `0xb7744Fd8Cc4728515aCE415dDc51d9244b9E89bA`.** The operation
  scheduled on 2026-11-19
  (`0x10f2ba1f0446ba6c6c16c99eb7fc8881bd1ffe6949b925303a4577ee1fc10cb4`)
  executed on 2026-11-21 23:05:23 UTC in block 26466652
  (`0xd0eac00d1266de13751bc5523631245ba33b24d2dddf649516e8b6751003acf1`,
  75,725 gas as rehearsed, about 0.00001 ETH), five minutes after it
  became executable.
- **From that block** a Safe legacy created on mainnet gets guard
  version 2, whose clock moves only with the Safe's own transactions,
  and the router activates a Safe legacy only while it is set up on its
  Safe and its guard has seen the Safe's last transaction.
- **Legacies created before keep their version 1 guard** until their
  owners delete them and create them again. Three exist on mainnet, all
  three the founder's own from testing: two are off their Safe, and one
  stays set up on a test Safe that holds nothing. Nothing changed in
  what can be activated for any of them.
- **The app and the worker changed over by themselves**: both read from
  the chain which router answers. The app took one file with this
  release, the router's ABI with the two new errors, which it already
  answered by their signatures.
- Rehearsed once more on a fork of mainnet before the execution (two of
  45 values change, the two implementations). After it: the artifacts
  and `contract-addresses.json` name the new implementations
  (`refresh-impl-artifacts.ts`), `verify-governance.ts` passes 34 of 34
  with no operation left in the timelock, the router's new source is
  verified on Etherscan, and `scripts/rehearse-safe-guard.ts` passes on
  a fork taken after the execution, on the live implementations: every
  getter, record and storage slot reads the same, each existing legacy
  answers as before, a new Safe of each version (1.3.0, 1.4.1, 1.5.0)
  goes from creation to activation through every refusal on the way,
  and wallet legacies are created and claimed through the new deployer.
- **Still open:** the first version 2 guard on mainnet is verified on
  Etherscan and Sourcify once a Safe legacy is created there (done
  2026-11-23, entry above).

## 2026-11-19 — Safe legacies: a clock only the Safe moves, scheduled on mainnet

[Released in v2026.11.21, after the mainnet execution (entry above).
Live on Sepolia since 2026-11-19 22:41 UTC. On mainnet the two
implementations were deployed that day and the upgrade scheduled,
executable from 2026-11-21 23:00:23 UTC, operation
`0x10f2ba1f0446ba6c6c16c99eb7fc8881bd1ffe6949b925303a4577ee1fc10cb4`.
Live on mainnet since that day: `LegacyDeployer` is owned by the
UpgradeTimelock. Not independently audited: three internal reviews, a
spec on the Safe's mainnet bytecode, 27 planted bugs, fork walks of both
networks. The whole record is `docs/plans/safe-legacy-guard-2026-11.md`.]

- **What was wrong.** A Safe legacy's guard keeps the time of the Safe's
  last transaction, and the legacy can be activated when that time is
  old enough. Version 1 of the guard also counted a call from any address
  that carried signatures over the Safe's previous transaction, and its
  copy of the Safe's signature check never asked whether the signers
  were owners. Anyone could move the clock and keep a Safe legacy from
  ever activating. Nothing could be activated early and nothing could be
  moved. Second, the router activated on the guard's time alone: a Safe
  that took the guard off and left the legacy enabled had a stopped
  clock, and its beneficiaries could be added as owners while the Safe
  was in daily use. No legacy on mainnet is in that state.
- **Guard version 2, for legacies created after the upgrade.** The clock
  moves when the Safe calls a hook (on Safe 1.5.0 also for a module's
  transaction, once the guard is set as the module guard), or when anyone
  calls `sync()` while the Safe's nonce shows a transaction the guard did
  not see; then the wait starts again. No hook reverts, so the guard
  cannot block a Safe.
- **The router's rules reach every Safe legacy, also those that exist,
  at the execution.** `activeLegacy` goes through only while the legacy
  is set up on its Safe (its guard is the Safe's guard, the legacy an
  enabled module) and the guard has seen the Safe's last transaction;
  `checkActiveLegacy` answers `false` wherever `activeLegacy` reverts,
  also for a legacy that was activated; the setters take calls from the
  legacy's own Safe only (a contract that answered like a Safe could
  rename a legacy before). Two new errors, `GuardBehindSafeWallet()` and
  `SenderIsNotSafeWalletOfLegacy()`; no event, storage or address change.
  For the three Safe legacies on mainnet nothing changes in what can be
  activated (walked on a fork).
- **A legacy created before the upgrade keeps its version 1 guard**,
  because a guard cannot be upgraded. Its owners delete it and create it
  again to get version 2. Three on mainnet that day: one off its Safe
  already and two set up, all three the founder's own from testing.
- **A new legacy** skips a beneficiary who is an owner of the Safe
  already (the Safe's refusal used to fail the activation for everyone)
  and refuses `address(1)` as a beneficiary.
- **`LegacyDeployer`** serves the three routers only: its owner no longer
  passes `onlyRouter`, its implementation cannot be initialised, and the
  owner is the UpgradeTimelock on both networks (mainnet
  `0x1e476cf4d2dc27f951fe97b6ad88660a2ae97c5f626de83969a63c5ab89817d9`).
  `verify-governance.ts` checks it: 34 of 34 on mainnet.
- **Mainnet, deployed and verified:** `LegacyDeployer` implementation
  `0xb7744Fd8Cc4728515aCE415dDc51d9244b9E89bA`, `MultisigLegacyRouter`
  implementation `0x062195561F4892F9AC472714c28515553D2FA14F`, the same
  code as on Sepolia and as a clean build of this commit
  (`scripts/check-impl-code.ts`). Scheduled through the Safe in
  `0xc4d19159244662ab7c059157aa457574363218ffb2ec12ce5393e7b1e86df196`;
  rehearsed on a fork: two of 45 values change, the two implementations.
- **Evidence.** `test/SafeGuard.spec.ts`, 104 cases on the bytecode of
  Safe 1.3.0, 1.4.1 and 1.5.0 as deployed and on the version 1 guard's,
  among them a random walk against a model (two seeded runs of 60 steps
  per Safe version, every fact checked after every step);
  `scripts/mutations/safe-legacy.cjs`, 27 planted bugs, all caught, 17
  of them by the random walk alone; the whole suite, 603 passing;
  `scripts/rehearse-safe-guard.ts` on forks of both networks, on Sepolia
  also after the execution; Slither on the four contracts before and
  after, nothing new at Medium or above, every result triaged
  (`docs/security/static-analysis.md`) and the run repeated in CI as a
  report; the compiler checks of
  `docs/security/compiler-known-bugs.md` section 10, which also covers
  the two known bugs solc 0.8.39 added that day. Not done: a Foundry
  fuzz suite for these contracts.
- **Limits.** A Safe that is used only through a module looks idle to its
  legacy on Safe 1.3.0 and 1.4.1. A guard that is behind its Safe waits
  for someone to call `sync()`. The four routers of 2024 are not
  upgradeable; they hold one legacy between them, and it is off its
  Safe.
- **Around the contracts** (`computing`, released the same day; the
  set-up in three calls was live before the Sepolia execution): the app
  sets a legacy up in three calls so that the guard is never behind,
  four on Safe 1.5.0, where the guard also counts what a module does; it
  says why a legacy cannot be activated, on the cards too; it tells the
  owners of a legacy on a version 1 guard how to get version 2, from the
  moment a network creates them; and the worker holds the reminder
  emails of a Safe legacy that cannot be activated. The app and the
  worker read from the chain which router answers, so mainnet changes
  over when the upgrade executes, without a release.

## 2026-11-18 — The router's create-flag fix is live on mainnet

[Released in v2026.11.18. One router implementation: no storage, ABI,
event or address change, and no legacy or vault is touched. Not
independently audited: two independent internal reviews, tests with
negative controls, tooling, a walk of every live legacy on forks of both
networks, and three rehearsals of this operation on a fork of mainnet.]

- **The wallet legacy router runs
  `0x4251A1EC6D88995d82D7b4397ef74867A8d3F8DC`.** The operation scheduled
  on 2026-11-16
  (`0x76e18d5f079960910c9d7d5889cebbc454a139690b4157261bcaa0341bbc5ad2`)
  executed on 2026-11-18 23:55:11 UTC in block 26445375
  (`0xc73e70f93160c030d4c21c15d5e3f1e5e919602493683ea5f38f9b5d072e84cd`,
  53,450 gas as rehearsed, about 0.00002 ETH), four minutes after it
  became executable. From that block only the claim that ends a legacy
  releases the owner's create flag; the entry of 2026-11-16 below has the
  change, its limits and the evidence.
- **Nothing changes for existing legacies**, the vaults or any address,
  and a claim, a check-in, a delete or a withdrawal works as before. The
  app needed no release for it: the interface is the same, and it keeps
  its own check against the vaults, because a flag that was cleared
  wrongly before the upgrade stays cleared.
- Rehearsed twice more on the day on a fork of mainnet
  (`scripts/rehearse-timelock-op.ts`, the second time at the network's
  head after the wait had ended): one of 56 values read changes, the
  router's implementation. After the execution: the artifacts and
  `contract-addresses.json` name the new implementation
  (`refresh-impl-artifacts.ts`), the deployment pointers agree with both
  chains, `npm run sync-ui:check` is green, `verify-governance.ts` passes
  31/31 with no operation left in the timelock, Etherscan's proxy record
  names the new implementation and its source is verified, and the smoke
  passes (5 of 5) on a fork of mainnet taken after the real execution.
- **The 2024 history can be checked on the chain** (README, "Project
  history & audits"). The first mainnet router of 2024-08-15, the first
  legacy created through it on 2024-08-19, and the three routers of
  2024-10-25 and 2024-10-27 are listed with their creation transactions
  and the commit each one's verified source equals, file for file:
  `a2f2ad9` for the first, `c969eb2` (the commit the first audit
  reviewed) for the October three. `node scripts/early-mainnet.mjs`
  repeats the checks with no key. The README no longer calls 2024-10-25
  the first mainnet deployment, and says the repository used before
  January 2026 is archived and kept private.
- **Clear signing needs no change** (checked 2026-11-19, after the
  release). The descriptor names the router's proxy, and the new
  implementation's ABI is the previous one's, fragment for fragment, so
  the rebuilt descriptors are byte for byte the ones here. The two
  submissions waiting at the registry (#3147, #3223) carry the same
  files. The tooling now names the new implementation
  (`erc7730/tooling/fetch-abis.mjs`).

## 2026-11-16 — Router: only the claim that ends a legacy releases the create flag

[Released in v2026.11.18. Live on Sepolia since 2026-11-16 23:34 UTC and
on mainnet since 2026-11-18 23:55 UTC (the entry above); on 2026-11-16
the mainnet implementation was deployed and the upgrade scheduled. One
router implementation: no storage, ABI, event or address change, and no
legacy or vault is touched. Not independently audited: two independent
internal reviews (the second after scheduling, with no finding above
Low), tests with negative controls, tooling, and a walk of every live
legacy on forks of both networks.]

- **What was wrong** (checklist audit RC-L). The wallet legacy router
  cleared `isCreateLegacy[owner]` on every claim, also on a later claim
  on a legacy that had ended before. An owner who had created a new
  legacy in between was forgotten, and the router would accept another
  create from that wallet. The pull vault refused it while the live
  legacy was bound in the router's current vault, and no funds moved
  differently. In the router since 2026-05-04, found on Sepolia with real
  transactions on 2026-11-11; the app has confirmed a false flag against
  the vaults since then.
- **The change.** Before the clone is called, the router asks it
  `isLive()` and releases the flag only when the legacy is live, which is
  when the claim about to run ends it (`_releaseCreateFlagBeforeClaim`,
  on `activeLegacy`, `activeLegacyFor` and `activeLegacyAndUnswap`). The
  read is a plain `staticcall`: a legacy that reverts, answers with less
  than one word or with anything but zero counts as live, so the read
  can never stand between a recipient and a claim. The flag is written
  before the clone call, so a failed claim reverts it, and a create made
  by an owner contract while the claim runs sets a flag that nothing
  clears afterwards. `releaseCreateFlag` now also reverts
  `LegacyStillActive` when the router's current vault holds a live legacy
  for the caller.
- **What it does not change.** A legacy v3 ended by `claimNfts` (the
  clone's own function) keeps the flag until its owner calls
  `releaseCreateFlag`, as before. The vault check sees the router's
  current vault only: a live legacy bound in an earlier vault, or created
  without one, is not seen there. A flag that was cleared wrongly before
  the upgrade stays cleared, so the app's vault check stays.
- **Evidence.** `test/RouterCreateFlag.spec.ts` (24 cases: the ending
  claim and a later claim over the three claim paths, a second-line
  ending claim, a legacy v3 with a backup line whose shares are claimed
  one by one, failed claims, an owner contract that creates inside the
  ending claim, four odd `isLive()` answers, the release cases); 17 of
  them fail on the router as it was. Full suite 499 passing, Foundry 39
  passing. Storage layout byte-identical. Runtime 23,631 bytes (945
  spare). Slither on the router: 46 results before, 45 after
  (`docs/security/static-analysis.md`). The walk
  (`scripts/rehearse-router-create-flag.ts`, forks, no key) claimed on
  every live legacy under the old and the new implementation, with a
  later claim, the owner's release, a delete and a second delete, and
  compared every getter and every owner's flag: mainnet 45 legacies (7
  live), Sepolia 65 (17 live), both passed, with the smoke.
- **Sepolia.** Implementation
  `0xa6c23ef73731f8C796bCbE299219D950B60c708d` (tx `0xdd03ad81…3abc`,
  verified). Scheduled through the Safe (id `0xd00c206c…092c`, tx
  `0xd7fcf18b…64d6`), rehearsed on a fork while it waited (one of 56
  values changes: the implementation), executed at 23:34:36 UTC in block
  12150602 (tx `0x09a5ad8c…e674`). Artifacts refreshed, the smoke with
  real transactions 5 of 5 (legacies #66 to #68), `verify-governance`
  30 of 30.
- **Mainnet.** Implementation
  `0x4251A1EC6D88995d82D7b4397ef74867A8d3F8DC` (tx `0x53db5714…915b`,
  block 26430982, verified on Etherscan; its runtime code is byte for
  byte the build, with the mainnet timelock as the immutable, and equals
  Sepolia's but for that address). Scheduled through the Safe as a plain
  `upgrade(proxy, implementation)` on `DefaultProxyAdmin`: id
  `0x76e18d5f079960910c9d7d5889cebbc454a139690b4157261bcaa0341bbc5ad2`,
  tx `0x8f9bebd6…9b4b`, block 26430994, executable from 2026-11-18
  23:50:59 UTC. Rehearsed on a fork of mainnet right after: the pending
  operation is the one in `docs/plans/batches/router-create-flag-mainnet.json`,
  it is refused before its time, it executes from an address with no
  role, and the implementation is the only value that changes; the smoke
  passes on the upgraded fork. Executed on 2026-11-18 (the entry above).
- **The second review** read the final diff after the upgrade was
  scheduled and found nothing above Low, and no reason to cancel. Its two
  Low findings on the contract are the limits named above (a legacy v3
  ended by `claimNfts`, and the vault check seeing the current vault
  only). The two things it could not check were read from mainnet
  afterwards: `upgradeTimelock()` on the new implementation is the
  mainnet timelock, and the pending operation id is the timelock's own
  hash of `upgrade(router proxy, 0x4251…F8DC)` on `DefaultProxyAdmin`
  with the batch file's salt.
- **Revert reasons in the specs are checked for real now.** The review's
  third finding was in the tests: each spec's `revertedWith` searched the
  whole error as JSON, and Hardhat's stack-trace frames carry the source
  text of every contract on the way, so a reason check passed for any
  error those sources declare and proved only that the call reverted. One
  shared helper (`test/utils/revert.ts`) now decides by the selector of
  the return data, or by the message for a reason string, and has its own
  spec (`test/RevertHelper.spec.ts`). Three expectations across the suite
  were wrong and are corrected, none in a contract: a stranger's claim is
  refused by the clone with `LayerInvalid()` before the router's
  `OnlyBeneficaries()` (two specs), and the cancelled check-in case
  signed a 30-day deadline, which the router refuses for the deadline
  before it looks at the nonce (it signs within the hour now and proves
  `InvalidSponsorNonce()`). Every other reason in the suite held.
- `rehearse-timelock-op.ts` now forks at the network's head. Left alone,
  Hardhat forks 128 blocks behind on Sepolia (about 26 minutes), which is
  older than an operation scheduled a moment before. `sync-ui:check` no
  longer reports the subgraph's zero-address placeholders for `localhost`
  as drift (they are the subgraph's own), so it is green again: the app's
  ABIs and addresses match, and nothing in the sibling repos pins the
  router's implementation.

## 2026-11-16 — First NFT collections on the mainnet list, terms v2026-12

[On-chain configuration only; no contract or bytecode change. Released in
v2026.11.16.]

- **Three collections are on the mainnet NFT list**
  (`0xF33e887c6BE3bA8Fb583E14164a9e74FD56c1623`), so a legacy v3 can name
  NFTs on mainnet: CryptoPunks 721, the ERC-721 wrapper for CryptoPunks
  (`0x000000000000003607fce1aC9e043a86675C5C2F`, tx `0xb6043af0…44eb`,
  block 26429835), Bored Ape Yacht Club
  (`0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D`, tx `0xd586d9ce…02f0`,
  block 26429841) and Pudgy Penguins
  (`0xBd3531dA5CF5857e7CfAA92426877b022e612cf8`, tx `0xfc847a44…dc58`,
  block 26429842), from the deployer key, read back from the chain. The
  founder chose the three largest by market value that the list accepts;
  the original CryptoPunks contract is not ERC-721 and the list refuses it.
- **Each was walked to a claim first**, on a fork of mainnet
  (`scripts/vet-nft-collections.ts`, no key): a real token of each
  collection in a fresh wallet, a legacy v3 created through the router,
  the vault approved, the token named, the deadline passed, the claim,
  and the token with the beneficiary at the end. The record, with what the
  source of each collection says and what an owner should know (a punk
  must be in that wrapper; Pudgy Penguins has an owner key that can pause
  transfers, and a paused item is skipped by a claim and stays owed until
  the pause ends): `docs/security/nft-collections.md`, with the walk's
  output beside it. `scripts/add-nft-collections.ts`
  sends the adds: it checks that the list is the one in the code of the
  clones the router creates, simulates each add and skips what is listed.
- **Terms v2026-12.** The EIP712LegacyVerifier's active terms move from
  `v2026-11` to **`v2026-12`** on mainnet and Sepolia (`setActiveTerms`,
  keccak256
  `0x51f85836971aaab3d0fd4c4fc6df98f107cfe5a17279bb48fc5c36860ba177a9` of
  `docs/tos/v2026-12.md`, 26,877 characters): Sepolia tx `0x3e74f6ed…832f`
  in block 12149534, mainnet tx `0x883c338a…7b3f` in block 26429833, both
  read back from the chain, after the app that publishes the new text
  (`app.10102.io/terms/current.json`) was live. The page the app's terms
  links open, `10102.io/disclosures`, still showed `v2026-11` then and
  needs a rebuild of the website (computing `docs/OPS-CHECKLIST.md` 0t):
  until then a consent is recorded against `v2026-12` while the linked
  page shows `v2026-11`. None was recorded on either network up to 20:36
  UTC (the verifier's and the routers' logs). `set-active-terms.ts` now
  checks both addresses before it sends, and sends nothing when either
  shows another version. The text adds a "Legacy Risks" section (backup beneficiaries, the
  executor's confirmation that nobody verifies, NFTs and their list, what
  a change resets, what a move to a new version does, no independent
  audit of the version in use since 2026-11-13), states the delivery fee
  as the contracts charge it (Shield Vault only on a release to the named
  people, a moved legacy at the rate of that day, none on NFTs for now),
  names the contracts of NFT collections among the third parties and adds
  a privacy line for saved names and the watch list kept across devices.
  Everything else is word for word `v2026-11`, apart from the Markdown
  markup, `©` for `(c)` and the form of the links.
- **The terms text is Markdown from this version on**
  (`docs/tos/v2026-12.md`, LF line endings pinned in `.gitattributes`):
  the website renders the very text the hash is of, instead of a plain
  snapshot of its own page. `scripts/set-active-terms.ts` can rehearse on
  a local fork as the verifier's owner with no key (`TERMS_FORK`); both
  networks were rehearsed before the real calls. Sepolia charged 161,680
  gas for the call that takes 64,960 on mainnet and on the forks; the
  result is the same.
- Status lines in the train plan, the checklist audit, the wave B review
  scope and the solc plan now say what happened: wave B executed on
  2026-11-13 without an external review (founder decision 2026-11-10,
  risk accepted), and that review is still open and not commissioned. The
  upgrade runbook has the rule the checklist audit asked for (L-2): an
  operation that will not run is cancelled the same day, never left in
  the queue.

## 2026-11-13 — Legacy v3 live on mainnet

[Released in v2026.11.16; live on mainnet before it. Not independently audited:
internal reviews, tooling, a Sepolia walk of the app with real
transactions and two rehearsals of this operation on a fork of mainnet.
The founder moved it ahead of the external review on 2026-11-10, risk
accepted.]

- **The router creates legacy v3 clones.** The batch scheduled on
  2026-11-11 executed on 2026-11-13 20:42 UTC
  (`0x98afe0b972519cc9ba1ca82d8824f0157d4e2160fc7548bf33b7448fa9e736e7`):
  the router runs `0x8F8971289e35adF8f9123BF142120D21109974eb` (the unswap
  guard only when something would convert), LegacyPullVaultV2 allows
  `TransferEOALegacyV3` `0xF9B6241Ab7513181C9Ed4F0920E0B008fB9264e9`, and
  that is what a new wallet legacy is: NFTs from the allow list, backup
  heirs per share, an executor, and a claim fee that reaches the treasury
  as the claimed token.
- **Nothing changes for existing legacies.** A clone pins its
  implementation and its vault: legacies created from 2026-11-07 keep the
  wave A clone `0x2E2dE6475fcBE77E7930499981850d37b237924C`, older ones
  theirs. An owner who wants v3 creates a new legacy.
- **The NFT allow list is empty** (`0xF33e887c6BE3bA8Fb583E14164a9e74FD56c1623`):
  no NFT can be named until collections are vetted and added.
- Rehearsed at the eta on a fork (`scripts/rehearse-timelock-op.ts`): two
  values change, the two above. After it: `verify-governance.ts` 31/31, the
  deployment pointers agree with both chains, and the wave B smoke passes
  (5 of 5) on a fork of mainnet taken after the real execution. For that,
  the rehearsal script runs a train's smoke alone once its operation has
  executed (`REHEARSE_SMOKE`).
- **CI:** Aderyn left the security workflow. Its maintainer retired it on
  2026-11-13 and withdrew the downloads; Slither still gates the same
  files, and Aderyn's last reports (2026-11-12, 0 High) are kept in
  `docs/security/aderyn-2026-11-12/`. A manual re-run of the workflow is
  no longer cancelled by its own concurrency rule.
- **Clear signing:** descriptors for Shield Vault v3 and for the legacy
  create with a claim fee bound are submitted to the registry
  (`erc7730/README.md`).

## 2026-11-12 — Known compiler bugs checked for every mainnet contract

[No contract or bytecode change.]

- `docs/security/compiler-known-bugs.md` assesses every known solc bug
  (the compiler team's list as of 0.8.38) against every contract of ours
  on mainnet, each rebuilt from source to the bytes on the chain. None is
  found to apply; the optimizer bug fixed in 0.8.38 is answered by an
  indication (identical bytecode before and after the fix for 40 of 41),
  not a proof. The checks are in `scripts/compiler-bugs/`.
- The clone implementations of April and May 2026 and the first 22 EOA
  legacies, which no verifier could match before, are verified on
  Sourcify and Etherscan.
- `scripts/rehearse-timelock-op.ts` rehearses a scheduled timelock
  operation on a local fork and prints every value its execution changes.

## 2026-11-11 — Shield Vault v3 on mainnet, legacy v3 scheduled

[Released in v2026.11.16; live on mainnet before it. Not independently audited:
internal reviews, tooling and a Sepolia walk of the app with real
transactions. The founder moved both ahead of the external review on
2026-11-10, risk accepted.]

- **Shield Vault v3** is deployed at
  `0x1610DC8D25475959D5ba9395c4CE02456B51EB59` (recorded as `ShieldVaultV3`;
  `ShieldVault` stays v2). A fee is taken only when a holding is released
  to the named people after the owner's silence: 0.25%, fixed when the
  holding opens, at most 0.5% for later holdings. Withdrawals, cancels,
  stops with the sheet and claims of a kept share pay none. Owner and fee
  recipient are the governance Safe from construction; wstETH, USDC, USDT
  and WETH. Not upgradeable; v2 holdings keep every exit where they are.
  The app opens new holdings in v3 since the same day, and the Safe paused
  deposits on v2 (mainnet `0x5fd6…06bc`, Sepolia `0xd1d1…4aef`); v2 held
  nothing on mainnet.
- **Legacy v3** (NFTs in a legacy, backup heirs, an executor) is deployed
  and waits in the UpgradeTimelock, executable from **2026-11-13 20:37
  UTC** (operation `0x7df5…d7e3`, scheduled from the Safe, `0xfd5a…8f57`):
  the router implementation `0x8F8971289e35adF8f9123BF142120D21109974eb`
  (the unswap guard only when something would convert; no reinitializer,
  storage untouched), `allowImplementation` on LegacyPullVaultV2 and
  `setLegacyImplementation` for `TransferEOALegacyV3`
  `0xF9B6241Ab7513181C9Ed4F0920E0B008fB9264e9`. Its NFT allow list is
  `0xF33e887c6BE3bA8Fb583E14164a9e74FD56c1623` (deployer admin for the
  list's upkeep, the Safe co-admin), empty until collections are vetted.
  Until execution new legacies are the wave A clone, and existing legacies
  keep their implementation forever either way.
- Sepolia runs both since 2026-11-10 (`docs/plans/train-2026-11.md`,
  execution log).

## 2026-11-07 — Contract train 2026-11: wave A live on mainnet

[Wave A executed on mainnet 2026-11-07 through the UpgradeTimelock
(`0x1868…cd8f`), on Sepolia 2026-11-05. Wave B (legacy v3) runs on Sepolia
since 2026-11-06 and reaches mainnet only after its external review.]

| Contract | Proxy | New implementation |
|---|---|---|
| `TransferEOALegacyRouter` | `0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b` | `0xe3d1bc20b92cd38D3C154F1B97A1A288b0e706A1` |
| `TimeLockRouter` | `0x2B947E3c348c81409f8e8fc5ef8F65d9dFf76A42` | `0x0d23dEeE5b316b1ac6b49C7f123489e8E9c2111c` |
| `PremiumRegistry` | `0x44Ae934Ef4a30FF11f9665174dDFa9F0c93bEA27` | `0x78502df1F231Fd50858832be5a3c035c8A504731` |
| `PremiumSetting` | `0x5223E0D4D1f0BE6Bf5De7cA6D2Fa9BFB6447013f` | `0x189FbDC1Ad7716960293130CFa3BE247b948c463` |
| `EIP712LegacyVerifier` | `0x3d6cC3782EC0DF21B58c4C9F5ecf23e485e05F9e` | `0xB3cE4476fddF5b57B937590a4436892c0Dc57220` |
| `TransferEOALegacy` (clone target, new legacies) | — | `0x2E2dE6475fcBE77E7930499981850d37b237924C` |
| `LegacyPullVaultV2` (new legacies; v1 stays for older ones) | — | `0xC6640962618f9D729032487EC5DEf226BF6F43E3` |

All Etherscan-verified with proxy records re-linked; `verify-governance.ts`
31/31 after execution (the router's code admin is the governance Safe, its
levers wait 48 hours, initializer counter 5).

The checklist audit's four Mediums and every queued contract rider, in one
timelock batch (wave A), plus legacy v3 (wave B), which deploys only after
an independent audit. Plan, layouts, runbooks, the follow-up list for the
app, admin panel and subgraph, and the review round 1 mapping:
`docs/plans/train-2026-11.md`. Neither wave is independently audited; two
internal read-only reviews were applied the same day.

Wave A, for new EOA legacies (a new clone implementation; existing legacies
keep theirs): direct USDT allowances pay out on the claim path (SafeERC20,
audit M-2); a non-WETH unswap needs a nonzero minimum and a sole recipient,
so no co-beneficiary picks the minimum for others (M-4); the owner's WETH
unswap unwraps instead of reverting; a claim fee above 0.5% is refused and
the create can bind the fee the creator saw; ETH reaches owners that are
smart accounts. LegacyPullVaultV2 lets an owner unbind an activated legacy
before signing for the next one (M-1) and admits further clone
implementations only through the timelock. For every legacy: the EOA
router's rotation levers (implementation, vault, attestor, creation code)
move behind the 48-hour timelock, the pause and the attestor kill switch
move to the governance Safe (M-3), the old ungated reinitializers are gone;
auto-renew baselines are per attestor; zero-minimum swaps into non-WETH
tokens are refused, and existing clones' unswap claims get the same
minimum and sole-recipient rules at the router. Timelocks: an absolute unlock date
(`createTimelockUntil`, for autopilot) and no more empty or zero-minimum
creates. Premium: coupon codes and automatic referral shares. Notifications:
the legacy's Safe can manage them, and a contract posing as a legacy can no
longer forge them. Terms: a user can record consent to the active terms for
a reference such as a ShieldVault position, with no change to ShieldVault.

Wave B, legacy v3 (a separate clone implementation, all features off by
default): NFTs from an allowlisted set of collections, per-beneficiary
backup lines (A, then A2, then A3), where each share is its own running
account so no heir's claim takes from another's, a share belongs to the
first address it pays, and the second and third lines take only shares
nobody else owns; and an optional executor
who can bring claims forward to a 30-day grace (after the owner has been
silent for half the trigger) that any owner activity cancels, and who can
never benefit or hold anything. Backup lines and the executor are Premium.

Tooling: clone implementations compile in their own job and reproduce byte
for byte from the input Etherscan verifies; the train's deploy and batch
script, which checks every address it schedules against the compiled code
and the router's live code admin before writing the batch; the verifier,
multisig router and EOA router ABIs are now covered by `sync-ui --check`.
The Hardhat 3 migration is not done: it changes every contract's metadata
hash, so deployed bytecode would no longer be reproduced byte for byte.
364 tests passing (263 before).

## 2026-11-04 — Deployment artifacts match the chain again

[No contract or on-chain change.]

`deployments/<net>/*.json` had fallen behind the chain on both networks:
the EOA router's artifacts named an implementation two upgrades old (25
ABI entries missing, the auto-renew errors among them), and the facades of
the verifier, PremiumRegistry and PremiumSetting pointed at retired
implementations. `contract-addresses.json`, the source of truth, was right
throughout, and nothing deploys from these files, so no transaction was
affected; `sync-ui` reads its ABIs from them, which is how the app's
`premiumRegistry.ts` came to miss `SafeERC20FailedOperation`.

- Every proxy's artifacts re-read from its EIP-1967 slot on mainnet and
  Sepolia. `refresh-impl-artifacts.ts` now writes compiled bytecode and
  ABI only when the compiled runtime code equals the live code with
  immutables masked: the multisig router, PremiumRegistry and
  PremiumSetting run solc 0.8.20 builds from before the compiler bump,
  so their recorded artifacts are kept and only pointers move. Sepolia's
  PremiumRegistry is byte-identical to mainnet's and takes its artifact.
- `scripts/audit-deployment-artifacts.ts` is back from the archive and
  runs in CI (offline: the pointers within each network must agree); with
  `--network` it also checks every proxy against the chain. Both networks
  pass. The upgrade runbook runs it after the refresh.

## 2026-11-02 — Checklist audit of the unaudited riders, vault pin

[No contract or on-chain change.]

An internal checklist pass (ethskills EVM audit checklists at a pinned
revision, one reviewer per area, every finding re-checked against the code
and mainnet) over ShieldVault, LegacyPullVault and its callers,
UpgradeTimelock, EOA auto-renew and QuantumRecoveryRegistry:
`docs/security/checklist-audit-2026-11.md`. Not an independent audit. No
Critical or High; four Mediums, none with a victim on mainnet today (no
auto-renew opt-ins, no direct USDT allowances, no activated legacy still
bound in the vault). Fixed off-chain the same day, in the sibling repos:
the worker's auto-renew baseline, the app's vault pin and quoted unswap
minimum. Queued for the next contract train: `SafeERC20` on the clone's
direct ERC-20 rail (USDT claims revert today), a non-zero minimum for
non-WETH unswaps, the EOA router's rotation levers behind the timelock,
and an owner unbind in the next vault.

In this repo: `sync-ui` now emits `pullVault` per chain (the app refuses
to sign permits for any other vault), `verify-governance.ts` checks the EOA
router's vault and implementation against the record and fails on a ready
timelock operation left unexecuted (27/27 on mainnet), the ShieldVault
listing rule requires a truthful transfer return value, and
`upgrade-timelock.md` states what a compromised code admin key can do to
new creators.

## 2026-10-29 — ShieldVault pre-audit tooling evidence, first CI

[No contract or on-chain change.]

The ShieldVault v2 source is untouched (it must stay byte-identical to the
mainnet deployment); what changed is the evidence around it, written up in
`docs/security/tooling-report.md` and `docs/security/static-analysis.md`.
`solidity-coverage` is wired (`npm run coverage`): ShieldVault was at
99.1% lines and 84.9% branches under the 40 existing specs; ten new branch
specs (`test/ShieldVault.branches.spec.ts`, including a transfer-hook
token that tries to re-enter all eight guarded functions) bring it to 100%
lines, statements and functions and 170 of 172 branches, the last two being
unreachable by construction. Slither and Aderyn run clean of anything above
informational once three well-known detector false positives are triaged
(`slither.db.json`). A Foundry suite under `test/foundry/` adds 13
stateless properties and a 25-operation invariant handler checking 9
invariant functions after every call; together they give every one of the
19 invariants in the audit package an automated check, with 0
counterexamples against the contract. A GitHub Actions workflow
(`.github/workflows/security.yml`, the repository's first CI) runs tests,
coverage with thresholds, Slither, Aderyn and the fuzz suite on every PR.
Wording everywhere: internally reviewed, tooling-verified, not
independently audited.

The first CI run on `dev` failed `testFuzz_heldShareMovesOnlyForItsKey`: the
fuzzer drew the owner's key (it reads values from storage) as the paper key,
whose address already held the owner's tokens, and the test asserted a zero
balance. The vault held the share correctly; the test now checks that the
release adds nothing to that address.

## 2026-10-26 — Clear-signing descriptors merged into the registry

[No contract or on-chain change.]

[PR #3110](https://github.com/ethereum/clear-signing-erc7730-registry/pull/3110)
was approved after a human review of every descriptor against the verified
source and merged: wallets that read the ERC-7730 registry (Ledger first)
now show 10102's legacy, timelock and Shield Vault calls in plain words.
The reviewer left eight optional suggestions. Two are built in here for a
follow-up PR: the Shield Vault's held-shares mask is shown whenever a share
waits in the vault for its beneficiary to claim (open and settings
change), and the auto-renew switch says the attestor is the one renewing
the timer. Two notes are about the contract, not the descriptors, and ride
the next train (`computing/docs/DEFERRED.md`, `router-create-hardening`):
ETH sent with an empty timelock create stays in the router, and a non-WETH
swap accepts a zero minimum.

Tooling: `web3` is gone (134 packages, all 19 high audit alerts). Its only
real use, the deploy scripts' bumped gas price, reads the RPC through ethers
(`getBumpedGasPrice(rpcUrl)`); two specs no longer read
`DEPLOYER_PRIVATE_KEY` into unused variables. `npm audit`: no high or
moderate; the 29 lows are dev-only (`contracts-toolchain`).

## 2026-10-21 — Clear-signing descriptors answer the registry review

[No contract or on-chain change.]

The registry's two advisory AI reviews of
[PR #3110](https://github.com/ethereum/clear-signing-erc7730-registry/pull/3110)
were checked note by note against the contract source, and the accepted
ones are built into `erc7730/` (45 test cases, up from 35; format, lint,
selector coverage, schemas and the Sourcify runner all pass). What a
signer now sees that it did not: the Shield Vault exit fee on withdrawal,
completion and release; the recovery-sheet choice, including its removal;
backup beneficiaries' shares (shown as None or 100%, which is what the
legacy stores); NFT and ERC-1155 collections; the ETH conversion
deadline; each beneficiary next to its share; and "Seal gift and accept
terms", since gift creation records consent. Beneficiary fields accept
contracts such as a Safe. The registry asks authors to wait for a human
reviewer's verdict on the AI notes, so the update is pushed to the PR
once that verdict is in.

Found while verifying: the legacy clone's owner-side `unswap` reverts for
a WETH storage token (Uniswap V2 `IDENTICAL_ADDRESSES` on the path
`[WETH, WETH]`, confirmed on mainnet). No funds are at risk and the app
never calls it; the fix rides the next implementation train
(`computing/docs/DEFERRED.md`, `eoa-unswap-weth`).

Also: `.gitattributes` keeps the terms snapshots and the registry folder
LF on every checkout, and `set-active-terms.ts` refuses a CRLF snapshot,
which would hash differently from the published terms.

## 2026-10-20 — Terms v2026-11 published

[On-chain configuration only; no contract or bytecode change.]

The EIP712LegacyVerifier's active terms move from `v2026-10` to
**`v2026-11`** on mainnet and Sepolia (`setActiveTerms`, keccak256
`0x59a7bd30f20d02f1cb3aba88452bed01b371885c61a7184b2387f01f3d999a2c` of
`docs/tos/v2026-11.txt`, 24,037 characters): mainnet tx `0x4135c9b4...7616`
in block 26233334, Sepolia tx `0xa71cdac8...d039` in block 11954778, both
read back from the chain. The new text adds Email Wallets & Network Fees
(Turnkey self-custodial wallets, courtesy fees, final user-signed
transfers) and Save on Autopilot (the limited Turnkey signing permission
that can only create USDC timelocks owned by the same wallet through the
`TimeLockRouter`, the published locking rule and caps, the Upgrade Policy
link). The snapshot is generated from the web repo's
`content/pages/disclosures.md` (commit `089c589`) by the same rule as
`v2026-08` and `v2026-10`, verified by regenerating both byte for byte;
markdown links render as `text (url)`. The app's `TERMS_VERSION` moves in
the same release.

## 2026-10-15 — Clear-signing descriptors for the registry's v2 schema

[No contract or on-chain change.]

`erc7730/registry/10102/` is the folder for the ERC-7730 registry, which
moved from LedgerHQ to `ethereum/clear-signing-erc7730-registry` and now
requires the v2 schema plus a test case per described function. Three
descriptors replace the August v1 draft: `TransferEOALegacyRouter` (create
v2, check-in, the distribution and backup edits, `setLegacyConfig`,
auto-renew, the gas-free claims switch, `autoSwap`/`unswap`, `withdraw`,
`deleteLegacy`, both claims), `TimeLockRouter` (the three creates, soft
unlock, both `withdraw` overloads) and `ShieldVault` (open, deposit,
check-in, withdrawal request, cancel, execute, fallback release, change,
veto, held-share claim). Owner, upgrade and relayer-only functions are
left undescribed on purpose. Format keys are generated from the Sourcify
ABIs of the live implementations (`erc7730/tooling/`), which corrected the
draft's `activeAlive()` to the deployed `avtiveAlive(uint256)` and its
distribution type (`uint96` to `uint256`). Validated with the registry's
pinned CI tools: `erc7730 lint` (only the expected "missing format"
warnings for admin functions), the Sourcify test runner (35/35), selector
coverage and JSON schema. Submitted the same day as
[ethereum/clear-signing-erc7730-registry#3110](https://github.com/ethereum/clear-signing-erc7730-registry/pull/3110);
the registry's CI passes all 35 cases on both reference implementations
(Sourcify and Rust). Its bot suggests an `interpolatedIntent` for each
format, which is optional and can follow a reviewer's first pass.

## 2026-10-11 — Terms v2026-10 published

[On-chain configuration only; no contract or bytecode change.]

The EIP712LegacyVerifier's active terms move from `v2026-08` to
**`v2026-10`** on mainnet and Sepolia (`setActiveTerms`, keccak256
`0xf1a7940ed37bb232ca7d1457df0c72fb8b15c4c7fb0a3d5b36557055e89e5a5d` of
`docs/tos/v2026-10.txt`, 18,031 characters). The new text states the 0.25%
delivery fee charged by `Payment` on claims from legacies created since
2026-09-29 and by `ShieldVault` on withdrawals and releases (setting up
stays free; timelocks, gifts and recovery-sheet stops carry none), adds
Shield Vault risks, names Turnkey for email gifts, and covers sponsored
transactions. The snapshot is generated from the web repo's
`content/pages/disclosures.md` by the same rule as `v2026-08` (bold
markers stripped, blank lines around lists, plain footer with the source
line), verified by regenerating `v2026-08.txt` byte for byte. The app's
`TERMS_VERSION` moves in the same release.

## 2026-09-29 — ShieldVault v2

[Released in `v2026.09.29`; live on mainnet since the date above.]

**ShieldVault v2** is live on mainnet at
`0xA1EA2F8C0518458975E09ED63bf5D48980f76C38` (block 26084130) and on
Sepolia at `0xa88f4c2D…2407`, both Etherscan-verified and owned by the
governance Safe. v1 is paused for new deposits (it held nothing); its
exits keep working. What v2 changes:

- The veto commitment binds the owner and is pinned per owner, so nobody
  can burn or shadow a freshly registered sheet.
- A veto can no longer fail: an unpayable recovery wallet is owed.
- Signed check-in, signed cancel and signed claims (EIP-712 domain
  "10102 ShieldVault" v2, EOA and ERC-1271, one nonce per action type),
  so a relayer can submit them without being trusted.
- Paper-key heirs: a held share waits in the vault until the heir signs
  where it should go, from any device, gas-free.
- A fee on withdrawals and inheritance releases, never on a veto:
  snapshotted per position at open, bounded by the opener's `maxFeeBps`
  and a hard 0.5% cap, launched at 0.25%, collected to the Safe.

**Payment governed by the Safe.** The legacy claim fee is on at 0.25%
for EOA legacies created from now on (each keeps the rate active at its
creation). `scripts/handover-payment-roles.ts` moved DEFAULT_ADMIN,
OPERATOR and WITHDRAWER on `Payment` (mainnet `0x4807C7B2…7de4`, the fee
setter and the treasury for fees and Premium) from the deployer to the
governance Safe, and the deployer renounced all three; rehearsed on
Sepolia first, where the Safe then set the same 0.25%. `Payment` itself
still accepts up to 99.99%: the Safe's signatures and the admin panel's
0.5% limit are the guard until a capped implementation rides a later
train (`legacy-claim-fee-cap` in `computing/docs/DEFERRED.md`).

**The Safe can take back the operational contracts.**
`scripts/add-safe-admin.ts` granted the Safe DEFAULT_ADMIN on
`PremiumRegistry`, `Banner` and `TokenWhiteList` (the deployer keeps its
roles for plan prices, Premium grants, banner text and the token list) and
moved `PremiumSetting` ownership to the Safe. Premium is $99 a year and
$399 for lifetime (plans 1 and 2 on mainnet).

Adversarially reviewed twice (40 specs, including a randomized
accounting property with the fee on); not independently audited.
Tooling: `shield-vault-admin.ts` (pause, token curation through the
Safe), the smoke covers the signed paths, `adm-zip` override keyed so
npm 10 and 11 resolve the same patched version (`npm ci` works again),
Sourcify off so verification reports only Etherscan.

## 2026-09-28 — ShieldVault live on mainnet

[Released in `v2026.09.29`; live on mainnet since the date above.]

**ShieldVault** (`contracts/shield/ShieldVault.sol`, spec and threat model
`docs/plans/shield-vault.md`) is deployed on mainnet at
`0x83074f8519F54AF05f7C48911E432e0C44dBEE69` (block 26077561) and on
Sepolia at `0xC930fD64…AebA`, both Etherscan-verified, not upgradeable,
owned by the governance Safe from the constructor. A position holds one
supported token (mainnet: wstETH, USDC, USDT, WETH) behind a 7, 30 or 90
day exit delay, optionally goes to up to 10 beneficiaries after 6 to 36
months of silence, and can be vetoed by revealing a scheme-5
`QuantumRecoveryRegistry` commitment, which moves everything to the
recovery wallet bound into the digest. Withdrawals and changes wait the
current delay and are vetoable until `readyAt`; after it anyone may
execute. Failed payouts (blacklisted payee) become owed, never a frozen
position. The Safe can only curate tokens and pause new deposits; exits
are never pausable. Adversarially reviewed (no Critical or High), not
independently audited; 26 specs including a random-sequence property
test, full suite 239 passing. The app was walked end to end on Sepolia
with a real wallet before the mainnet deploy, including a veto from the
public page.

Tooling: range-keyed npm overrides clear the dev-toolchain advisories (64
findings to 26 lows, all `elliptic`, which has no fixed release), with
bytecode byte-identical across all 142 artifacts. `sync-ui.ts` has one
`UI_KEYS` list and generates the ShieldVault ABI from the compiled
artifact; `dump-storage-layouts.ts` uses the current contract names;
`verify-etherscan-status.ts` also checks the standalone contracts
(ShieldVault, QuantumRecoveryRegistry, UpgradeTimelock), all verified on
both chains. `docs/CONTRACTS_REFERENCE.md` gains the governance and
protection contracts. Hardhat 3 stays deferred
(`computing/docs/DEFERRED.md` `sc-toolchain-audit`: it changes the
metadata hash of every deployable contract).

## 2026-09-24 — Destination-wallet claims and the split-key governance live on mainnet

[Released in `v2026.09.29`; live on mainnet since the date above.]

**Both operations queued on the 22nd executed today, in order.** The role
batch at 21:03 UTC (tx `0x2db1e716…f63e`): the governance Safe is
PROPOSER, the guardian hardware key `0x7B61…2579` is the only CANCELLER,
the maintainer EOA can queue but no longer cancel. The four-proxy upgrade
at 21:40 UTC (tx `0x07b67f6f…97fd`): `TimeLockRouter`
`0x82f3148c…5005`, `TimelockERC20` `0xC930fD64…AebA`, `TimelockERC721`
`0x65658A83…3B7e`, `TimelockERC1155` `0x497DaDFf…0F5A`, all
Etherscan-verified with the proxy records already pointing at them.
`verify-governance.ts` reads 24/24 in the interim phase; no operation is
pending.

Live proof, twice: `smoke-payto.ts` sealed a 0.001 ETH gift (id 11) to a
never-funded key and claimed it to a second address with a version-2
signature, the version-1 signature being rejected by the live router; then
gift 12 was claimed from the production claim page itself, the recipient
key signing on the page and the reminder-worker relaying, and
`TimelockWithdrawnTo` named the chosen destination. The app and the worker
switched to the new struct by reading `eip712Domain()`; nothing was
redeployed for the flip.

Also today: `smoke-payto.ts` gained an ETH-gift mode for networks without
a test token; the public Upgrade Policy, Heirloom guide and architecture
pages were published with the new facts; the contracts toolchain audit
(Hardhat 3, hardhat-deploy 2, Chainlink 1.x) is recorded in
`computing/docs/DEFERRED.md` with its trigger now met. Next on this track:
the third Safe owner and threshold 2 (founder), then step 2c and the
7-day delay.

## 2026-09-22 — Vaults under the timelock, router under the Safe, guardian brake queued; destination-wallet claims on Sepolia

[Executed on mainnet 2026-09-24, see above.]

**The three timelock vaults can no longer be reconfigured by a single key,
and a hardware guardian that can only cancel is being added to the upgrade
queue.** Track A of `docs/plans/round-2026-09.md`, live on mainnet today:

- `TimelockERC20`, `TimelockERC721`, `TimelockERC1155` are owned by
  `UpgradeTimelock`. Their setters (`setUniswapRouter`, the swap path an
  ETH gift trusts at claim; `setRouterAddresses`) now sit in the same 48h
  public queue as implementation swaps.
- `TimeLockRouter` is owned by the governance Safe
  (`0x60B3da49f05E21a1fcD7e210075A23b75939C3eA`, threshold 1 to start,
  raised later). `setCreatePaused` and the other router setters run from
  the Safe from now on.
- Scheduled, executable from 2026-09-24 ~21:02 UTC, one batch: the Safe
  becomes PROPOSER, the guardian hardware key
  `0x7B61dD775422f465D6b9f28C8EFEE39263ef2579` becomes CANCELLER, and the
  maintainer EOA loses CANCELLER. After it executes, the key that queues
  upgrades and the key that can stop them are different devices. The EOA
  keeps PROPOSER until the Safe is 2-of-3; the delay goes to 7 days after
  the destination-wallet train (below) has executed.
- Rehearsed end to end on Sepolia first, including scheduling from the
  Safe. `scripts/verify-governance.ts` prints the pass/fail table for
  either network; `scripts/harden-governance.ts` performs each step with a
  dry run by default; `scripts/timelock-op.ts` gained batches
  (`TL_BATCH`), a `print` mode for Safe{Wallet}'s Transaction Builder, and
  `TL_VIA_SAFE` for driving a threshold-1 Safe from a script.

**Destination wallet on gas-sponsored claims (Track B1), live on Sepolia,
queued on mainnet for 2026-09-24 ~21:39 UTC** (operation
`0x8cf4a20d…29c7`; implementations router `0x82f3148c…5005`, ERC20
`0xC930fD64…AebA`, ERC721 `0x65658A83…3B7e`, ERC1155 `0x497DaDFf…0F5A`,
all Etherscan-verified). A gift recipient's key signs once and
names `payTo`, the wallet that receives the funds; the printed or emailed
key never holds them. On chain: `WithdrawAuth` gains `payTo` and the
EIP-712 domain version becomes "2" (old signatures fail loudly, clients
read the version from `eip712Domain()`); the vaults gain router-only
`withdrawTo`; the direct `withdraw` paths do not change by one byte; no
storage variable is added anywhere (layouts diffed identical for all four
proxies). New events, additive: `TimelockWithdrawnTo` on the router,
`FundsRedirected` / `TokensRedirected` on the vaults; every existing event
keeps its signature. Two bounds from the same-day adversarial review
(no Critical or High findings): a sponsored authorization's deadline may
not sit more than 7 days out at submission, so a signature phished long
before an unlock is useless at the unlock; and an id that exists in no
vault reverts before the nonce is consumed. Sepolia implementations
(final source): router `0x3eE4633a131ABDFA2B982bde116E6Cb4De09fBcD`,
ERC20 `0xaB3C8C69fD17ba980b3D11064200c866904e360E`, ERC721
`0x3E2259af881aBe4682c519CCB91cf3f1765c80eB`, ERC1155
`0x4ce7F4afF74613797c9176E653cC2aE8e25f1713`. Consumer changes are in
`computing/CHANGELOG.md` (same day).

Also: `sync-ui --check` now compares the frontend's ABI modules, not only
addresses (a struct change would have slipped through before);
`dump-storage-layouts.ts` covers the vaults and strips AST ids so diffs
are exact; `refresh-impl-artifacts.ts` promotes `pendingImplementation`
entries after an executed upgrade.

## 2026-08-07 — QuantumRecoveryRegistry live on mainnet (post-quantum commitment registry)

**Any account — EOA or Safe — can now register a post-quantum recovery
commitment on-chain, and the timestamp is the asset.**
`contracts/common/QuantumRecoveryRegistry.sol` is deliberately minimal:
append-only history per account (later entries never erase the earliest
pre-break timestamp a future verifier needs), no owner, no proxy, no pause
switch — an upgradeable "quantum-safe" registry would undercut its own
claim. `register(digest, scheme, recoveryContext)` stores the hash of a PQ
credential or secret; registering reveals nothing quantum-vulnerable.
Scheme labels cover SLH-DSA/ML-DSA/FN-DSA/WOTS+/hash-preimage without
gating, so future schemes need no redeploy.

- Mainnet: `0xaB3C8C69fD17ba980b3D11064200c866904e360E` (Etherscan-verified);
  Sepolia: `0xeed1e3614fb5F3Ed980fD120Bc7c68d144e84C59`.
- Deploy script `scripts/deploy-quantum-registry.ts`; address synced to the
  frontend via `sync-ui` (`quantumRegistry` key).
- This is a readiness step, not enforcement: nothing in it moves funds or
  vetoes transactions. The enforcement layers (delay-veto vault, Safe
  module) are tracked in `computing/docs/DEFERRED.md`
  (`quantum-delay-vault`).

## 2026-08-06 — Proxy upgrades are now timelocked (48h public queue), live on mainnet

**No contract implementation can change without first sitting in a public,
on-chain queue for 48 hours.** `DefaultProxyAdmin` — the owner of every
upgradeable proxy in the protocol — was transferred from the maintainer EOA
to an `UpgradeTimelock` (`contracts/common/UpgradeTimelock.sol`, a thin
subclass of OpenZeppelin `TimelockController`). This converts every
"immutable / bounded" claim the protocol makes (the vault's immutability,
the auto-renew attestor's on-chain bounds) into something a stranger can
verify: any upgrade emits `CallScheduled` and waits 48 hours before it can
execute, and execution is permissionless once ready. ROADMAP track 11 —
"protects users from *us*, which is the point of non-custodial."

| Network | UpgradeTimelock | minDelay |
|---|---|---|
| mainnet | `0xc0Fee69ffAA1d62D701Bb277031CEc0d98AFA4Ad` (verified) | 48h |
| sepolia | `0xFE949165f70becE8EaeA9f39140F377aF47f0875` (verified) | 300s (QA) |

Roles: proposer + canceller = maintainer key; executor = open; the timelock
administers itself (delay/role changes are themselves queued + delayed).
Deliberately NOT timelocked: the EOA router's `codeAdmin` levers — the
create pause stays an instant emergency brake, and impl/vault rotation only
affects new creates (existing clones pin their code forever). Full cycle
rehearsed on Sepolia (schedule → wait → execute a no-op upgrade against the
real ProxyAdmin) before the mainnet transfer.

Ships with: `scripts/deploy-upgrade-timelock.ts`,
`transfer-proxy-admin-to-timelock.ts`, and `timelock-op.ts` (the
schedule/status/execute/cancel runbook tool for every future upgrade
train); design record + runbook in `docs/plans/upgrade-timelock.md`; public
policy page at docs.10102.io (Architecture → Upgrade Policy); queued-upgrade
alerting in the `computing` repo's reminder-worker (`timelock-watch.ts`).

## v2026.07.30 — One permanent verified Permit2 spender + EOA activity auto-renew, live on mainnet

**LegacyPullVault kills the red "deceptive request" wallet warning at the
root** — every new create now names one permanent, Etherscan-verified
contract as its Permit2 spender instead of a code-less counterfactual clone
address — and **EOA activity auto-renew (Phase 1)** makes the original
product promise ("we monitor your wallet activity") true on-chain. Two
riders on one router-upgrade train (one mainnet upgrade event instead of
two), deployed to **mainnet 2026-07-30** from a twice-rehearsed Sepolia
runbook (all proxies upgraded in place — addresses unchanged; total spend
~0.0088 ETH):

| Contract | Address |
|---|---|
| `TransferEOALegacyRouter` impl (proxy `0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b`) | `0x355BBf74B91e021f18Cee0de191b295B4159E4A1` |
| `TransferEOALegacy` clone impl | `0xdDea11D92dDD0746Dbe2899f35A79a145660a7C3` |
| `LegacyPullVault` | `0x95F0981026C7e804fD6ba8bE738cA7c380C7f978` |
| Activity attestor (worker key) | `0x4B05aC1b0BF109A9CE30dCEc2831990d694d74D0` |

Deployment record with tx hashes and the post-deploy verification suite:
`docs/plans/legacy-pull-vault.md` §6c.

### EOA activity auto-renew (Phase 1)

- Owner-opt-in (premium-gated, default OFF) `setAutoRenew` per legacy, plus a
  code-admin-wired `activityAttestor`. When the off-chain worker sees the
  owner's transaction count rise near the deadline, `recordActivity` resets
  the inactivity timer — no email, no click, no gas from the owner.
- Four hard bounds, all on-chain: opt-in; strictly-increasing attested nonce
  (an observation can never be replayed, even across disable/re-enable);
  attestations only within 30 days of the activation deadline (~one per
  period); and a 365-day budget since the owner's last REAL check-in, after
  which the owner must check in themselves. Premium is re-checked at each
  renewal.
- Honest trust model: a fully compromised attestor can only DELAY activation
  — never accelerate it, never claim, never move funds. Stated precisely,
  the last renewal can land up to 12 months after the owner's last real
  check-in and activation then follows one further inactivity period (so
  worst case ≈ 12 months + one period). Real check-ins (direct or
  sponsored) refill the budget; attestations never extend their own leash.
- Hardened after an independent adversarial review (no HIGH findings): an
  attestation can never re-arm an already-claimable legacy
  (`AutoRenewTooLate` once the deadline passes — the claim window belongs to
  the beneficiaries), and sponsored `CheckInAuth` signatures must now carry a
  deadline ≤ 1 hour out (`CheckInDeadlineTooFar`) so a hoarded signature
  can't refill the budget months after signing. A nonce-poisoning attestor
  can only brick auto-renew for a legacy, which fails safe: renewals stop,
  reminders take over, activation proceeds.
- Second review round: enabling now fails loudly instead of silently never
  firing — rejected on tombstoned legacies (`AutoRenewLegacyNotLive`) and on
  trigger periods past the ~395-day feasibility cliff (`AutoRenewInfeasible`,
  where the renewal window would only open after the budget is spent). The
  exact budget-refill set is documented and test-pinned: check-ins and the
  owner's own re-enable toggle refill; config actions (trigger edits,
  withdrawals, swaps) deliberately don't.
- Storage appended after `pullVault` (`activityAttestor` slot 15,
  `autoRenewState` slot 16 — layout verified append-only). No clone changes:
  covers every existing legacy. Tests: `test/EOAAutoRenew.spec.ts`
  (15 cases). Full suite: 190 passing.

### LegacyPullVault: one permanent, verified Permit2 spender

Kills the red "deceptive request" wallet interstitial on v2 creates at its
root. Creators' Permit2 batches previously named the CREATE2-predicted (still
code-less) clone as spender — the exact fingerprint Blockaid flags as a
drainer, and an address that can never be allowlisted or verified. New
`LegacyPullVault` (immutable, admin-free, ~1.5 KiB) is the single spender for
all new creates:

- Vault pins the clone implementation's EIP-1167 codehash and holds a
  first-write-wins `owner → legacy` binding set by the router inside the
  create tx; only the owner's own bound legacy can pull, only through
  Permit2's per-owner signed envelope. Delete releases the binding;
  a non-live binding (deleted/claimed) may be replaced by the next create.
- Router: appended `pullVault` storage (slot-packed after `createPaused`,
  layout verified append-only), `setPullVault` under the existing code-admin
  role, `createLegacyV2` accepts vault-or-clone spender (pre-vault frontends
  unchanged), create binds after clone init.
- Clone impl: pins its vault in appended storage at `initialize` (new clones
  only) and picks, per token, the most generous of three rails (direct
  ERC-20 / Permit2-to-clone / Permit2-via-vault). All guarded reads; claims
  never revert on missing vault/Permit2. Pinning means a `setPullVault`
  rotation only affects future creates — it can never strand the
  already-signed permits of an existing legacy.
- One stable spender address unlocks the trust-registry track: Etherscan +
  Sourcify verification, Blockaid/MetaMask registration, ERC-7730
  clear-signing descriptor. Deployment + registry checklist in
  `docs/plans/legacy-pull-vault.md`; deploy via `scripts/deploy-pull-vault.ts`
  (vault rotates together with the clone implementation).
- Hardening from the adversarial review round (details in the plan doc §7):
  the admin-fee pull now rides the same guarded rails as beneficiary
  transfers, so one non-pullable fee forfeits that fee instead of bricking
  the whole claim batch (fee paths now tested with a **nonzero** fee); the
  EOA router gains `ReentrancyGuardTransient` (EIP-1153, zero storage —
  layout-safe on the live proxy) on all claim entrypoints, closing
  ERC-777-style re-entry into distribution; vault-spender bundles are
  rejected when the clone path is disabled.
- Tests: `test/LegacyPullVault.spec.ts` (17 cases) covering bind/release/pull
  gating, codehash pinning, back-compat rails, lockdown revocation, rebind
  lifecycle, vault-rotation pinning, nonzero-fee rails + sabotaged-rail
  resilience, a reentrancy probe (`MockReentrantERC20`), and the
  signature-less `Permit2.approve` top-up path (`MockPermit2` gained
  canonical `approve`). Full suite with both riders: 182 passing.

## v2026.07.27 — Create-flow v2 live on mainnet: one-confirmation creates, PII-free events, tx-based consent

The create-flow v2 program: single-confirmation legacy creation and the
"final architecture" pass ahead of the audit. Full design record in
`docs/plans/create-flow-v2.md`; rehearsed on Sepolia, then deployed to
**mainnet 2026-07-27** (all proxies upgraded in place — addresses unchanged):

| Contract | Proxy | New implementation |
|---|---|---|
| `TransferEOALegacyRouter` | `0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b` | `0x15123649ce7229f98aC25c802e2753be05Cb87A8` |
| `TimeLockRouter` | `0x2B947E3c348c81409f8e8fc5ef8F65d9dFf76A42` | `0x9f44Af0D30fFee271131059CD067ea902850CFc1` |
| `EIP712LegacyVerifier` | `0x3d6cC3782EC0DF21B58c4C9F5ecf23e485e05F9e` | `0x7bcA85C9fE3DD8FAE178640eaebbaB13f5DA97DE` |
| `TransferEOALegacy` (clone target) | — | `0x148469D1fF87a3FBE3A1fCE14BC7e348f2df61A3` |

Post-upgrade wiring: consent recorders enabled for both routers,
`TimeLockRouter.consentVerifier` set, and active terms published as
**`v2026-06`** (keccak256 of `docs/tos/v2026-06.txt`, a snapshot of
https://10102.io/disclosures "Last updated: June 04, 2026"). All state
verified preserved (`timelockCounter`, whitelist, uniswap router, owners);
all implementations Etherscan-verified and proxies re-linked.

- **Permit2 `AllowanceTransfer` creates** (`createLegacyV2`,
  `createTimelock*WithPermit2`): one signed batch replaces N approve txs;
  tokens stay in the owner's wallet until claim.
- **PII strip**: names/nicknames/notes removed from EOA legacy storage and
  events (`TransferEOALegacyCreatedV2` et al.); metadata lives off-chain.
- **Tx-based consent + versioned terms**: the verifier gained an
  owner-published active-terms registry (version tag + content hash),
  dual-accepting signed messages, and a generalized `recordConsent`
  registry so the create tx itself records acceptance (empty-signature
  path on the EOA router; gift-timelock consent parity on TimeLockRouter).
- **Gas-sponsored flows**: EIP-712 + ERC-1271 sponsored claims,
  check-ins, and timelock withdrawals (sequential nonces, ERC-5267
  discovery, owner opt-out).
- **Create pause**: owner-gated circuit breaker on router create functions
  only — claims, check-ins, deletes, withdrawals are never pausable.
- **Toolchain**: Solc 0.8.35 (cancun), Hardhat 2.28.6, and OpenZeppelin
  5.6.1 — the OZ bump migrated the five proxied contracts off the removed
  `ReentrancyGuardUpgradeable` / `ERC721HolderUpgradeable` /
  `ERC1155HolderUpgradeable` onto the now-stateless main-package variants
  (same ERC-7201 slot, storage layouts verified byte-identical; 158 tests
  green).

## v2026.06.08 — Email reminders moved off-chain: Chainlink Automation + Functions retired (USD price feeds retained)

_Released to `main` 2026-06-08 (CalVer `v2026.06.08`). The on-chain changes
below shipped to mainnet + Sepolia on **2026-06-02** ahead of this main-branch
release; this entry folds that deploy event into the release record._

Email reminders no longer ride on Chainlink. The time-based **scheduling**
(Chainlink Automation upkeeps) and the email **delivery** (Chainlink
Functions consumers) were both removed from the premium notification path
and replaced by an off-chain **reminder-worker** (Mailjet, routed through
the existing `email-proxy`). This drops the LINK dependency for reminders,
eliminates the documented duplicate-email trade-off (one idempotent
sender), and removes PII-shaped calldata/string fan-out that existed only
to feed Chainlink. Authoritative narrative + rationale:
`docs/plans/chainlink-email-retirement.md`.

**Chainlink price feeds are NOT affected.** `PremiumRegistry` still imports
`AggregatorV3Interface` and calls `latestRoundData()` for USDT/USD,
USDC/USD, and ETH/USD to price premium subscriptions (mainnet registry
`0x44Ae934Ef4a30FF11f9665174dDFa9F0c93bEA27`). Only Automation + Functions
were retired.

**What changed on-chain**
- `PremiumSetting` is now **emit-only** for notifications: the
  reset/activation triggers emit
  `LegacyEmailNotifyRequested(address indexed legacy, address indexed creator, uint8 layer, uint8 notifyType)`
  (`NotifyType { OwnerReset, ActivatedMultisig, ActivatedTransfer }`),
  consumed off-chain. The inline Chainlink mail dispatch is gone. The
  spoofable `onlyLegacy` modifier + `triggerActivationTransferLegacy` were
  deleted (closes audit M-2′ structurally); EOA activation now routes
  through a non-spoofable `onlyRouter` notify. Deprecated mail/automation
  storage slots are **retained** for proxy storage-layout safety but drive
  nothing.
- `PremiumReminderView` (new, standalone, non-proxied) re-expresses the old
  `PremiumAutomation.checkUpkeep` *timing* as `dueReminders(legacy)` /
  `dueRemindersBatch(legacy[])`. The worker polls it so the chain still
  gates "is a reminder due?"; only the cron trigger + delivery moved
  off-chain. Mainnet view `0x8A5aF2c367B7420300547b03Be5f4c720C027a4d`
  (`defaultNotifyAhead` = 7d).
- `PremiumRegistry` upgrade carried the B-1 `SafeERC20.safeTransferFrom`
  fix for USDT/USDC subscriptions (classic Tether returns no bool) — a
  silent correctness fix (0 USDT/USDC subs historically).
- **Source deleted from the repo, proxies remain on mainnet but INERT:**
  `PremiumAutomationManager`
  (`0x03db2dcED84AEcb21F9e399f4dC7B71302537265`) + per-user
  `PremiumAutomation` cronjobs, and
  `PremiumMailRouter`/`PremiumMailBeforeActivation`/`PremiumMailReadyToActivate`/`PremiumMailActivated`.
  Their addresses are kept in `contract-addresses.json` for the record;
  `PremiumSetting` keeps deprecated storage placeholders for layout.

**Off-chain / cross-repo (context)**
- `computing/services/reminder-worker` (new): subgraph `NotifyRequested`
  event consumer + `PremiumReminderView` due-poller, encrypted recipient
  store (AES-256-GCM, crypto-shred erasure), idempotent sent-ledger, posts
  to `email-proxy`.
- `computing-subgraph`: indexes `LegacyEmailNotifyRequested` →
  `NotifyRequested` entity.
- `computing/services/email-proxy`: generic `variables` passthrough +
  worker shared-secret rate-limit bypass.

**Pending operational teardown (on-chain, USER action — not done here)**
- Cancel the **mainnet Chainlink Automation upkeep**, close the
  **Chainlink Functions subscription**, and **withdraw remaining LINK**
  (via `PremiumAutomationManager.withdrawLINK` and the Chainlink UI). The
  contracts are inert, but the LINK is still parked until this is done.
  **Done** (verified on chain 2026-11-09): the three upkeeps were cancelled
  on 2026-06-02 and hold 0 LINK, the manager holds 0 LINK, and Functions
  subscription 141 no longer exists.

## 2026-05-04 — EOA receive() 2300-gas fix + create-flag self-service + EIP-1167 cutover

This release folds three on-chain pieces into `main`. All three were
already live on Sepolia and mainnet ahead of the squash-merge — the
`main` commit is the bookkeeping that records what shipped.

1. **EIP-1167 minimal-proxy clones for new EOA legacies.** Cuts
   per-create gas roughly in half by replacing full-bytecode redeploys
   with minimal clones pointing at a shared implementation. Existing
   pre-cutover legacies are unaffected (full, independent contracts
   still). Forensics + reconciliation tooling shipped in the same
   bundle (`scripts/forensics-eoa-clones.ts`, artifact-hygiene audit).
2. **EOA `receive()` fits the WETH 2300-gas stipend.** WETH9's
   `withdraw()` calls back via `transfer()`, which forwards exactly
   2300 gas; the old `receive()` did multiple SLOADs and reverted,
   silently breaking the entire `claim-as-ETH` path. New impls deployed
   on both networks; existing clones are bound to the old impl per
   EIP-1167 immutability and stay on the "claim as WETH then unwrap"
   workaround.
3. **EOA `isCreateLegacy` no longer permanently locks out owners after
   a beneficiary claim.** The router auto-clears the flag on successful
   `activeLegacy*`, and a new self-service `releaseCreateFlag` lets
   owners of pre-existing claimed legacies clear their own flag without
   admin coordination.

Detailed breakdown of each piece below (kept verbatim from the
"unreleased on dev" entries for traceability).

### EOA legacy "create flag" — owners no longer locked out after a beneficiary claim

**What changed on-chain**
- `TransferEOALegacyRouter.activeLegacy(...)` and
  `activeLegacyAndUnswap(...)` now clear `isCreateLegacy[owner] = false`
  on success. Activation is a one-way state change (the underlying
  contract's `_isActive` flips to 2 and `deleteLegacy` is blocked from
  there on), so the owner had no path to release the flag and was
  permanently locked out of `createLegacy`. The clear runs after the
  beneficiary-layer / claim-eligibility checks, so it can't fire on a
  reverting activation.
- New self-service entry point: `releaseCreateFlag(uint256 legacyId_)`.
  The recorded owner of any legacy that the system already considers
  no-longer-live (`!IPremiumLegacy(legacy).isLive()` — i.e. claimed
  *or* deleted) can call this to clear their own flag without admin
  coordination. This covers legacies created **before** the
  `activeLegacy*` auto-clear shipped, including the broken-impl cohort
  on mainnet and Sepolia. Reverts `OnlyOwner` / `LegacyStillActive` for
  bad callers; emits `TransferEOALegacyCreateFlagReleased`.
- Storage layout unchanged. Router size: 13.06 → 13.25 KiB (+190 B,
  well under EIP-170).
- Scope: EOA router only. The Multisig router never gated `createLegacy`
  on `isCreateLegacy` (so no symmetric bug). The Safe-source Transfer
  router has the same shape but is being soft-sunset and its
  `createLegacy` is hidden in the UI; left alone for now to keep the
  diff minimal.

**Why it matters**
- This was the immediate blocker for QA against the freshly patched
  EOA implementation: the test wallet's pre-fix legacy was already
  claimed, `deleteLegacy` reverts, and the wallet couldn't create a
  fresh legacy to actually exercise the `claim-as-ETH` fix.
- Beyond QA, every owner whose legacy gets claimed in normal operation
  was implicitly locked out of the product on that wallet — they would
  have had to switch wallets to create a new one. This restores the
  obvious mental model ("once a legacy is terminated I can start a new
  one").

**Rollout**
1. ✅ Sepolia: router proxy `0xF9Eb0EB6B547c67413484FBD9856684F950768A7`
   upgraded to new impl `0x7fA7287b2711b011D23E0DE69CD6bCd0d95A0D6D`
   (impl tx `0x657f9146cdbacdfc64689fe73a4dad5861c003e5ca52faa4263ba5f2803a22c1`,
   `DefaultProxyAdmin.upgrade` tx `0xcbcfd088ed77c0e2693e0b6c1213b9429ae6633b8fdcca7bf8da083ad3bed0c4`).
   Etherscan-verified. EIP-1967 impl slot confirmed on-chain.
2. ✅ Mainnet: router proxy `0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b`
   upgraded to new impl `0xa4D4813cFEf925410b2A533516979aCD6607Cd57`
   (impl tx `0x345059c49aa107f32eaab5d6b38eae538bcf95c823e30999ab214ae2bafc2fb5`,
   `DefaultProxyAdmin.upgrade` tx `0x83afadd0c949727263b45e19bf4ea22f3340ce2d0ac0d54b161fcb0cc68c72fe`).
   Etherscan-verified. EIP-1967 impl slot confirmed on-chain.
3. `contract-addresses.json` updated by hardhat-deploy for both networks.
4. Helper script `scripts/release-eoa-create-flag.ts` added so any
   stuck owner can run
   `LEGACY_ID=<id> npx hardhat run scripts/release-eoa-create-flag.ts --network <net>`
   from their own wallet to clear the flag without going through the
   UI.

### EOA legacy "Claim as ETH" — `receive()` now fits the WETH 2300-gas stipend

**What changed on-chain**
- `TransferLegacyEOAContract.receive()` short-circuits when
  `msg.sender == weth`. The previous body did `isLive() &&
  msg.sender == getLegacyOwner()`, which on the WETH-unwrap callback
  costs ~2.3-4.5k gas (a cold SLOAD on `_isActive`). Sepolia/mainnet
  WETH9's `withdraw()` calls back via Solidity-0.4-style
  `msg.sender.transfer(wad)`, which forwards exactly the 2300-gas
  stipend, so the callback was reverting and bringing down the entire
  `activeLegacyAndUnswap` path.
- The early return preserves the existing semantics for owner deposits
  (still bumps `_lastTimestamp` when the owner sends ETH directly),
  it only suppresses the bookkeeping when the inbound ETH is the
  contract unwrapping its own WETH balance during a beneficiary claim.

**Why it matters**
- "Claim as ETH" on EOA legacies whose storage token is WETH was
  reverting at simulation (MetaMask never popped). Beneficiaries had
  to fall back to "Claim as WETH" and unwrap themselves, which leaks
  the abstraction the storage-token autoSwap is supposed to hide.
- Mainnet impact assessment: the broken impl is at
  `0x314F512c2420b5F7548E95f5c5438FEDB2d9233C` and is the clone target
  for every EOA legacy created since `cd52a40`. Existing legacies are
  permanently bound to that impl (EIP-1167 hardcodes the delegation
  target in clone bytecode) — they cannot be retroactively patched
  and remain on the workaround "Claim as WETH then unwrap on receipt".
  The new impl unblocks **only** legacies created after the impl swap,
  which is acceptable: the cohort of mainnet EOA legacies with
  `eoaStorageToken == weth` is small and identifiable, and the
  workaround is non-destructive.

**Rollout**
1. ✅ Sepolia: new impl `0x6bab4A27a0Eb5210B61e35E69331355dC2A74511`
   wired via `setLegacyImplementation` (tx
   `0x90fc34db427b9ff9723849d1389a7ca23a00b794748138321d09c6ea16721452`).
2. ✅ Mainnet: new impl `0xD5bA2799fc2e5bc250a50251896A6d7E1c792200`
   deployed (tx
   `0x90f42c07647c1d2252bfdd8d59421a1ea536cc2d8858a9e316a9ccfdddbf5f29`)
   and wired via `setLegacyImplementation` (tx
   `0xba472d3b291c6faa22b00de37bd1727fd4d909bff5a575cafe6a99e889b43757`).
   Confirmed on-chain — `legacyImplementation()` returns the new address
   on the production router `0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b`.
   Replaces `0x314F512c2420b5F7548E95f5c5438FEDB2d9233C` as the clone
   target for new EOA legacies; existing clones are bound to the old
   impl per EIP-1167 and stay on the "claim as WETH then unwrap"
   workaround.
3. Etherscan verification deferred on both networks — same
   `solc 0.8.20 + viaIR` determinism entry already tracked in
   `docs/DEFERRED.md`. Functional contracts are unaffected; the proxy
   ABI users interact with on Etherscan is the verified router proxy
   itself, which is unchanged.
4. `contract-addresses.json` updated by the deploy script for both
   networks.

### EIP-1167 minimal proxies for EOA transfer legacies — gas cost ≈ −50% per create

Commit `cd52a40` (+ forensics `73267f9`, artifact hygiene `63a9be8`).

**What changed on-chain**
- `TransferEOALegacyRouter` no longer deploys a full `TransferEOALegacy`
  bytecode copy per user. Instead it deploys a ~45-byte **EIP-1167
  minimal proxy (clone)** that `DELEGATECALL`s into a single shared
  `TransferEOALegacy` implementation.
- The implementation is deployed once per network; subsequent user
  creations are clones of it. The clone retains its own storage
  (including `owner`, beneficiaries, and the activation trigger state),
  so isolation between users is preserved.
- CREATE2 salt scheme is unchanged; addresses remain predictable
  pre-deploy and the frontend's "show me my contract address before I
  approve assets" flow keeps working.

**Why it matters**
- EOA transfer legacy creation on mainnet drops from a roughly full-copy
  deploy to a minimal-proxy deploy — **≈50% gas reduction** per user.
  Confirmed in production; user feedback "works great and fees are much
  better indeed".
- No migration for existing legacies: already-deployed contracts are
  untouched. Only new `create*` calls route through the clone pattern.

**Trade-offs / known issues**
- **Etherscan cosmetic verification of the mainnet clone target is
  currently blocked on an upstream `solc 0.8.20 + viaIR` determinism
  bug** (Sourcify flagged `extra_file_input_bug`, issue #618). The
  contract functions correctly and is safe; verification is a UI-only
  gap. Documented in `computing/docs/DEFERRED.md` under "Etherscan
  verification of mainnet `TransferEOALegacy` clone target" with the
  full repro and the two mitigation paths (redeploy with `viaIR: false`
  or a newer `solc`; or wait for compiler fix).

### Artifact hygiene — audit + reconciliation tooling

Commit `63a9be8`.

- `scripts/audit-deployment-artifacts.ts`: audits
  `deployments/<network>/*.json` against on-chain truth. Flags missing
  `transactionHash` in `_Implementation.json`, `main.implementation`
  pointer mismatches vs `_Implementation.address`, and `main.address`
  vs `_Proxy.address` mismatches. Auto-enables on-chain
  EIP-1967-slot cross-checks when pointed at `mainnet` or `sepolia`.
- `scripts/reconcile-impl-artifacts.ts`: pulls on-chain truth (EIP-1967
  impl slot, Etherscan `getsourcecode` for ABI, `getcontractcreation`
  for `txHash`, `eth_getCode` for `deployedBytecode`) and rewrites the
  drifted artifact fields in place. Idempotent, with retry/backoff for
  Etherscan rate limits, and a path for non-verified implementations
  that preserves local ABI while backfilling `txHash`.
- Drift reconciled on `main.json` + `_Implementation.json` for
  `TransferEOALegacyRouter`, `TransferLegacyRouter`,
  `MultisigLegacyRouter`, `Banner`, `PremiumRegistry`, and
  `PremiumSetting` across mainnet and Sepolia. Both networks now pass
  clean under the audit script.

## 2026-04-20 — Sepolia admin recovery, LINK-funding runbook, Etherscan audit

Squash-merge `248cfd1`. Operational pass focused on making Sepolia a
true staging mirror of mainnet and putting guardrails around the
Chainlink Automation LINK invariant.

**Sepolia admin recovery**
- `contract-addresses.json` (sepolia) re-wired to the contracts the
  live routers actually reference. Three of the four originally
  "orphaned" addresses (Payment, TokenWhiteList, PremiumRegistry) were
  stale entries in this file; only Banner was genuinely orphaned and
  has been redeployed. New `_orphaned` and `_redeployed_unused`
  sections document the original addresses and any contracts
  `hardhat-deploy` cascaded into redeploying during recovery.
- `deployments/sepolia` regenerated so `sync-ui` emits the correct
  ABIs. Unused `Banner_Proxy` and `PremiumRegistry_Proxy` sibling
  files dropped since the live proxies don't need `hardhat-deploy`
  sidecars.
- `deploy/8.Payment.ts` and `deploy/9.TestERC20.ts` hardened with
  `skipIfAlreadyDeployed` + `newlyDeployed` guards so reruns don't
  redeploy contracts or re-mint tokens.
- `hardhat.config.ts`: Sepolia gas price pinned to 3 gwei (override
  with `SEPOLIA_GAS_PRICE_GWEI`) to avoid `REPLACEMENT_UNDERPRICED`
  on batched deploys.
- `scripts/seed-sepolia-admin-state.ts`: seeds a Dev Penny Plan in
  `PremiumRegistry` and whitelists the canonical Sepolia WETH along
  with USDC/USDT/wstETH in `TokenWhiteList`, so consumer UI features
  (ETH auto-swap for Timelock and EOA legacy) work out of the box.
- Recovery and audit tooling added: `diagnose-sepolia-orphans`,
  `diagnose-post-redeploy`, `inspect-old-registry`,
  `inspect-wired-contracts`, `get-impls`,
  `reconstruct-deployment-artifacts`, `redeploy-sepolia-orphans`,
  `verify-sepolia-admin`, `verify-mainnet-wiring`,
  `find-deploy-blocks`.

**LINK funding for Chainlink Automation**
- `docs/plans/link-funding-runbook.md`: documents the invariant that
  `PremiumAutomationManager` must hold ~2 LINK at all times. Subscribe
  and legacy creations pull 1 LINK per new Chainlink upkeep, and a
  depleted manager surfaces three layers up as a misleading
  "ERC20: transfer amount exceeds balance".
- `check-sepolia-link-funding`, `check-mainnet-link-funding`,
  `fund-sepolia-manager-link`, `check-deployer-link`: monitoring and
  top-up scripts. The mainnet check reads the wired manager via
  `PremiumSetting.premiumAutomationManager()` so it cannot drift if
  the manager is ever re-wired.
- Sepolia `PremiumAutomationManager` funded with 10 LINK from the
  deployer as part of bringing up the admin portal.

**Etherscan verification audit**
- `scripts/check-sepolia-verification.ts`: enumerates every wired
  Sepolia proxy + impl against the Etherscan v2 API with rate-limit
  retries. All contracts deployed or upgraded in this release are
  verified. Five pre-existing impls show bytecode drift from earlier
  `solc`/optimizer settings; they remain functional via their
  verified proxies and are tracked as a future git-archaeology pass.

## 2026-04-17 — Multisig activation-trigger `uint128` fix, router upgrade tooling, Safenet outreach

Squash-merge `64b1feb`. Correctness fix for a class of silent multisig
failures, plus the tooling to roll the fix out via proxy upgrade.

**Multisig inheritance trigger (correctness)**
- `IMultisigLegacyContract.setActivationTrigger` parameter widened
  from `uint256` to `uint128` to match
  `MultisigLegacyStruct.LegacyExtraConfig`;
  `MultisigLegacyContractRouter` now casts explicitly with an
  overflow guard. Resolves the ABI mismatch that caused
  signed-but-unexecuted multisig Safe transactions to revert and go
  un-indexed by the subgraph — users saw "signed but nothing happened".
- New `test/MultisigActivationTrigger.spec.ts` covers the trigger
  path, the `uint128` boundary, and the activation-time arithmetic.
- Existing `Legacy`, `PremiumAutomation`, `PremiumRegistry`, and
  `TimeLockRouter` test suites hardened: cleaner signer model (no
  hardcoded impersonation), consistent `dev` ownership, and a fix to
  `EIP712LegacyVerifier.setRouterAddresses` wiring in
  `PremiumAutomation` (multisig router slot was previously pointing at
  the EOA router).
- New `MockSafeWalletWithGuard` to exercise Guard interactions in
  tests.

**Deploy / upgrade tooling**
- `scripts/deploy-multisig-router-impl.ts` — deterministic build +
  deploy of a new `MultisigLegacyContractRouter` implementation for
  upgrade via the proxy admin.
- `scripts/upgrade-multisig-legacy-router.ts` — proxy-admin-driven
  upgrade flow with a pre-flight dry-run and post-upgrade sanity
  reads.
- `scripts/delete-eoa-legacy.ts` — operator utility used during the
  Sepolia QA to unblock stuck EOA test accounts.
- `scripts/sync-ui.ts` updated to emit the refreshed address set to
  the frontend and admin panel without regenerating unrelated
  entries.

**Docs & outreach**
- `docs/SAFENET_INTEGRATION_BRIEF.md` — discussion draft for Safe
  Foundation, Safenet Validators, and Transaction Checkers covering
  our on-chain footprint, the `TransactionGuard` collision between
  our `SafeGuard` and Safenet's Guard, four resolution paths (guard
  chaining, drop-our-guard, Safenet-aware wrapper, ModuleGuard-only),
  audit link, and contact points (info@/security@ 10102.io).
- `docs/plans/solc-upgrade.md` — working plan for the forthcoming
  `solc` version bump (prerequisite for unblocking the Etherscan
  verification cosmetic).

**Addresses & tooling**
- `contract-addresses.json` refreshed with the upgraded
  `MultisigLegacyRouter` implementation and assorted Sepolia /
  mainnet corrections.
- Hardhat config and package bumps consistent with the new deploy
  scripts.

---

_Earlier history lives in git directly (`git log --oneline main`); this
file starts with the first release where we committed to a narrative
format._

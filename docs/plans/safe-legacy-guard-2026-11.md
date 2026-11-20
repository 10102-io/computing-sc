# Safe legacy fix, 2026-11

Two implementations behind their proxies, `LegacyDeployer` and
`MultisigLegacyRouter`, in one timelock batch. Found, fixed, reviewed and
scheduled on 2026-11-19. Not independently audited: three internal
reviews, a spec on the Safe's own mainnet bytecode, planted bugs, fork
walks of both networks, and the compiler checks of
`docs/security/compiler-known-bugs.md` section 10.

## Execution log

| When (UTC) | Network | What | Reference |
|---|---|---|---|
| 2026-11-19 21:34:36 | Sepolia | `LegacyDeployer.transferOwnership(UpgradeTimelock)` by the maintainer key | `0xc56be74eae3d6b9a4162f7dff23f8669e3020a2bacf41b8ac1487e7d0ba6f3b1` |
| 2026-11-19 21:35:11 | Mainnet | the same (block 26451858) | `0x1e476cf4d2dc27f951fe97b6ad88660a2ae97c5f626de83969a63c5ab89817d9` |
| 2026-11-19 22:33 to 22:34 | Sepolia | implementations deployed and verified: `LegacyDeployer` `0xA4CFf62DA7D09739C4171a8622c4c279F374F825`, `MultisigLegacyRouter` `0xf1b33394C35a2e507147cbeB33dD5eafC27FdfD3` | `0x57daac45983ae670396984f79c9c3ac3ec6b58ffa6847b80314975fb508d68c3`, `0x5c082bd9e5c701680d119eb2cd401a4b12d1e9c8541e95a42125e95fa945c34a` |
| 2026-11-19 22:35:12 | Sepolia | scheduled through the Safe, operation `0x6741f9d4dfbaffcd75139e7a83129421facd4418872b93073755b1940d8fe51c` | `0x5db0e4cf1b7f6cad8c18f758bb880fc8c495b4fa87cf31b707503df5405cd43a` |
| 2026-11-19 22:41:12 | Sepolia | **executed** (block 12171376) after the 300 s wait and a rehearsal on a fork | `0x66b77e27f69d1f0df9f79e80afa17161ada0aeaddc428a22f502eaacbaa674ad` |
| 2026-11-19 22:57 to 22:59 | Mainnet | implementations deployed and verified: `LegacyDeployer` `0xb7744Fd8Cc4728515aCE415dDc51d9244b9E89bA`, `MultisigLegacyRouter` `0x062195561F4892F9AC472714c28515553D2FA14F` | `0xaa5727a6e08bf2c7c356fb33b17a358c6bc43ae188332de9dbd8844b37b1f46e`, `0x85bffa8156f39c003729d3c0001e56f99a83dc60aee1a18f690bf83a46eaa1b9` |
| 2026-11-19 23:00:23 | Mainnet | **scheduled** through the Safe (block 26452281), operation `0x10f2ba1f0446ba6c6c16c99eb7fc8881bd1ffe6949b925303a4577ee1fc10cb4` | `0xc4d19159244662ab7c059157aa457574363218ffb2ec12ce5393e7b1e86df196` |
| from 2026-11-21 23:00:23 | Mainnet | executable by anyone | section 7 |

The day's four mainnet transactions cost about 0.001 ETH together.

The batch files are `docs/plans/batches/safe-legacy-guard-mainnet.json`
and `safe-legacy-guard-sepolia.json`. The implementations on the two
networks are the same code, byte for byte, and the code of a clean build
of this commit (`scripts/check-impl-code.ts`: deployer 4,343 bytes,
`0x58e9ce1a593e91e5548cbd79024253e595909f3c71d7780e364a8c5b4d782b3f`;
router 14,430 bytes,
`0xc6f7fffa096877794864a571a6247bac68f39c39aae79c007c7690628bad2ffc`).

To stop the mainnet operation before it executes, the guardian sends to
the timelock `0xc0Fee69ffAA1d62D701Bb277031CEc0d98AFA4Ad`, value 0, data
`0xc4d252f510f2ba1f0446ba6c6c16c99eb7fc8881bd1ffe6949b925303a4577ee1fc10cb4`
(`cancel(id)`).

## 1. What a Safe legacy is

A Safe legacy names beneficiaries for a Safe. The legacy is a module of
the Safe, and a guard, one per legacy, is the Safe's transaction guard and
keeps the time of the Safe's last transaction. When the Safe has made no
transaction for the period its owners chose, anyone may call
`activeLegacy` on the router: the legacy adds the beneficiaries as owners
of the Safe and sets the threshold the owners chose. Nothing is
transferred, and the owners who are there stay.

## 2. What was wrong

1. **Anyone could move a guard's clock.** Version 1 of the guard counted
   the Safe's own call, and also a call from any other address that
   carried signatures over the Safe's previous transaction. Its copy of
   the Safe's signature check had lost the question whether the signers
   are owners of the Safe, so signatures of any keys passed. Anyone could
   keep a Safe legacy from ever activating, for the price of one small
   transaction per period. Nothing could be activated early and nothing
   could be moved. The report of January 2025 has this class as 5.1.1
   ("anyone can ... permanently prevent a Will from being activated",
   resolved); the path with signatures was the resolution, and neither
   report names the missing owner check.
2. **The router activated on the guard's time alone.** A guard only keeps
   time while it is the Safe's guard. A Safe that took the guard off and
   left the legacy enabled as a module went on working with the clock
   stopped, and once the period had passed on that stopped clock its
   beneficiaries could be added as owners of a Safe in daily use. No
   legacy on mainnet is in that state.
3. **A guard never sees the transaction that sets it.** A Safe reads its
   guard before it executes. So the wait ran from the creation of the
   legacy and not from its set-up on the Safe, and a guard that was taken
   off and set again knew nothing of what the Safe did in between.
4. **Smaller, found on the way.** A beneficiary whom the Safe had made an
   owner in the meantime made the whole activation fail, for every
   beneficiary. `address(1)`, which a Safe keeps for the head of its owner
   list, was accepted as a beneficiary, with the same effect. The router's
   check went on answering `true` for a legacy that was activated. A
   contract that answered two questions the way a Safe does (its guard
   slot, its module list) passed the router's `onlySafeWallet` and could
   rename a legacy and emit a note for it. `LegacyDeployer`'s owner passed
   `onlyRouter`, and its implementation could be initialised and owned by
   anyone (which never reached the proxy).

## 3. What changes

**The guard, version 2** (`contracts/SafeGuard.sol`), for every legacy
created after the upgrade. It keeps the time and the Safe's nonce in one
slot, and they move on two occasions only:

- the Safe calls a hook: `checkTransaction` for a transaction its owners
  signed, and `checkModuleTransaction` on Safe 1.5.0 when the guard is set
  as the module guard too;
- anyone calls `sync()` while the Safe's nonce is not the one the guard
  noted. That is proof that the Safe executed a transaction the guard did
  not see: the Safe was active at some time up to now, so the clock starts
  again now.

No hook reverts, whatever the address behind the guard answers, so the
guard cannot stand between a Safe and its transactions. `GUARD_VERSION`
is 2; a version 1 guard has no such getter.

**The router** (`MultisigLegacyRouter`), for every legacy, also those that
exist:

- `activeLegacy` goes through only while the legacy is set up on its Safe
  (its guard is the Safe's guard, the legacy an enabled module) and the
  guard has seen the Safe's last transaction (`GuardBehindSafeWallet()`
  otherwise). A version 1 guard keeps no nonce and is taken at its word.
- `checkActiveLegacy` answers `false` wherever `activeLegacy` reverts, an
  activated legacy included.
- The setters take calls from the legacy's own Safe only
  (`SenderIsNotSafeWalletOfLegacy()`).

**A new legacy** (`MultisigLegacy`, deployed per legacy) skips a
beneficiary who is an owner of the Safe already and refuses `address(1)`.

**`LegacyDeployer`** serves the three routers and nobody else, its
implementation cannot be initialised, and its owner is the
`UpgradeTimelock` on both networks since 2026-11-19
(`scripts/handover-legacy-deployer.ts`), so naming another router waits
out the delay in public.

Storage: both layouts are identical to the live ones. Interface: the
router gains two errors and nothing else; no event changes, so the
subgraph is not touched. No address changes.

**The app** (`computing`, live before the upgrade): the set-up is three
calls in one Safe transaction, set the guard, enable the module, and the
Safe calls the guard's hook itself, so the wait starts at the set-up and
the guard is never behind. The same batch works on a version 1 guard.
"Check contract's status" reads why a legacy cannot be activated and
offers to have a missed transaction counted; the printed claim card says
the same for a holder of the paper alone. On Safe 1.5.0 with a version 2
guard the set-up is four calls: it also sets the guard as the Safe's
module guard, when the Safe runs none of its own or only what an earlier
legacy left there, and the delete takes it off again. A card shows one
line in place of the countdown for a legacy that is off its Safe or
whose guard is behind. The worker holds a Safe legacy's reminder emails
in the same two cases, because the contract it asks which reminders are
due (`PremiumReminderView`, no proxy) only knows whether the Safe runs a
guard. Both go by the router that answers, read from the implementation
its proxy holds: until the upgrade executes on a network, the router
there activates on the guard's time alone, so only a legacy that is no
module of its Safe is treated as one that cannot be activated. The
change-over needs no release.

## 4. Who has to do something

- **A Safe legacy created before the upgrade keeps its version 1 guard**:
  a guard is not upgradeable, and a legacy pins its guard. Finding 1 stays
  open for it. Its owners delete it and create it again after the upgrade
  to get a version 2 guard (the spec walks it on each Safe version). On
  mainnet there are three such legacies: one is off its Safe already,
  one is the founder's, one is another user's, who is told by the
  founder. The app tells the owners too: from the moment a network's
  router creates version 2 guards, the page of a live legacy on a
  version 1 guard carries a note that says how to get the new one. It
  reads that from the chain, so no release follows the execution.
- **The router's rules reach every legacy at the execution.** For the
  three on mainnet nothing changes in what can be activated: the two that
  are set up stay as they are, and the one that is off its Safe could not
  be activated before either (walked on a fork, section 5).
- Beneficiaries need nothing. The claim guide and the printed card name
  the new answers.

## 5. Evidence

- **Spec** `test/SafeGuard.spec.ts`, 104 cases, on the bytecode of Safe
  1.3.0, 1.4.1 and 1.5.0 as it is on mainnet (singleton, proxy factory,
  fallback handler, MultiSendCallOnly; `scripts/safe-bytecode.mjs` reads
  and pins it, `test/fixtures/safe-bytecode.json`), and on the version 1
  guard's mainnet bytecode: strangers move a version 1 clock and not a
  version 2 one; the app's batch on both versions; each way a Safe can be
  off its legacy; module transactions with and without the module guard;
  the four-call set-up of Safe 1.5.0 and its delete; a legacy deleted
  and created again on the same Safe; a guard bound to an address that
  is no Safe; the lookalike contract.
- **A random walk against a model**, in the same spec ("in any order of
  events"): on each Safe version, two seeded runs of 60 steps drawn from
  everything that can happen to a legacy's clock (Safe transactions,
  also failing ones; waits shorter and longer than the legacy's;
  strangers at every hook; `sync`; the guard and the module taken off
  and put back; modules acting; the module guard set and cleared). After
  every step the guard's time and nonce, the Safe's guard and module,
  the router's `checkActiveLegacy` and the reason `activeLegacy` gives
  must equal what a model of a few lines says, and each run ends in a
  stranger's activation.
- **Planted bugs**: `scripts/mutations/safe-legacy.cjs` plants 27 bugs,
  one at a time, in the guard, the router, its factory base, the legacy
  and the deployer. The spec catches all 27; the random walk alone
  catches 17: every one planted in the guard's hooks and in `sync`, and
  every one that has the router activate a legacy it should refuse, or
  answer `true` for it. The other ten are rules the walk does not go
  near (a second `initialize`, the nonce read at the creation, a
  version 1 guard, the deployer's access, who may change a legacy, an
  heir who is an owner already, the threshold), which the named cases
  hold.
- **The whole suite**: 603 passing (`HARDHAT_NO_FORK=1`).
- **Fork walks** (`scripts/rehearse-safe-guard.ts`, no key): on a fork of
  each network, every getter, record and storage slot of both proxies
  reads the same after the swap; every legacy that exists answers as
  section 4 says; each that is set up activates after its wait; a new
  Safe of each version goes from creation to activation through every
  refusal on the way; and wallet legacies are created and claimed through
  the new deployer. On Sepolia it was run again after the execution, on
  the live implementations; on mainnet on the implementations that wait
  in the timelock.
- **The scheduled operation**, rehearsed on a fork of mainnet
  (`scripts/rehearse-timelock-op.ts`): refused before its time, executes
  from an address with no role with 75,725 gas, and changes two of the 45
  values read, the two implementations.
- **Reviews**: three internal ones on the day, each folded in before the
  next. The third, on the changes since the second, found no way for a
  stranger to move a version 2 clock, no early activation and no hook
  that can revert; what it did find is in the code (section 2, item 4)
  and in section 6.
- **Static analysis**: Slither 0.11.6 on the four contracts, before and
  after the fix. No result is a vulnerability and the fix adds none at
  Medium or above; every result is triaged in
  `docs/security/static-analysis.md` ("Safe legacy contracts"), and CI
  repeats the run on every pull request as a report.
- **Not done**: the Foundry fuzz and invariant suites in CI cover Shield
  Vault and the wallet legacy v3, not these contracts. What stands in
  their place here is the random walk and the planted bugs above, both
  on the real Safe bytecode, which a Foundry suite of ours would have to
  mock.

## 6. Limits

- **A Safe used only through a module looks idle to its legacy.** A
  module acts for the Safe without its owners' signatures and without a
  nonce. On Safe 1.3.0 and 1.4.1 no guard hears of it. On Safe 1.5.0 the
  guard hears of it once it is set as the module guard too
  (`setModuleGuard`), which the app's set-up does. The other side of
  that: a module that moves on its own, such as a standing allowance,
  then counts as activity of the Safe and keeps the wait from ending for
  as long as it runs.
- **A guard that is behind waits for someone.** Until `sync()` is called
  the legacy cannot be activated, and the wait starts again when it is.
  The app's own set-up does not produce this state.
- **Version 1 guards stay as they are** (section 4).
- **`sync()` can be called by anyone, only when it is true.** It cannot
  move a clock for a Safe that did nothing.
- **Contracts that are not behind a proxy keep their code.** The four
  routers of 2024 (README, "Project history & audits") are not
  upgradeable, and the guard of that year has the weakness of section 2,
  item 1, in a plainer form. Read on 2026-11-19: they hold one legacy
  between them (`willId()` of the August router is 1, `_willId()` of the
  three October routers is 0), and it is off its Safe, neither its guard
  nor its module is on it. The app has not created through them since
  2024.
- **The retired Safe-to-wallet transfer router is empty and closed.** It
  was retired in May 2026 and its source removed. On mainnet its proxy
  (`0x7e173738f0bE8B4bDbA28CF91b0F5B0263Aa4b0C`, under the same proxy
  admin and timelock) holds no legacy and can create none: the deployer
  no longer serves it (`transferLegacyRouter()` is the zero address on
  both networks). On Sepolia the retired routers hold test legacies with
  version 1 guards and the rules of their day.

## 7. Execution on mainnet

From 2026-11-21 23:00:23 UTC, by anyone:

```powershell
$env:REHEARSE_NETWORK='mainnet'; $env:TL_BATCH='docs\plans\batches\safe-legacy-guard-mainnet.json'
npx hardhat run scripts/rehearse-timelock-op.ts          # no key: must pass, 2 values change
$env:TL_ACTION='execute'
npx hardhat run scripts/timelock-op.ts --network mainnet
$env:IMPLS='LegacyDeployer,MultisigLegacyRouter'
npx hardhat run scripts/refresh-impl-artifacts.ts --network mainnet
npx hardhat run scripts/verify-governance.ts --network mainnet
$env:WALK_NETWORK='mainnet'
npx hardhat run scripts/rehearse-safe-guard.ts           # the live implementations, on a fork
npm run sync-ui:check
```

Then: the founder creates his Safe legacy again and the first version 2
guard on mainnet is verified on Etherscan and Sourcify (every later guard
is the same code); the claim guide in `computing-docs` names the new
answers as live; the pull request is merged.

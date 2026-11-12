# Known compiler bugs and the contracts on mainnet

Checked 2026-11-12 against the compiler team's list as of solc 0.8.38
(released 2026-10-22). Scope: every contract of ours on Ethereum mainnet,
live or retired, and every legacy the two routers ever created. Scripts:
`scripts/compiler-bugs/` (section 7). None of them sends a transaction or
reads a signing key.

## 1. Result

**No known compiler bug is found to apply to any contract of ours on
mainnet.** Nine of the ten are excluded outright. For the tenth the
compiler team's own check finds nothing, which is a strong indication and
not a proof (section 5).

- Every contract was **rebuilt from source and equals the code on the
  chain**: 41 contracts (21 on solc 0.8.35, 20 on solc 0.8.20), among them
  the code behind all 48 legacies. One of them (the Safe guard of the
  three multisig legacies) equals the chain in everything but the metadata
  hash. So each statement below is about the code that runs, not about a
  source tree that may have drifted from it.
- The ten known bugs of the two compilers fall in three groups. Seven
  cannot occur with our settings or sources (section 3). The two "spill"
  bugs corrupt a variable the compiler moved to memory in code with mutual
  recursion: no contract has both (section 4). For the optimizer bug fixed
  in 0.8.38, which no source pattern excludes, compiling with and without
  the fix gives identical bytecode for 40 of the 41; the one that could
  not be compiled that way is a retired contract that holds nothing.
- The proxies and the ProxyAdmin are hardhat-deploy's shipped OpenZeppelin
  bytecode (solc 0.8.10, old code generator). The chain holds exactly that
  bytecode, and its sources contain none of the constructs the known bugs
  of 0.8.10 need (section 6).
- A by-product: the two old clone implementations and the 22 first EOA
  legacies, which no verifier could match, are reproduced byte for byte
  and, since 2026-11-12, verified on Sourcify and Etherscan (section 2.3).

Limits are in section 8, what is left in section 9.

## 2. What is on mainnet, by compiler

Read from the chain (`live-compilers.mjs`, `legacy-census.mjs`): the solc
version is in the metadata at the end of each contract's code.

| Compiler | Settings | Contracts |
|---|---|---|
| 0.8.35 `47b9dedd` | viaIR, optimizer 200 runs, cancun | 21: every implementation, vault and registry deployed since 2026-07-27 |
| 0.8.20 `a1b79de6` | viaIR, optimizer 200 runs, paris | 20: the implementations from before, and every legacy contract from before the clones |
| 0.8.10 `fc410830` | old code generator, optimizer 999,999 runs | 17: the 16 proxies and `DefaultProxyAdmin` (hardhat-deploy 0.11.45, OpenZeppelin code) |
| 0.7.6 | | 1: the governance Safe's proxy (Safe's code) |
| none | | 23 legacies are EIP-1167 clones of the implementations above: 45 bytes each, no compiler |

No contract on mainnet was built with 0.8.22 (the second compiler the
repository had until July).

### 2.1 solc 0.8.35 (21)

Sixteen are builds of the current source tree (the artifact equals the
chain, immutables masked): the implementations of `EIP712LegacyVerifier`,
`PremiumSetting`, `PremiumRegistry`, `TimeLockRouter`, `TimelockERC20`,
`TimelockERC721`, `TimelockERC1155`, the router implementation that waits
in the timelock (`0x8F89…74eb`), `LegacyPullVault` v1 and v2,
`UpgradeTimelock`, `QuantumRecoveryRegistry`, `ShieldVault` v2,
`ShieldVaultV3`, `NftCollectionWhiteList` and `TransferEOALegacyV3`.

Five are older builds, each rebuilt from its verified input on Sourcify
(exact match) and equal to the chain:

| Address | Contract | Role |
|---|---|---|
| `0xe3d1bc20b92cd38d3c154f1b97a1a288b0e706a1` | TransferEOALegacyRouter | the router's implementation until the 2026-11-13 execution |
| `0x2e2de6475fcbe77e7930499981850d37b237924c` | TransferEOALegacy | clone implementation since 2026-11-07 (1 legacy) |
| `0xddea11d92ddd0746dbe2899f35a79a145660a7c3` | TransferEOALegacy | clone implementation before that (11 legacies) |
| `0x148469d1ff87a3fbe3a1fce14bc7e348f2df61a3` | TransferEOALegacy | the first 0.8.35 clone implementation (2 legacies); not in `contract-addresses.json`, found by the census |
| `0x83074f8519f54af05f7c48911e432e0c44dbee69` | ShieldVault v1 | the first vault, replaced by v2 |

### 2.2 solc 0.8.20 (20)

| Address | Contract | Input |
|---|---|---|
| `0x4807…7de4` | Payment | Sourcify |
| `0xfbc5…477d` | LegacyDeployer implementation | Sourcify |
| `0x0935…825e` | MultisigLegacyRouter implementation | Sourcify |
| `0x7812…4fe9`, `0x72b6…1993` | TokenWhiteList, current and the one before | Sourcify |
| `0x3c71…5e1f` | Banner implementation | Sourcify |
| `0x8a5a…7a4d`, `0xea19…1a40` | PremiumReminderView, current and v1 | Sourcify |
| `0x90a3…ba69` | PremiumAutomationManager implementation (retired) | Sourcify |
| `0xbf10…9922` | PremiumMailRouter implementation (retired) | Sourcify |
| `0x1a71…11e8` | PremiumMailReadyToActivate implementation (retired) | Sourcify |
| `0xb577…12ee` | PremiumMailBeforeActivation implementation (retired) | `deployments/mainnet/solcInputs/d1a536ba…` (new) |
| `0xc100…faff` | PremiumMailActivated implementation (retired) | `deployments/mainnet/solcInputs/d1a536ba…` (new) |
| `0x19e4…a323` | TransferEOALegacy, clone implementation (2 legacies) | Sourcify |
| `0x314f…233c` | TransferEOALegacy, clone implementation (6 legacies) | `deployments/mainnet/solcInputs/edea9ede…` (new) |
| `0xd5ba…2200` | TransferEOALegacy, clone implementation (1 legacy) | rebuilt from history, section 2.3 (new) |
| `0x3899…5582` | EOA legacy 1, its own full bytecode | `deployments/mainnet/solcInputs/78f91df3…` (new) |
| `0x3f34…3a42` and 20 more | EOA legacies 2 to 22, one identical full bytecode | rebuilt from history, section 2.3 (new) |
| `0x666a…9b52` and 2 more | the 3 multisig legacies, one identical full bytecode | `deployments/mainnet/solcInputs/0f5d70c5…` (verified on Etherscan before; new on Sourcify for two of the three) |
| `0xa1cd…0285` and 2 more | the Safe guards of the 3 multisig legacies, one identical bytecode | Sourcify (match: the code is equal, the metadata hash is not) |

"Sourcify": the input Sourcify held before this check. "(new)": no
verifier had the contract; its input was found here and is on Sourcify and
Etherscan since 2026-11-12 (section 2.3). Full addresses:
`contract-addresses.json`, and for the legacies the census output.
"Retired": the Chainlink Automation upkeeps are cancelled and the
Functions subscription no longer exists (`docs/CONTRACTS_REFERENCE.md`);
nothing calls these contracts.

The legacies: the EOA router has created 45 (22 with their own full
bytecode, 23 clones of six implementations), the multisig router 3, each
with a guard. 34 legacies run 0.8.20 code, 14 run 0.8.35 code. The census
groups them by code hash, so "one identical bytecode" is read from the
chain, not assumed.

### 2.3 The builds no verifier could match

The clone implementations of April and May 2026 (`0x314F…233C`,
`0xD5bA…2200`) and the first 22 EOA legacies were not verified on
Etherscan or Sourcify; for the clone implementations the bytecode a
verifier builds did not match. The reason was known (`hardhat.config.ts`:
with viaIR, solc 0.8.20 emits different bytecode depending on which other
files are in the same compile job), but the jobs that give the deployed
code had not been found. They are now, **byte for byte, metadata hash
included**:

| Contract | The job that gives the code on the chain |
|---|---|
| `0x314F…233C` | the recorded input `edea9ede…` as it is (57 sources) |
| EOA legacy 1 | the recorded input `78f91df3…` as it is (60 sources) |
| EOA legacies 2 to 22 | the whole job (61 sources) with our sources as of commit `6ee2429` (2026-03-09); no recorded input holds these sources |
| `0xD5bA…2200` | our sources as of commit `4bbbff2` (2026-05-04) in the 49-source job Hardhat builds from a warm cache when only `TransferLegacyEOAContract.sol` changed: that file and `LegacyDeployer.sol`, which imports it, with their dependencies |

For `0xD5bA…2200` the three job shapes give three different results from
the same sources: the whole job (57 sources) 18,428 bytes, the contract's
own dependency closure (28 sources, what a verifier builds) 18,336 bytes,
the warm-cache job 18,435 bytes, which is the chain. Hardhat compiles
incrementally: after a change it rebuilds only the files whose imports
reach the changed file. The code deployed on 2026-05-04 is the output of
such a build, and no input was recorded for it.

The dependency sources (OpenZeppelin and the rest, as they were then) come
from the recorded inputs of that period; our own from git.
`rebuild-from-history.mjs` rebuilds each of the three shapes. Since
2026-11-07 each clone implementation compiles in a Hardhat job of its own
(`scripts/check-clone-reproducible.ts`), so its build is the one a
verifier builds.

**Verified 2026-11-12** (founder's approval the same day). The inputs were
submitted to Sourcify (`verify-on-sourcify.mjs`), which compiles them
itself: an exact match of runtime and creation code for the two clone
implementations, EOA legacies 1 to 22, the multisig legacies and the two
retired mail implementations. Etherscan shows all of them as verified too
(`verify-on-etherscan.mjs`: `0x314F…233C` was submitted there, the others
were verified there by the time they were read). So a second party has
rebuilt each of these contracts to the bytes on the chain. The three Safe
guards stay a Sourcify "match": their code is equal, the metadata hash is
not, and no input with that hash was found.

## 3. The known bugs, one by one

0.8.35 has six known bugs, 0.8.20 has eight; four are shared, ten in all
(`known-bugs.mjs`; the full texts with `--text`).

| Bug | Severity | In | Needs | Ours |
|---|---|---|---|---|
| UnsoundSpillInMutualRecursion | medium | 0.8.35, 0.8.20 | viaIR; mutually recursive functions with intersecting cycles, one of them with a variable moved to memory | section 4 |
| SpillSlotCollisionAcrossMutualRecursion | low/medium | 0.8.35, 0.8.20 | viaIR; a cycle of two or more functions that reaches a function with variables moved to memory | section 4 |
| YulOptimizerKnowledgeBaseStaleBookkeeping | low | 0.8.35, 0.8.20 | the optimizer; cannot be judged from the source | section 5 |
| InheritanceOrderReversalOnStorageEndWarning | medium | 0.8.35 | a `layout at` specifier that puts storage near its end | no `layout at` in any source of any input; and 0.8.36, which fixes it, gives identical bytecode for every 0.8.35 build |
| MisorderedNamedParametersInRequireWithCustomErrors | very low | 0.8.35 | `require(cond, Err({name: value}))` | none in any source of any input, dependencies included (our own sources have no `require` with a custom error at all) |
| MemoryByteArrayElementDeleteClearsWholeWord | low/medium | 0.8.35, 0.8.20 | the old code generator (viaIR off) | every build of ours is viaIR |
| MissingSideEffectsOnSelectorAccess | low | 0.8.20 | the old code generator (viaIR off) | every build of ours is viaIR |
| LostStorageArrayWriteOnSlotOverflow | low | 0.8.20 | an array that straddles the last storage slot | a fixed array cannot reach it (0.8.20 has no custom layout, storage starts at slot 0); a dynamic array only if a keccak-256 hash lands within its length of the end |
| VerbatimInvalidDeduplication | low | 0.8.20 | Yul's `verbatim` | none in any source |
| FullInlinerNonExpressionSplitArgumentEvaluationOrder | low | 0.8.20 | an own optimizer step sequence | every input uses the default sequence |

The settings and the source patterns are read from the exact compiler
input of each build (step 0 of `live-builds.mjs`; `tree-call-graph.mjs`
for the 153 sources of the current tree). The pattern counter runs against
a planted case of each pattern on every start and refuses to work if it
misses one.

## 4. The two spill bugs

When a function runs out of stack, the compiler moves some of its
variables to fixed memory slots. Both bugs are in that step, both need
recursion across at least two functions, and both do their damage to a
moved variable. So a contract is out of reach if nothing was moved, and
also if it has no such cycle.

For every build the call graph of every Yul object is searched for cycles
(Tarjan's algorithm), in the unoptimized IR (every function the contract
has) and in the optimized IR (the code this step works on). The search
runs against a planted cycle first and stops if it does not find it.
Whether anything was moved is read from the compiler's own marker: the
`memoryguard` value of an object, which the step raises when it reserves
slots.

| Builds | Unoptimized IR | Optimized IR | Variables moved to memory |
|---|---|---|---|
| current tree, 66 contracts (0.8.35) | 0 cycles in 15,291 functions | 0 cycles in 1,297 functions | in 1 (TimelockERC1155) |
| 5 older 0.8.35 builds | 0 cycles | 0 cycles | in none |
| 17 of the 0.8.20 builds | 0 cycles | 0 cycles | in 4 (clone implementations `0x314f…` and `0xd5ba…`, EOA legacy 1, EOA legacies 2 to 22) |
| PremiumMailReadyToActivate, BeforeActivation, Activated (0.8.20, retired) | 1 cycle each | no cycle of two or more; one function that calls itself | in none |

Where something was moved there is no recursion of any kind, and where
there is recursion nothing was moved. The one cycle is in Chainlink's
`Buffer` library (`append` calls `resize`, which calls `append`); the
optimizer folds it into a single self-calling function, which is not the
condition of either bug, and in those three contracts no variable was
moved at all.

For the 0.8.35 builds there is a second, independent piece of evidence for
UnsoundSpillInMutualRecursion: solc 0.8.36, the release that fixes it,
produces identical bytecode for all 66 contracts of the tree and for the
five older builds (`tree-version-diff.mjs`; step 2 of `live-builds.mjs`).
The later releases cannot be used this way, because they change the
optimizer's output for other reasons: under 0.8.37 eight contracts differ
(in the ones read with `ir-diff.mjs`, expressions that do not change
inside a loop are moved out of it) and under 0.8.38 59 of 66 (the
calldata-length check at the start of a contract is one byte shorter).

## 5. The optimizer bug fixed in 0.8.38

`YulOptimizerKnowledgeBaseStaleBookkeeping`: the optimizer could treat two
memory or storage locations as different when they were the same, and then
replace a read with an old value or drop a needed write. It depends on the
intermediate code the optimizer sees, so no source pattern rules it out.
The compiler team rates it low; in its scan of about 283,000 verified
viaIR compilations on Sourcify, none changed with the fix.

The team's notice gives three checks. This is the first: compile with the
builds on either side of the fix, same settings, and compare the bytecode
with the metadata set aside. The builds are the nightlies
`0.8.38-nightly.2026.10.13+commit.ce5702db` (before) and
`0.8.38-nightly.2026.10.14+commit.8bff1c3a` (after).

| Builds | Result |
|---|---|
| current tree, 66 contracts | 66 identical (`tree-nightly-pair.mjs`) |
| 5 older 0.8.35 builds | 5 identical |
| 0.8.20 builds | 19 identical; PremiumMailActivated does not compile under either nightly (stack too deep) |

Each comparison first confirms that the two raw outputs differ (each
build writes its own version into the metadata), then sets the metadata
aside and requires that it was found in every contract, so an empty
comparison cannot pass. The sources are compiled as deployed except for
the exact `pragma solidity` lines, which a nightly would refuse.

What this is worth, in the team's words: "a strong indication rather than
a guarantee", because the comparison runs the nightly's optimizer, not the
one that built the contract. For the 0.8.35 builds the two are under six
months apart. For the 0.8.20 builds they are more than three years apart,
so the indication is weaker there. PremiumMailActivated is retired, holds
nothing, and is called by nothing.

The check that settles it is the team's third: apply the fix to the exact
release a contract was built with and compare. It needs solc 0.8.35 and
0.8.20 built from source with the patch (four files). Not done (section 9).

## 6. Code that is not ours

- **Proxies and ProxyAdmin (solc 0.8.10).** hardhat-deploy deploys the
  bytecode it ships, built by its authors, not by this repository.
  `proxy-artifacts.mjs` shows that all 16 proxies equal the shipped
  `OptimizedTransparentUpgradeableProxy` except for its one immutable,
  which holds the `DefaultProxyAdmin` address in each, and that the
  ProxyAdmin equals the shipped `ProxyAdmin` exactly. 0.8.10 has 11 known
  bugs (the optimizer bug of section 5 is not among them: it came with
  0.8.19). Two need viaIR, which this build does not use. For the other
  nine the script counts, in the shipped sources, what each needs:
  `delete`, `.selector`, `verbatim`, an array in calldata, an array, bytes
  or string state variable, an override with parameters, an own optimizer
  step sequence. All zero.
- **The governance Safe (solc 0.7.6)** is Safe's canonical proxy in front
  of Safe's singleton, the code every Safe runs. Not assessed here.
- Permit2, WETH, the Uniswap router and the tokens are other parties'
  deployments.

## 7. Running it again

When a new solc release or a compiler bug notice appears, start with
`known-bugs.mjs`: a bug that reaches back to 0.8.35 or 0.8.20 shows up
there, and what it needs decides which of the checks below answers it.

```powershell
npx hardhat compile
node scripts/compiler-bugs/known-bugs.mjs 0.8.35 0.8.20 0.8.10 0.7.6
node scripts/compiler-bugs/get-compilers.mjs 0.8.36 0.8.37 0.8.38 nightly

# what is on mainnet
node scripts/compiler-bugs/live-compilers.mjs mainnet
node scripts/compiler-bugs/legacy-census.mjs
node scripts/compiler-bugs/proxy-artifacts.mjs mainnet

# the current tree
node scripts/compiler-bugs/tree-call-graph.mjs
node scripts/compiler-bugs/tree-version-diff.mjs 0.8.36 0.8.37 0.8.38
node scripts/compiler-bugs/tree-nightly-pair.mjs build before
node scripts/compiler-bugs/tree-nightly-pair.mjs build after
node scripts/compiler-bugs/tree-nightly-pair.mjs compare

# where the inputs of the old contracts came from (they are on Sourcify since 2026-11-12,
# so live-builds.mjs below needs none of this any more)
node scripts/compiler-bugs/find-input.mjs 0x3899c31dfc00252e2a439a15f805fa3d125e5582 0x666a7d35c87e34667772749540a31559e2819b52 0x314f512c2420b5f7548e95f5c5438fedb2d9233c
$env:SOURCES='PremiumMail'; node scripts/compiler-bugs/find-input.mjs 0xb5773aa9d3e599d9e6e498448ff6773180d712ee 0xc1000617e198f0ec7e33399c31cd07d5deb9faff; Remove-Item Env:SOURCES
node scripts/compiler-bugs/rebuild-from-history.mjs deployments/mainnet/solcInputs/78f91df3e055e7ce8000f367ae97c0f8.json 6ee2429 0x3f34c84bc6101e4abd0f8cbf65efe9b8956b3a42
$env:CHANGED='contracts/forwarding/TransferLegacyEOAContract.sol'; node scripts/compiler-bugs/rebuild-from-history.mjs deployments/mainnet/solcInputs/edea9ede6ebe5fcfbac6004dd97b58e9.json 4bbbff2 0xD5bA2799fc2e5bc250a50251896A6d7E1c792200; Remove-Item Env:CHANGED

# publishing an input found here: public and not reversible, a dry run without --submit
node scripts/compiler-bugs/verify-on-sourcify.mjs <address>...
node scripts/compiler-bugs/verify-on-etherscan.mjs <address>...

# every contract the tree no longer builds: the 5 of section 2.1, the 20 of section 2.2
node scripts/compiler-bugs/live-builds.mjs 0xe3d1bc20b92cd38d3c154f1b97a1a288b0e706a1 0x2e2de6475fcbe77e7930499981850d37b237924c 0xddea11d92ddd0746dbe2899f35a79a145660a7c3 0x83074f8519f54af05f7c48911e432e0c44dbee69 0x148469d1ff87a3fbe3a1fce14bc7e348f2df61a3
node scripts/compiler-bugs/live-builds.mjs 0x4807c7b2e6e3913b5280c711bab7b0465d347de4 0xfbc58f0b910046c441ecc34c82321c7c26f1477d 0x0935720d098800ca59567dde2d2bc3d74c80825e 0x90a3574a88fb5cbeb3e220a212d94bf3d1abba69 0xbf10f978de45e76338c1558cc26ca9feaff69922 0xb5773aa9d3e599d9e6e498448ff6773180d712ee 0xc1000617e198f0ec7e33399c31cd07d5deb9faff 0x1a7131b070b80a5467198ce671191ee14e3511e8 0x7812777a23877159861d3de567dd97f9d9f64fe9 0x3c71abda7b46ff0d78568a095035ded046095e1f 0x72b6ad53533a618a6fdc07d8d1b8a3c980f21993 0xd5ba2799fc2e5bc250a50251896a6d7e1c792200 0x8a5af2c367b7420300547b03be5f4c720c027a4d 0xea190ee175e180c375fd9796aa11fdaa26f71a40
node scripts/compiler-bugs/live-builds.mjs 0x19e46cf959aa3b19a85fbd9352b2eb0ccb21a323 0x314f512c2420b5f7548e95f5c5438fedb2d9233c 0x3899c31dfc00252e2a439a15f805fa3d125e5582 0x3f34c84bc6101e4abd0f8cbf65efe9b8956b3a42 0x666a7d35c87e34667772749540a31559e2819b52 0xa1cdbd3b0c95a8396ca233960a885aed21e20285
```

The scripts read `MAINNET_RPC_URL` from `.env` (read-only calls;
`verify-on-etherscan.mjs` also the Etherscan API key) and keep their work
files outside the repository (`COMPILER_BUGS_DIR`, default the system temp
folder). Each exits non-zero when something needs a look. All of them ran
on 2026-11-12 from an empty work folder with the results above, and the
old contracts once more after their verification, with the inputs taken
from Sourcify. The three `live-builds.mjs` runs take about ten minutes
together.

## 8. Limits

- **Known bugs only.** Nothing here speaks about compiler bugs nobody has
  found yet. That risk is carried by the tests, the fuzz and invariant
  suites and the reviews, which run the compiled code.
- **Section 5 is an indication, not a proof,** weaker for the 0.8.20
  builds, and PremiumMailActivated could not be checked at all.
- **The call graph is read from text.** The cycle search reads the
  compiler's IR output with a small parser of its own. It is tested
  against a planted case on every run, and for the 0.8.35 builds the
  0.8.36 comparison stands beside it. The source patterns of section 3
  are counted with regular expressions, tested the same way.
- **Third-party code is compared, not rebuilt.** The proxies equal
  hardhat-deploy's shipped bytecode; that bytecode was not recompiled from
  OpenZeppelin's sources here.
- **Mainnet only.** On Sepolia the 16 live contracts built from the
  current tree equal its build (`live-compilers.mjs sepolia`); the older
  test contracts there (0.8.20, three on 0.8.22) are listed, not assessed.
- **A list frozen in time.** The compiler team adds to its list. Section 7
  is how to find out.

## 9. What is left

- **The next train compiles with 0.8.38** (`docs/plans/solc-upgrade.md`),
  whose list is empty today. Legacies that exist keep the code they have:
  a clone pins its implementation.
- **The definitive check for the optimizer bug** (section 5): solc 0.8.35
  and 0.8.20 built from source with the fix, compared with the releases
  for the 41 contracts. A build job on a Linux runner; open.

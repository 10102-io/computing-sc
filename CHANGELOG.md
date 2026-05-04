# Changelog — 10102 Computing (contracts)

This file is the canonical, human-readable narrative of what each release
of the smart-contract repo actually **ships on-chain**. Commit messages on
`main` are mechanical (squash-merges of `dev`); the prose here is where
the headline story lives.

## How this file is maintained

- One entry per squash-merge of `dev` into `main`, plus a separate entry
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

## [Unreleased on `main` — already live on mainnet]

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

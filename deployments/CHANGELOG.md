# Deployment changelog

Human-readable record of every set of on-chain mutations executed against
our deployed contracts. Each entry should answer the four questions a
future maintainer (or auditor) will ask:

1. **What changed on chain?** (proxy impls, fresh contracts, wiring txs)
2. **Why?** (link to the commit / audit finding / incident)
3. **What didn't change but you might think did?** (impl bumps with no
   semantic delta, contracts that hit the metadata-drift trap and were
   intentionally left alone, etc.)
4. **What follow-ups remain?** (token migration, subgraph update, frontend
   ABI bump, etc.)

Newest entries first. When in doubt, write more — the cost is dirt cheap
compared to a missed regression.

---

## 2026-05-19 — Sepolia premium-history cleanup (forced re-subscription)

**Network:** Sepolia only
**Linked incident:** the May 18 redeploy of `PremiumRegistry` as a fresh
proxy at `0xE243…70Fb` left `PlanSubcribed` events from the previous
`PremiumRegistry_v1` (`0x6495…794d`) and `PremiumRegistry_nonUpgradeable_v2`
(`0xC3c5…0246`) deployments un-indexed by the new subgraph. The admin's
billing list came up empty even though those users still carried a
non-zero `PremiumSetting.premiumExpired` (which was NOT redeployed).

### What changed
- Called `PremiumSetting.resetPremium(user)` for the 7 historical
  Sepolia subscribers (all currently-active, none expired). Their
  `premiumExpired` is now `0` on-chain.
- Each user must re-subscribe through the dApp; the new subscription
  flows through the canonical `PremiumRegistry` (`0xE243…70Fb`) and the
  new event will be indexed by the current subgraph immediately.

### What didn't change
- Mainnet — its `PremiumRegistry` (`0x44Ae93…BEA27`) has been the same
  address throughout, so all production subscribers remain visible.
- `PremiumSetting`, `UserConfig`, `LegacyConfig`, watcher state, and
  every existing legacy contract were untouched. Only the
  `premiumExpired[user]` mapping cell was zeroed.

### Tooling
- New `scripts/sepolia-reset-legacy-premium-users.ts` (dry-run by
  default, `EXECUTE=1` to apply). Safe to re-run — `resetPremium`
  reverts on already-zero entries, so the script naturally becomes a
  no-op once the cleanup is complete.

---

## 2026-05-19 — Cross-repo address sync + subgraph cleanup

**Networks:** Sepolia, mainnet (subgraph-only)
**Linked incident:** `contract-addresses.json` (this repo) was the canonical
source post-`v2026.05.18`, but the manual `npm run sync-ui` → "copy into
sister repos" step was skipped during the Phase A rollout. Both
`computing/src/configs/contract-addresses.generated.ts`,
`computing-admin/src/configs/contract-addresses.generated.ts`, and
`computing-subgraph/networks.json` were left pointing at deprecated /
sunset addresses for up to a day before this catch-up.

### What changed
- **Frontend** (`computing`): mainnet `tokenWhitelist` now points at the
  new whitelist `0x7812…4FE9`; mainnet + sepolia `forwarding` cleared
  (Safe-Transfer was sunset in `v2026.05.18`).
- **Admin UI** (`computing-admin`): same fixes for sepolia
  `premiumRegistry` (the proxied redeploy `0xE243…70Fb` from
  `v2026.05.18`) and mainnet `tokenWhiteList`.
- **Subgraph** (`computing-subgraph`): mainnet `TokenWhiteList` rotated
  to `0x7812…4FE9` (startBlock `25124350`); sepolia `PremiumRegistry`
  rotated to `0xE243…70Fb` (startBlock `10875413`); `TransferLegacyRouter`
  data source dropped on every network and the
  `src/transfer-legacy-router.ts` handler + `abis/TransferLegacyRouter.json`
  removed. Subgraph republished as a new version on both Studio slugs.

### Hardening shipped in the same release
- `scripts/sync-ui.ts` now supports `--check` (drift detector that exits
  non-zero with a per-(network, contract) diff) and `--write` (copies /
  merges directly into sister repos). Sister-repo locations resolve via
  `UI_REPO_PATH`, `ADMIN_REPO_PATH`, `SUBGRAPH_REPO_PATH`, defaulting to
  the assumed `../computing`, `../computing-admin`, `../computing-subgraph`
  layout.
- `npm run sync-ui:check` and `npm run sync-ui:write` package.json
  shortcuts.
- Subgraph networks.json merge logic preserves existing key order (so
  diffs stay surgical) and falls back to existing `startBlock` values
  when a deployment artifact is missing its receipt.

### Operational rule (from now on)
Every release that mutates `contract-addresses.json` must end with
`npm run sync-ui:write` *before* it can be merged. CI / pre-merge gate
runs `sync-ui:check` and refuses divergence.

### Follow-ups
- [ ] Wire `sync-ui:check` into CI in this repo.
- [ ] Decide whether to also drop `local` / `localhost` from drift
      detection scope (currently flagged when hardhat addresses cycle).

---

## 2026-05-18 — Phase A security rollout (`v2026.05.18`)

**Networks:** Sepolia, mainnet
**Commits:** `c2b904b` (code + tests), `663a72f` (Sepolia), `b4999c3` (mainnet)
**Audit:** addresses C-1, H-2, M-1, M-4 from the 2026-05 external review.

### Phase A proxy impl bumps (mainnet)

All performed via the `DefaultProxyAdmin` at
`0xA41299408EB78D67B9b599e38E3259C11A005145`. Proxy addresses unchanged.

| Proxy | New impl |
|-------|----------|
| EIP712LegacyVerifier | `0x1a603b73010A9422333c94bCd2B23264361f8169` |
| LegacyDeployer | `0xfBC58F0B910046c441ecC34C82321c7C26f1477d` |
| PremiumSetting | `0xad8dB699556249a539c936467D6c95083A564Fb8` |
| MultisigLegacyRouter (H-2) | `0x0935720d098800Ca59567dde2D2BC3d74c80825e` |
| TransferEOALegacyRouter (H-2) | `0x9F8CC0a0f69Ae7d0b7201A86C969726E94ccB449` |
| PremiumRegistry (M-1) | `0x0EaA09277B628b7bBC65763f79E99469989A4cB8` |

### EOA clone target (C-1 + M-4)

Fresh `TransferEOALegacy` impl deployed at
`0xC8ab95d850Fb7fAf5192B4e01D46008E053952d3` and wired into
`TransferEOALegacyRouter.legacyImplementation` via
`setLegacyImplementation` (tx
`0x56f7142f7a49c53d199c73704d6de346f152fa0a98465120001173b86ba0514e`).

Existing clones already deployed against the previous impl
(`0xD5bA2799fc2e5bc250a50251896A6d7E1c792200`) are **unaffected** — the
impl address is baked into EIP-1167 clone bytecode at creation time.
Only future `createLegacy` calls switch onto the patched impl.

### Incidental impl bumps (metadata drift, no functional diff)

These got swept up by the cascade `hardhat deploy` and reflect compiler
metadata drift only:

`Banner`, `PremiumAutomationManager`, `PremiumMail*`
(`Router`/`BeforeActivation`/`Activated`/`ReadyToActivate`),
`TimeLockRouter`, `TimelockERC20/721/1155`.

### Surprise side effect: `TokenWhiteList` rotation

`deploy/legacy/5.TokenWhiteList.ts` lacked `skipIfAlreadyDeployed`, so
`hardhat-deploy` treated the metadata drift as a "redeploy" and minted a
**fresh** non-proxy `TokenWhiteList` at
`0x7812777A23877159861d3De567DD97f9d9f64FE9`. The old contract at
`0x72b6AD53533a618A6Fdc07d8D1b8A3C980F21993` is now archived under
`contract-addresses.json _deprecated`.

`deploy/timelock/4c.SetTimelockSwapRouter.ts` then rotated
`TimeLockRouter.tokenWhitelist` onto the new contract and pre-loaded
USDC + USDT. **WETH and stETH had to be added manually** (txs
`0x1a97ca88…d073` and `0xc84f29e8…4292`) to restore parity with the
pre-rollout token set. `cbETH` was explicitly removed from the old
whitelist before the rotation and was intentionally not carried forward.

Hardening landed in the same release:
- `5.TokenWhiteList.ts` now sets `skipIfAlreadyDeployed: true`.
- `4c.SetTimelockSwapRouter.ts` is now self-healing: when it detects a
  pointer rotation it enumerates the old whitelist via TokenAdded /
  TokenRemoved event history and migrates every still-active token
  onto the new contract before swapping the pointer.

### Verification

`scripts/verify-phase-a.ts --network mainnet`:

- [C-1] `TransferEOALegacy.MAX_TRANSFER = 100`
- [H-2] EOA + Multisig routers declare `PrivateCodeSetupNotCompleted`
- [M-1] `PremiumRegistry` impl matches artifact
- `PremiumSetting` wiring: registry + sunset transfer router
- Plan catalog: `$199` annual + `$499` lifetime active, legacy `$21`
  retired

### Tooling shipped alongside

- `scripts/deploy-preview.ts` — dry-run preview that flags
  REUSE / IMPL_BUMP / FULL_REDEPLOY / NEW with a `[STATEFUL]` callout for
  contracts whose redeploy would be dangerous.
- `scripts/print-addresses.ts` — flat reverse-index print of
  `contract-addresses.json` per network.
- `test/fixtures/wiring.ts` — single typed `wireRouters()` helper that
  consolidates the canonical argument order for the three router-wire-up
  setters; replaces near-duplicate copies in 4 spec files.

---

## Format

Suggested template for new entries:

```
## YYYY-MM-DD — <one-line summary> (vYYYY.MM.DD if a release)

**Networks:** ...
**Commits:** ...
**Linked issue / audit / incident:** ...

### What changed
- proxy impl bumps: …
- wiring txs: …
- fresh contracts: …

### What deliberately didn't change
- …

### Follow-ups
- [ ] subgraph bump
- [ ] frontend ABI sync
- [ ] etc.
```

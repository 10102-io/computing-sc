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

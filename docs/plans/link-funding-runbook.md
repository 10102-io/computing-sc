# LINK Funding Runbook — PremiumAutomationManager

**Owner:** whoever is on-call for the `computing-sc` premium flow.
**Applies to:** Ethereum mainnet and Sepolia (any network where
`PremiumSetting.premiumAutomationManager()` is non-zero).

## Why this exists

`PremiumRegistry.subcribeWithETH` / `subcribeWithUSDT` / `subcribeWithUSDC`
each end with:

```
premiumSetting.updatePremiumTime(msg.sender, duration)
```

Inside `PremiumSetting.updatePremiumTime` (contracts/premium/PremiumSetting.sol):

```solidity
if (address(premiumAutomationManager) != address(0)) {
  if (legacyQueuedToAddCronjob[user].length > 0) {
    premiumAutomationManager.addLegacyCronjob(user, legacyQueuedToAddCronjob[user]);
    delete legacyQueuedToAddCronjob[user];
  }
}
```

`addLegacyCronjob` → `_createCronjob(user)` calls the Chainlink
`AutomationRegistrar.registerUpkeep` with `amount: 1e18`, which pulls **1 LINK
per cronjob** from `PremiumAutomationManager` via `LINK.transferFrom(manager,
registrar, 1e18)`. A follow-up `_fundKeepupIfNeeded` can top the upkeep up to
1.3× minBalance (another fraction of a LINK).

`PremiumSetting.addLegacyOnLegacyCreated` is the other path: if a premium user
creates a new legacy, the same `addLegacyCronjob` flow runs and pulls LINK.

**Consequence:** if `PremiumAutomationManager` holds less than ~1 LINK, the
next first-time subscribe from a user who already has a queued legacy (or the
next legacy creation by a premium user without a cronjob yet) reverts with:

```
ERC20: transfer amount exceeds balance
```

The error is surfaced through three contract layers, so it looks unrelated to
LINK unless you read the call graph. This runbook keeps us from rediscovering
that every time.

## Invariant

Keep `LINK.balanceOf(PremiumAutomationManager)` **above 2 LINK at all times**
on any network where the manager is wired into `PremiumSetting`.

"2 LINK" is a soft floor that covers one cronjob creation (1 LINK) plus the
follow-up `_fundKeepupIfNeeded` top-up (~0.3 LINK at current Chainlink
economics), with a safety margin. Burn rate = roughly 1-2 LINK per new paying
user, amortised.

## Monitoring

Read-only scripts (work against whichever network `--network` resolves to):

- `scripts/check-sepolia-link-funding.ts` — prints manager balance, the caller's
  cronjob state, and whether the next subscribe would mint one.
- `scripts/check-mainnet-link-funding.ts` — same idea, and cross-checks the
  wired manager against the address in `contract-addresses.json`.

Recommended cadence:

- **Mainnet:** weekly cron or a watcher alerting when balance drops below
  5 LINK. 5 LINK buffers ~3-4 new paying users before the hard floor.
- **Sepolia:** check before a demo / QA cycle. Re-fund from the deployer via
  `scripts/fund-sepolia-manager-link.ts` (hard-codes a 10 LINK top-up).

## How to top up

### Sepolia

1. Make sure the deployer wallet has enough LINK. Faucet:
   <https://faucets.chain.link/sepolia> (10-25 LINK per run).
2. `npx hardhat run scripts/fund-sepolia-manager-link.ts --network sepolia`
   transfers 10 LINK from the deployer to the wired manager and prints before/
   after balances.
3. Re-run `scripts/check-sepolia-link-funding.ts` to confirm.

### Mainnet

1. Decide the funding amount (default target: 20-50 LINK for a soft launch,
   enough to survive a month of organic growth between refills).
2. Source LINK on mainnet — either the treasury wallet already holding LINK or
   an on-ramp / DEX swap. Mainnet LINK = `0x514910771AF9Ca656af840dff83E8264EcF986CA`.
3. Transfer directly to the wired manager. Get the authoritative address from
   an `eth_call`:

   ```bash
   cast call 0x5223E0D4D1f0BE6Bf5De7cA6D2Fa9BFB6447013f \
     "premiumAutomationManager()(address)" --rpc-url $MAINNET_RPC
   ```

   Do **not** hard-code the manager address in one-off scripts — read it from
   `PremiumSetting` each time so we don't drift on a future re-wire.
4. Re-run `scripts/check-mainnet-link-funding.ts` to confirm.

## Long-term mitigations (not done yet)

- **Low-water alerting.** Off-chain watcher hitting
  `PremiumAutomationManager.i_link.balanceOf(self)` and paging when < 5 LINK.
  Cheapest fix.
- **Graceful degrade on LINK shortage.** Contract change: wrap the
  `registerUpkeep` call in a try/catch on `addLegacyCronjob` so a missing
  upkeep doesn't revert the whole subscribe. Trade-off: silently dropped
  cronjob registration — only acceptable if we have monitoring that catches
  it. Requires a `PremiumAutomationManager` upgrade.
- **Testnet skip flag.** Add an `onlyMainnet` / "skip automation" toggle so
  testnet never reaches the LINK pull path. This would also remove the need
  for the `VITE_FEATURE_EMAIL_REMINDERS_TESTNET` disclaimer in the consumer UI.
  Requires a `PremiumSetting` upgrade.

## Related

- `docs/plans/solc-upgrade.md` — existing notes on upgrade procedure.
- `computing/src/components/organisms/settings-tabs/email-reminder-settings/index.tsx`
  — UI disclaimer for the separate "Chainlink Automation upkeep itself is
  unfunded on Sepolia" issue. That is a different LINK pool (the upkeep's
  running balance on the Keeper Registry); this runbook is about the
  manager's LINK balance used to mint the upkeep in the first place.

# B2B premium seat grants — operator runbook

Bet 3 of `computing/docs/plans/b2b.md`: sell prepaid premium seats to a
company (employer benefit, partner bundle) with **zero new product
code**. The company pays an invoice off-chain; we grant seats on-chain
via the existing OPERATOR primitive. Non-custodial throughout — a grant
only extends each user's `premiumExpired` in `PremiumSetting`.

## Offer shape

- Prepaid annual per-seat premium, list price minus a volume discount
  (suggested: 20% at 25+ seats, 35% at 100+).
- The buyer provides a CSV of wallet addresses (their employees /
  clients). Users get every premium feature (email reminders, auto-renew
  opt-in, sponsored claims, backup layers) with nothing to redeem.
- Renewal = another invoice + re-run of the same script.

## Attribution convention

Every grant records `method = "b2b:<partner-slug>"` in the
`PlanSubcribed` event. Reporting joins on that string:
`computing-admin → users-billings` already filters by plan/method (the
subgraph exposes `plan_name_contains_nocase`), so each partner's seats
are enumerable without any admin-panel change.

## Steps

1. Agree seats + price; send the invoice. Do not grant before payment
   clears (grants are extendable but not cleanly revocable — see
   Constraints).
2. Receive the CSV (one address per line, `#` comments allowed).
   Sanity-check it: `node -e` count + spot-check a few addresses with
   the buyer.
3. Pick the plan id (usually the standard yearly plan; check
   `PremiumRegistry` plans in the admin panel).
4. Dry run (default):

   ```bash
   GRANT_CSV=./partner-acme.csv GRANT_PLAN=1 GRANT_METHOD=b2b:acme-2026 \
     npx hardhat run scripts/grant-premium-batch.ts --network mainnet
   ```

5. Real run: same command with `GRANT_DRY_RUN=false`. The script is
   re-run safe (skips addresses already covered by roughly this grant's
   duration).
6. Verify a sample address in the app (premium badge) and in
   `users-billings` (method column = the partner slug).

## Constraints and honesty notes

- **No revocation**: `updatePremiumTime` only extends; there is no
  clean on-chain claw-back. Price accordingly (prepaid, non-refundable
  seats) and never grant on net-30 promises.
- **Addresses, not emails**: the buyer must map people to wallet
  addresses. That is a feature (no PII on our side) and a limitation
  (their onboarding problem).
- **Sepolia rehearsal**: run the identical command with
  `--network sepolia` and a 2-address test CSV before the first real
  batch of a new partner.
- The OPERATOR key is the standard ops signer; the script fails fast if
  the role is missing.

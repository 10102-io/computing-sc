# ShieldVault: a delayed, inheritable, quantum-vetoable holding

Track D2 of `round-2026-09.md`. Resolves `stake-shield-v2` and
`quantum-delay-vault` in `computing/docs/DEFERRED.md`. Standalone, opt-in,
not upgradeable. Written 2026-09-28, before any code.

**Status: v2 replaces v1 (see "v2" below).** v1 went live on 2026-09-28
(mainnet `0x83074f8519F54AF05f7C48911E432e0C44dBEE69`, Sepolia
`0xC930fD64…AebA`) and was paused for new deposits the same evening, with
zero mainnet holdings, once the audit preparation found two issues worth a
new deployment. v2 went live on 2026-09-29: mainnet
`0xA1EA2F8C0518458975E09ED63bf5D48980f76C38` (block 26084130), Sepolia
`0xa88f4c2D…2407`, both Etherscan-verified, launch fee 25 bps
(`contract-addresses.json` `ShieldVault`; v1 kept as `ShieldVaultV1`). Adversarially reviewed twice,
not independently audited (package: `shield-vault-audit.md`).

## v2 (2026-09-28)

What changed, and why, in one place (tests: `test/ShieldVault.spec.ts`):

- **The veto commitment binds the owner.** Digest =
  `keccak256(abi.encode(keccak256("10102.ShieldVault.veto.v2"), chainId,
  vault, owner, secret, recoveryTo))`, and pinning is per owner. v1's global
  pin let anyone burn a freshly registered sheet by pinning its public digest
  first; a per-owner pin alone would have let a decoy absorb the veto in a
  client that looks positions up by digest. Clients now find a sheet's
  holding through `positionsOf(owner)`; the sheet prints the owner.
- **A veto never fails.** An unpayable recovery wallet (paused token,
  blacklist) is recorded as owed to it; the pending theft is cleared.
- **Paper-key heirs (`Config.holdMask`).** Bit `i` holds beneficiary `i`'s
  release share in `owed` (event `ShareHeld`); only that beneficiary moves
  it, by its own call or by `claimOwedWithSig(id, beneficiary, to, deadline,
  sig)` to a wallet it chooses, so a printed key needs no ETH (the relay
  submits). `claimOwed` by anyone else reverts `ShareIsHeld` for such a share.
- **Signed owner actions** (EIP-712 domain "10102 ShieldVault" version "2",
  ERC-1271 via SignatureChecker): `checkInWithSig` (the Premium relay perk)
  and `cancelPendingWithSig`, bound to the pending operation's `readyAt`, so
  an owner whose wallet a thief emptied of ETH can still stop a withdrawal.
  Each purpose has its own nonce counter (`nonces[signer][purpose]`), so a
  thief with the key cannot void a signed cancel by burning check-in nonces.
  There is deliberately no signed `requestWithdraw` or `requestChange`: a
  phished typed-data signature must never be able to start a theft.
- **Fee.** `feeBps` for new positions (Safe-settable, hard cap
  `MAX_FEE_BPS` = 50, i.e. 0.5%), fixed into each position at `open`, and
  `open` takes the caller's `maxFeeBps` so a raise between signing and
  inclusion reverts instead of binding. Charged on withdrawals and releases
  (events report net amounts; `FeeCharged` carries the fee), never on a veto
  or an owed claim. Fees accrue in the vault (`feesAccrued`) and anyone sends
  them to `feeRecipient` with `collectFees`, so a fee problem can never block
  an exit. Launch rate: 25 bps (0.25%); recipient: the governance Safe.
  Accepted business fact: an owner who commits the sheet to their own
  address can leave at once and fee-free through the veto; a stop is free by
  design.
- **`fallbackAvailableAt`** follows a pending change's silence period and
  returns 0 for closed or unknown positions. `PositionOpened` carries the
  pinned `vetoDigest` and the `feeBps`.

## What it is, in one paragraph

A user puts a token (wstETH first) into a position that only they own. It
can leave in three ways and no other: the owner asks to withdraw and waits
their chosen delay; the owner goes silent for their chosen period and
the position goes to their named people; or someone holding the owner's
recovery secret sends everything to the recovery wallet that was fixed
when the secret was made. A stolen key, classical or quantum, can only
start a withdrawal the owner will see coming and can stop.

## Threat model

| Attacker has | Can do | Cannot do |
|---|---|---|
| The owner's key | Request a withdrawal or a config change; both wait the exit delay and emit an event the worker turns into an alert | Shorten the wait, skip it, or change where a veto sends the funds |
| The recovery secret only | Veto: move everything to the committed recovery wallet at once | Choose the destination, or take anything |
| The key and a fresh commitment of their own | Register it in `QuantumRecoveryRegistry` | Use it: the vault only honours the commitment pinned at opening or installed by a delayed, vetoable change |
| Control of the admin (the Safe) | Add or remove supported tokens, pause new deposits | Touch any balance, block any exit, change any position |
| A malicious or blacklisted beneficiary | Fail its own transfer | Block the others: its share is recorded as owed and claimable later |
| A watcher of the mempool | Front-run a veto with the same secret | Redirect it: the destination is part of the committed hash |

Invariants the tests must hold:

1. Funds leave a position only through `executePending` (a withdrawal to
   the address fixed at request time, after the delay), `executeFallback`
   (to the beneficiaries fixed in the active config, after the silence
   period), or `veto` (to the committed recovery wallet). A payout whose
   transfer fails (a blacklisted withdrawal address or beneficiary) is
   recorded as owed to that same payee and claimable later; it never
   freezes the position.
2. Every owner-initiated change of where funds can go (withdraw, config
   change) waits the position's CURRENT exit delay and is vetoable until
   its `readyAt`. After `readyAt` anyone may execute it, so the veto window
   ends there, not at execution: the worker's alert escalates well before
   `readyAt`, and the app sends vetoes through a private relay.
3. Nothing a position depends on can be changed by the admin.
4. Exits are never pausable. The allowlist gates deposits only.
5. The vault's token balance is at least the sum of all positions' balances
   plus all recorded owed amounts, for every token, at all times.

## Positions

One singleton contract, many positions, one token per position. An owner
may hold several (one wstETH, one USDC). A position is:

- `owner`, `token`, `balance`;
- `exitDelay`: 7, 30 or 90 days, chosen at opening;
- `silencePeriod`: 0 (no fallback) or 180 to 1,095 days;
- `beneficiaries`: up to 10 addresses with shares in basis points
  (scale 10,000) summing to 10,000; empty when `silencePeriod == 0`;
- `vetoDigest`: 0 (no veto) or the digest pinned from the registry;
- `lastActivity`: refreshed by every owner action;
- one `pending` slot: nothing, a withdrawal `(amount, to, readyAt)`, or a
  config change `(new config, readyAt)`. One at a time keeps the state
  machine small and the alert unambiguous.

## Operations

| Call | Who | Effect |
|---|---|---|
| `open(token, amount, config, vetoIndex, maxFeeBps)` | anyone (becomes owner) | New position; pulls tokens, credits the received delta, snapshots `feeBps` (reverts `FeeTooHigh` above `maxFeeBps`) |
| `deposit(id, amount)` | anyone | Tops up; the owner counts as active if they are the caller |
| `checkIn(id)` / `checkInWithSig(id, deadline, sig)` | owner, or anyone with the owner's signature | Refreshes `lastActivity` |
| `requestWithdraw(id, amount, to)` | owner | Starts the delay; `to` fixed now |
| `requestChange(id, config, vetoIndex)` | owner | Starts the delay for a new config |
| `cancelPending(id)` / `cancelPendingWithSig(id, deadline, sig)` | owner, or anyone with the owner's signature (binds `readyAt`) | Clears the pending slot |
| `executePending(id)` | anyone, after `readyAt` | Pays `to` or applies the config; relay-friendly |
| `veto(id, secret, recoveryTo)` | anyone | Pays the whole balance to the committed recovery wallet (or records it as owed there), closes the position |
| `executeFallback(id)` | anyone, after `lastActivity + silencePeriod` | Pays each beneficiary its share; a failed transfer becomes owed |
| `claimOwed(id, beneficiary)` | anyone; only the beneficiary itself for a held share of an EOA (`ShareIsHeld`) | Pays an owed amount to that beneficiary |
| `claimOwedWithSig(id, beneficiary, to, deadline, sig)` | anyone with the beneficiary's signature | Pays the owed amount to `to` (a printed-card heir's own wallet) |
| `collectFees(token)` | anyone | Sends `feesAccrued[token]` to `feeRecipient` |

`executePending`, `veto`, `executeFallback` and `claimOwed` pay addresses
that were fixed earlier by the owner or the commitment, so anyone may call
them: the reminder-worker's relayer can finish every exit gas-free for the
people who need it, with no signature scheme to maintain.

A pending withdrawal blocks the fallback (the owner was active by
definition) until someone executes it. A veto clears any pending operation.
`requestWithdraw(id, ALL, to)` withdraws whatever the balance is at
execution and closes the position, so a stranger's dust deposit cannot
keep it open. After a closing withdrawal, a veto or a fallback, the
position is closed and cannot be reopened.

## The veto commitment

```
digest = keccak256(abi.encode(
  keccak256("10102.ShieldVault.veto.v2"),
  block.chainid,
  address(shieldVault),
  owner,         // the position's owner (v2): a copied digest verifies nowhere else
  secret,        // 32 random bytes printed on the recovery sheet
  recoveryTo     // the recovery wallet, printed on the same sheet
))
```

The owner registers `digest` in `QuantumRecoveryRegistry` with scheme 5
(hash preimage), which gives it a public, pre-breach timestamp. At
`open` (or in an applied `requestChange`) the vault reads the commitment
at `vetoIndex` for the caller, requires scheme 5, and pins the digest. The
veto call carries `secret` and `recoveryTo`; the vault recomputes the
digest and compares. Binding chain and vault address means a sheet made
for one vault can never be replayed against another.

One sheet protects one position: the vault records, per owner
(`digestPinned[owner][digest]`), every digest it has pinned and refuses
to pin it for a second position of that owner (a veto publishes the
secret, which must not also unlock a sibling). A config change may keep
the position's current digest. The client refuses a `recoveryTo` equal to
the vault, and the vault refuses it as a beneficiary.

Recommendation printed on the sheet: `recoveryTo` should be a fresh
address that has never signed anything, so its public key is not exposed
before the day it is needed.

## Tokens

Deposits accept tokens the admin marked supported. Accounting uses the
received balance delta, so a fee-on-transfer token cannot inflate a
position. Rebasing tokens are refused by policy (stETH: its rebases would
accrue to nobody); wstETH is the wrapped form and is the first token.
Initial set: wstETH, USDC, USDT, WETH.

Curation assumption, stated because the accounting rests on it: a
supported token debits the sender exactly the amount transferred and has
no transfer hooks. A token that charged its fee to the sender on the way
out would drain other positions in the same token. USDC and USDT are
upgradeable; if either ever changes that behaviour, the Safe delists it
(which stops deposits only) and a new vault is deployed.

## Admin surface

`Ownable2Step`, owner the governance Safe. `setTokenSupported(token, bool)`
and `setDepositsPaused(bool)`, `setFee(uint16)` (at most `MAX_FEE_BPS` = 50,
for positions opened later only) and `setFeeRecipient(address)` (which
also receives fees accrued but not yet collected). Nothing else. No
upgrade path: a bug fix is
a new deployment and every position can leave through its own delay.

## Out of scope

Safe-module mode (phase 3 of the plan), multiple tokens per position,
partial fallback schedules. (Signed check-ins, out of scope in v1, are in
v2.)

## Events

`PositionOpened`, `Deposited`, `CheckedIn`, `WithdrawRequested`,
`ChangeRequested`, `PendingCancelled`, `Withdrawn`, `ChangeApplied`,
`Vetoed`, `FallbackExecuted`, `FeeCharged`, `OwedRecorded`, `ShareHeld`,
`OwedClaimed` (v2 adds the destination `to`), `TokenSupportSet`,
`DepositsPausedSet`, `FeeSet`, `FeeRecipientSet`, `FeesCollected`. The worker alerts the owner on
`WithdrawRequested` and `ChangeRequested` (which carries the new digest and
a hash of the new beneficiary list, so the alert can say "your recovery
sheet is being replaced" even when nothing else changes), and again before
`readyAt`: the delay only protects an owner who notices.

## Known limitations (v2, accepted)

None of these lets anyone move funds away from their rightful recipient;
they are recorded for the audit (`shield-vault-audit.md` Q15 and Q16).

- **Nonces are per signer and purpose, not per position.** Check-ins
  signed ahead for several holdings void each other after the first is
  used. The app signs each action just before sending it.
- **A signed cancel binds the id and `readyAt`, not the operation.** A
  direct `cancelPending` does not consume the cancel nonce, so an unused
  signed cancel could cancel a later operation with the same `readyAt`:
  only one requested in the same block, under the same delay, after a
  cancel. The worst case is the owner's own withdrawal being cancelled.
- **EIP-7702 accounts count as contracts** (`code.length`) for both the
  held-share guard and `SignatureChecker`: anyone can push such a
  beneficiary's held share to that same address, and its signatures go
  the ERC-1271 path (refused if the delegate lacks it; the direct call
  still works).

## Review

Adversarial review 2026-09-28, before deployment: no Critical or High.
Acted on: failed withdrawal payouts become owed instead of freezing the
position (Medium: a blacklisted payee plus an owner who can no longer
cancel would have blocked the fallback forever); the vault cannot be a
beneficiary; `ALL` withdrawals; one digest per position; the change event
names what changes; `fallbackAvailableAt` accounts for a pending
operation; tests for exits while paused and delisted, delay composition,
and a property test covering fees, blacklists, stranger deposits, owed
claims and config changes.

Before the mainnet deploy the app was walked end to end on Sepolia with a
real wallet (holding 5): open with a sheet (register, approve, open),
check in, withdraw and cancel, change settings and cancel, then a
withdrawal of everything stopped from the public "Stop it" panel with the
secret typed as printed; the recovery wallet received exactly 12.5 R2USD
and the holding closed. Wrong sheets, the owner's own wallet or the vault
as the recovery wallet, over-balance withdrawals and splits off 100% were
all refused before any transaction.

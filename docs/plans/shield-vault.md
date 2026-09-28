# ShieldVault: a delayed, inheritable, quantum-vetoable holding

Track D2 of `round-2026-09.md`. Resolves `stake-shield-v2` and
`quantum-delay-vault` in `computing/docs/DEFERRED.md`. Standalone, opt-in,
not upgradeable. Written 2026-09-28, before any code.

**Status: live.** Mainnet `0x83074f8519F54AF05f7C48911E432e0C44dBEE69`
(block 26077561, tx `0xea97204d…a810`), Sepolia
`0xC930fD647919eb19eDFE1c7Fd69F7bC594C2AebA`; both Etherscan-verified and
owned by the governance Safe. Adversarially reviewed, not independently
audited (see Review).

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
| `open(token, amount, config, vetoIndex)` | anyone (becomes owner) | New position; pulls tokens, credits the received delta |
| `deposit(id, amount)` | anyone | Tops up; the owner counts as active if they are the caller |
| `checkIn(id)` | owner | Refreshes `lastActivity` |
| `requestWithdraw(id, amount, to)` | owner | Starts the delay; `to` fixed now |
| `requestChange(id, config, vetoIndex)` | owner | Starts the delay for a new config |
| `cancelPending(id)` | owner | Clears the pending slot |
| `executePending(id)` | anyone, after `readyAt` | Pays `to` or applies the config; relay-friendly |
| `veto(id, secret)` | anyone | Pays the whole balance to the committed recovery wallet, closes the position |
| `executeFallback(id)` | anyone, after `lastActivity + silencePeriod` | Pays each beneficiary its share; a failed transfer becomes owed |
| `claimOwed(id, beneficiary)` | anyone | Retries an owed transfer to that beneficiary |

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
  keccak256("10102.ShieldVault.veto.v1"),
  block.chainid,
  address(shieldVault),
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

One sheet protects one position: the vault records every digest it has
pinned and refuses to pin it for a second position (a veto publishes the
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
and `setDepositsPaused(bool)`. Nothing else. No upgrade path: a bug fix is
a new deployment and every position can leave through its own delay.

## Out of scope for v1

Gasless check-ins (owners fund their own; a signed check-in via the relay
can follow), Safe-module mode (phase 3 of the plan), multiple tokens per
position, partial fallback schedules.

## Events

`PositionOpened`, `Deposited`, `CheckedIn`, `WithdrawRequested`,
`ChangeRequested`, `PendingCancelled`, `Withdrawn`, `ChangeApplied`,
`Vetoed`, `FallbackExecuted`, `OwedRecorded`, `OwedClaimed`,
`TokenSupportSet`, `DepositsPausedSet`. The worker alerts the owner on
`WithdrawRequested` and `ChangeRequested` (which carries the new digest and
a hash of the new beneficiary list, so the alert can say "your recovery
sheet is being replaced" even when nothing else changes), and again before
`readyAt`: the delay only protects an owner who notices.

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

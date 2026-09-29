# ShieldVault: external security audit package

Prepared 2026-09-28 for an independent audit of `contracts/shield/ShieldVault.sol`,
updated 2026-09-29 for ShieldVault v2, which is the audit target.
Spec, threat model and internal review: `docs/plans/shield-vault.md` (the
"v2" section lists what changed from v1 and why).

## 1. Summary

ShieldVault is a single, non-upgradeable contract that holds many
positions. A position holds one ERC-20 token for one owner, and the funds
can leave it in exactly three ways:

1. The owner requests a withdrawal to an address fixed at request time and
   waits the position's exit delay (7, 30 or 90 days). After that anyone
   may execute it.
2. The owner stays silent for the position's silence period (0 for none,
   or 180 to 1,095 days) and anyone may release the balance to the
   beneficiaries named in the active config. Each share is sent at once,
   or, for a beneficiary marked in the config's `holdMask` (a key kept on
   paper, with no ETH), held in the vault until that beneficiary claims it
   by its own call or by a signature that names any destination.
3. Anyone holding the owner's recovery secret calls `veto`, which moves
   the whole balance at once to the recovery wallet that was bound into
   the commitment when the secret was made. The commitment is a scheme-5
   (plain hash preimage) entry in `QuantumRecoveryRegistry`, so it was
   timestamped on chain before any key compromise, and in v2 it also binds
   the owner's address.

The point is that a stolen owner key, classical or quantum, can only start
a withdrawal or a config change that waits the delay, emits an event the
app turns into an alert, and can be vetoed meanwhile. v2 adds signed,
relayable check-ins and cancels (EIP-712, EOA and ERC-1271 signers), so an
owner whose wallet a thief emptied of ETH can still stop a withdrawal, and
an exit fee fixed per position at opening (at most 0.5%).

Previous version. ShieldVault v1 went live on 2026-09-28 (mainnet
`0x83074f8519F54AF05f7C48911E432e0C44dBEE69`, Sepolia
`0xC930fD647919eb19eDFE1c7Fd69F7bC594C2AebA`). Preparing this package
found two issues worth a new deployment (a veto that could fail on a
blocked transfer, and a global digest pin that let anyone burn a freshly
registered recovery sheet; both were questions Q2 and Q3 of the v1
package). v1 was paused for new deposits through the governance Safe the
same evening and holds 0 positions on mainnet. Its exits keep working;
v1 is not in scope.

Why an audit now. v2 went live on mainnet on 2026-09-29 after two internal
adversarial reviews, without an independent audit. The app is about to
make it the default destination for one-click staked ETH: the user's ETH
is staked through Lido, wrapped to wstETH, and deposited into a new
position. That will concentrate real value in the contract quickly, so we
want an independent review before that switch, not after.

Why a finding is expensive. The contract is not upgradeable and has no
admin path into positions. A finding that needs a code fix means a new
deployment, a frontend switch for new positions, and a user migration in
which every existing owner leaves through their own exit delay (up to 90
days) or their veto. We have just done this once, from v1 to v2, while
holdings were zero; we would rather learn about the next one now, while
holdings are still small.

## 2. Scope

### In scope

| Item | Value |
|---|---|
| Repository | `computing-sc` (Hardhat) |
| Commit | Tag `v2026.09.29` (the 2026-09-29 `dev` commit; v1 was at `564b0d4bd5649202e70008a32544196077f66249`) |
| File | `contracts/shield/ShieldVault.sol` |
| Size | 706 physical lines, **492 nSLOC** |
| Contract | `ShieldVault is Ownable2Step, ReentrancyGuardTransient, EIP712` |
| License header | `UNLICENSED` |

nSLOC was counted as every line that is not blank, not a `//` comment and
not inside a `/* */` or `/** */` block. Lines with code followed by a
trailing comment count as code.

### Inherited and used libraries (OpenZeppelin Contracts 5.6.1)

Version from `package-lock.json` (`node_modules/@openzeppelin/contracts`
5.6.1). The file headers name the release in which each file last changed:

| Contract | Header | Use |
|---|---|---|
| `access/Ownable2Step.sol` | last updated v5.1.0 | Two-step admin transfer |
| `access/Ownable.sol` | last updated v5.0.0 | Base of the above (imports `utils/Context.sol`) |
| `utils/ReentrancyGuardTransient.sol` | last updated v5.5.0 | `nonReentrant` on the token-moving functions |
| `utils/TransientSlot.sol` | last updated v5.3.0 | Used by the guard (`tload`/`tstore`) |
| `utils/cryptography/EIP712.sol` | last updated v5.5.0 | Domain `"10102 ShieldVault"`, version `"2"`; `_hashTypedDataV4`, `_domainSeparatorV4` (uses `ShortStrings`, `MessageHashUtils`, `IERC5267`) |
| `utils/cryptography/SignatureChecker.sol` | last updated v5.6.0 | `isValidSignatureNow`: ECDSA for a signer without code, ERC-1271 `staticcall` otherwise |
| `utils/cryptography/ECDSA.sol` | last updated v5.6.0 | Used by the above (`tryRecover`, rejects high-s) |
| `token/ERC20/utils/SafeERC20.sol` | last updated v5.5.0 | `safeTransferFrom`, `safeTransfer`, `trySafeTransfer` |
| `token/ERC20/IERC20.sol`, `interfaces/IERC1363.sol`, `interfaces/IERC1271.sol` | | Interfaces |

The libraries themselves are assumed correct; how ShieldVault uses them is
in scope. Note that `trySafeTransfer` in 5.5 forwards all remaining gas
(`call(gas(), ...)`) and returns `false` on any revert, including out of
gas, and on a `false` return value. Note also that `SignatureChecker`
chooses the path by `signer.code.length`, so an EIP-7702 delegated EOA is
treated as a contract signer.

### Registry interaction (read only)

ShieldVault holds an immutable `QuantumRecoveryRegistry registry` and calls
exactly one function on it, `commitmentAt(owner, index)`, from
`_pinCommitment`, which runs inside `open` and `requestChange`. It uses
the returned `digest` and `scheme` and ignores `registeredAt` and
`recoveryContext`. The registry is append-only, has no owner, is not
upgradeable, rejects a zero digest, and reverts with an array
out-of-bounds panic for an index the account does not have. Its source
(`contracts/common/QuantumRecoveryRegistry.sol`, 110 physical lines, 47
nSLOC) is provided as context. Reviewing it as well is an optional add-on
we would like priced separately.

Registry addresses: mainnet `0xaB3C8C69fD17ba980b3D11064200c866904e360E`,
Sepolia `0xeed1e3614fb5F3Ed980fD120Bc7c68d144e84C59`.

### Compiler and build

| Setting | Value |
|---|---|
| solc | 0.8.35 (exact pragma `pragma solidity 0.8.35;`) |
| EVM version | `cancun` (pinned explicitly in `hardhat.config.ts`) |
| Optimizer | enabled, `runs: 200` |
| `viaIR` | `true` |
| Framework | Hardhat 2.28.6, ethers v5 tests, mocha |

### Deployments

| Network | Address | Verified source |
|---|---|---|
| Ethereum mainnet | `0xA1EA2F8C0518458975E09ED63bf5D48980f76C38` (block 26084130, tx `0x70557d2b…288b`) | [etherscan.io](https://etherscan.io/address/0xA1EA2F8C0518458975E09ED63bf5D48980f76C38#code) |
| Sepolia | `0xa88f4c2D15e0917652fBad2cFce73cD65CAc2407` (block 11808517, tx `0x028c0775…303e`) | [sepolia.etherscan.io](https://sepolia.etherscan.io/address/0xa88f4c2D15e0917652fBad2cFce73cD65CAc2407#code) |

Full deploy transaction hashes: mainnet
`0x70557d2b92af1851aa9eb5977de9699c7130ef68b3fa9f8a4b76e77f6aae288b`,
Sepolia `0x028c0775d682d4c00f9d11c8a5a6b3a34feb927ccaae85711929e563c9e5303e`.

Constructor: `(QuantumRecoveryRegistry registry_, address initialOwner,
address[] tokens, address feeRecipient_, uint16 feeBps_)`. On mainnet: the
registry above; the governance Safe
`0x60B3da49f05E21a1fcD7e210075A23b75939C3eA` as both initial owner and fee
recipient; fee 25 bps (the hard cap `MAX_FEE_BPS` is 50); and the token
list wstETH `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0`, USDC
`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, USDT
`0xdAC17F958D2ee523a2206206994597C13D831ec7`, WETH
`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`
(`scripts/deploy-shield-vault.ts`, fee from `SV_FEE_BPS`). Sepolia uses
the same shape with Sepolia WETH and the rehearsal token. A read on
2026-09-29 confirmed `owner()`, `feeRecipient()`, `feeBps() == 25`,
`registry()` and all four `tokenSupported` flags on mainnet, with 0
positions.

The Sepolia deployment passed the live smoke script
(`scripts/smoke-shield-vault.ts`): an owner-bound commitment, open at
25 bps, a relayed signed check-in and a relayed signed cancel, an early
exit refused, and a veto to the recovery wallet.

Bytecode check done on 2026-09-29: the mainnet runtime code (14,375
bytes) has the same length and the same CBOR metadata hash
(`ipfs 1220 0533e0df…c990`, solc `0x000823`) as `deployedBytecode` in the
local artifact compiled from the working tree that will become the commit
above. The 193 differing bytes (16 runs) are all zero in the artifact:
they are the immutables (`registry` and the EIP-712 cached domain values).
The audited source is therefore the deployed source.

### Out of scope

- ShieldVault v1 (deprecated, paused for deposits, no positions).
- `QuantumRecoveryRegistry.sol` itself (context only, optional add-on).
- The rest of the `computing-sc` suite: legacy routers and clones,
  timelock vaults and `TimeLockRouter`, premium, `UpgradeTimelock`. These
  were covered by RockSolid Security (legacy suite, report January 2025,
  `Security_Review_Computing_Will.pdf`) and CDSecurity (full suite
  including timelocks and premium, October 2025) or by later internal
  review.
- The OpenZeppelin library code (its use is in scope).
- The tokens themselves (wstETH, USDC, USDT, WETH) and Lido; the
  ETH to wstETH conversion happens in the app before `open` and is not a
  vault function.
- The frontend (`computing` repo), the reminder-worker that sends alerts
  and relays permissionless and signed calls, the subgraph, and the
  governance Safe.
- `contracts/mock/MockAwkwardERC20.sol`, `contracts/mock/MockERC1271Wallets.sol`,
  tests and scripts (provided to help you, not to be audited).

## 3. Architecture and trust model

### State

One `Position` per id (ids start at 1): `owner`, `lastActivity` (uint64),
`closed`, `feeBps` (uint16, the rate at opening), `token`, `balance`,
`vetoDigest` (zero means no veto), `config` (`exitDelay` uint32,
`silencePeriod` uint32, `beneficiaries` address[], `sharesBps` uint16[],
`holdMask` uint16), and one `pending` slot (`kind` None, Withdraw or
Change; `readyAt` uint64; `amount` and `to` for a withdrawal; `config` and
`vetoDigest` for a change). Global state: `positionCount`,
`owed[id][payee]`, `digestPinned[owner][digest]`,
`nonces[signer][purpose]`, `tokenSupported[token]`, `depositsPaused`,
`feeBps` (for future positions), `feeRecipient`, `feesAccrued[token]`, and
`_ownerPositions[owner]` (a view index, also how clients find a sheet's
position in v2).

### Roles

| Role | Functions | Can | Cannot |
|---|---|---|---|
| Admin (`owner()`, the governance Safe) | `setTokenSupported`, `setDepositsPaused`, `setFee`, `setFeeRecipient`, plus `transferOwnership`, `acceptOwnership`, `renounceOwnership` from `Ownable2Step` | Decide which tokens may be deposited in future, pause new deposits and new positions, set the fee for positions opened later (at most `MAX_FEE_BPS` = 50), choose where fees are sent (including fees already accrued and not yet collected) | Read or write any position, owed amount, pinned digest or nonce, change an existing position's fee, or block any exit |
| Position owner (`p.owner`, the caller of `open`) | `checkIn`, `requestWithdraw`, `requestChange`, `cancelPending`, and `deposit` counted as activity; `checkInWithSig` and `cancelPendingWithSig` by signature | Start and cancel delayed operations; reset the silence clock | Shorten a delay, move funds without waiting, change the veto destination without a delayed change |
| Beneficiary or other payee with an `owed` entry | `claimOwedWithSig` by signature, or `claimOwed` as caller | Send its own owed amount to any destination it signs | Touch any other payee's entry or any position |
| Anyone (including the relayer, which is untrusted) | `open`, `deposit`, `executePending`, `veto` (with the secret), `executeFallback`, `claimOwed`, `collectFees`, and submitting any `...WithSig` call | Open their own positions, top up any open position, finish operations whose destination was fixed earlier, submit a signature someone else made | Choose any destination, alter a signed field, or push a held share onto an EOA's address |

The governance Safe is currently a Safe 1.5.0 with threshold 1 (owners:
the guardian hardware wallet and the maintainer EOA), moving to 2-of-3.
For this contract that matters for curation and the future fee: a
compromised admin can list a hostile token, pause deposits, raise the fee
for new positions up to 0.5%, or redirect uncollected fees, never touch
existing positions.

The owner of a position is fixed forever; positions are not transferable.

### Permissionless functions and why they are safe to open up

`executePending`, `veto`, `executeFallback`, `claimOwed` and `collectFees`
pay addresses that were fixed earlier: `pending.to` at request time, the
`recoveryTo` hashed into the pinned digest, the beneficiaries of the
active config, the payee recorded in `owed`, and `feeRecipient`. The
caller only pays gas. One exception is deliberate: `claimOwed` by anyone
other than the payee reverts `ShareIsHeld` when the payee is a `holdMask`
beneficiary of the position's config and has no code
(`beneficiary.code.length == 0`), so no one can push a paper key's share
onto an address whose owner may never see it. Contract payees are never
gated, because a contract that can neither call nor sign would otherwise
be locked.

### Signed actions

EIP-712 domain: name `"10102 ShieldVault"`, version `"2"`, the chain id and
the vault address (`domainSeparator()` returns it). Signatures are checked
with `SignatureChecker.isValidSignatureNow`, so an owner or beneficiary
may be an EOA or an ERC-1271 contract (a Safe, a smart wallet). Nonces are
per signer and per purpose, `nonces[signer][purpose]`, with
`NONCE_CHECK_IN = 0`, `NONCE_CANCEL = 1`, `NONCE_CLAIM = 2`, so spending
one kind never voids a signature of another kind. The nonce is taken
(incremented) while building the struct hash and the whole call reverts
if the signature is wrong, so a third party cannot consume a nonce.

| Function | Signer | Struct |
|---|---|---|
| `checkInWithSig(id, deadline, sig)` | position owner | `CheckIn(uint256 id,uint256 nonce,uint256 deadline)` |
| `cancelPendingWithSig(id, deadline, sig)` | position owner | `CancelPending(uint256 id,uint64 readyAt,uint256 nonce,uint256 deadline)`, with `readyAt` read from the pending slot |
| `claimOwedWithSig(id, beneficiary, to, deadline, sig)` | `beneficiary` | `ClaimOwed(uint256 id,address beneficiary,address to,uint256 nonce,uint256 deadline)` |

The relayer is untrusted: every argument that changes what happens or
where funds go is in the signed struct. `cancelPendingWithSig` binds the
pending operation's `readyAt`, so a signature made for one operation does
not cancel a later one. There is deliberately no signed `requestWithdraw`
or `requestChange`: a phished typed-data signature must never be able to
start a theft. `claimOwedWithSig` rejects `to` equal to zero or to the
vault, and works for any owed entry (held share or failed transfer).

### Veto digest construction

From `_vetoDigest`:

```solidity
bytes32 private constant VETO_TAG = keccak256("10102.ShieldVault.veto.v2");

keccak256(abi.encode(VETO_TAG, block.chainid, address(this), owner, secret, recoveryTo))
```

`secret` is 32 random bytes printed on the user's recovery sheet together
with `recoveryTo` and the owner's address. The client computes the digest
locally and registers it in the registry under the owner's account with
scheme 5. `open` and `requestChange` take a `vetoIndex` (or
`NO_VETO = type(uint256).max`), read
`registry.commitmentAt(msg.sender, vetoIndex)`, require `scheme == 5`, and
pin the digest for that owner:

- If the digest equals the position's current digest (the `keep`
  argument, only non-zero in `requestChange`), it is accepted again.
- Otherwise, if `digestPinned[owner][digest]` is already true, the call
  reverts with `CommitmentReused`. Else it is marked pinned for that owner
  forever.

`veto(id, secret, recoveryTo)` rejects a zero or self `recoveryTo`,
recomputes the digest with the current `block.chainid`, `address(this)`
and the position's owner, and compares it with the position's active
`vetoDigest` (not the pending one). On success it zeroes the balance,
closes the position, deletes any pending operation, and pays the whole
balance with `trySafeTransfer`; if that fails, the amount is recorded as
owed to `recoveryTo`. The veto itself never fails on the transfer, and it
is never charged a fee. A digest copied into another account's registry
history and pinned there never verifies on that account's position,
because the digest binds the owner.

### Fee

- `feeBps` (global) is the rate for positions opened from now on;
  `setFee` is owner-only and reverts `FeeTooHigh` above `MAX_FEE_BPS` = 50.
  `open` copies it into `Position.feeBps`; later rate changes never apply
  to an existing position.
- `open(token, amount, config, vetoIndex, maxFeeBps)` reverts `FeeTooHigh`
  if the current rate exceeds the caller's `maxFeeBps`, so a raise between
  signing and inclusion cannot bind the caller.
- `_takeFee` charges `floor(amount * p.feeBps / 10000)` on a withdrawal
  (`executePending`, on the resolved amount) and on a fallback release
  (`executeFallback`, on the whole balance before the split), moves it to
  `feesAccrued[token]` and emits `FeeCharged`. `Withdrawn` and
  `FallbackExecuted` report net amounts. No fee on a veto, on a deposit
  or on an owed claim (a failed withdrawal is owed net of the fee already
  taken).
- `collectFees(token)` is permissionless and `nonReentrant`: it zeroes
  `feesAccrued[token]` and sends it with a reverting `safeTransfer` to the
  current `feeRecipient`. Fees are never in the path of an exit, so an
  unpayable fee recipient blocks only the collection. `setFeeRecipient`
  is owner-only and rejects zero and the vault.

### Token assumptions

- Accounting is by balance delta: `_pull` credits
  `balanceOf(this)` after minus before the `safeTransferFrom`, and
  reverts with `NothingReceived` if nothing arrived. A fee-on-transfer
  token cannot inflate a position.
- Curated set on mainnet: wstETH, USDC, USDT, WETH. Rebasing tokens (stETH)
  are excluded by policy because their growth would accrue to nobody.
- Curation assumption the accounting rests on: a supported token debits
  the sender exactly the amount transferred and has no transfer hooks. A
  token that charged an extra fee to the sender on the way out would drain
  other positions in the same token.
- Blacklists and reverting receivers: withdrawal, fallback and veto
  payouts use `trySafeTransfer`; a failed transfer is recorded in
  `owed[id][payee]` and emits `OwedRecorded`. `claimOwed` and
  `claimOwedWithSig` then pay with a reverting `safeTransfer`, to the payee
  or to the destination the payee signed.
- USDC is a proxy and can be upgraded by its issuer; USDT has an issuer
  controlled fee parameter and a deprecation mechanism that forwards calls
  to a successor contract. If either ever breaks the curation assumption,
  the Safe delists it (stops deposits only) and a new vault is deployed.
- The vault never calls `approve` on any token. The USDT "reset allowance
  to zero first" quirk concerns the user's approval of the vault and is
  handled in the frontend only (`APPROVE_RESET_FIRST`).
- The vault has no `receive` or `fallback`, so plain ETH transfers to it
  revert. Tokens transferred directly (not through `open` or `deposit`)
  are not credited to anyone and there is no sweep function.

### External calls

| Call | From | Kind |
|---|---|---|
| `registry.commitmentAt(owner, index)` | `_pinCommitment` (`open`, `requestChange`) | view |
| `token.balanceOf(this)` twice, `token.safeTransferFrom(sender, this, amount)` | `_pull` (`open`, `deposit`) | reverting |
| `token.trySafeTransfer(to, amount)` | `_payOrOwe` (`executePending`, `veto`, `executeFallback`) | non-reverting, all gas forwarded |
| `token.safeTransfer(to, amount)` | `_claimOwed` (`claimOwed`, `claimOwedWithSig`), `collectFees` | reverting |
| `signer.isValidSignature(hash, sig)` (ERC-1271, `staticcall`) or `ecrecover` | `_verify` (`checkInWithSig`, `cancelPendingWithSig`, `claimOwedWithSig`) | view |

### Reentrancy

`open`, `deposit`, `executePending`, `veto`, `executeFallback`,
`claimOwed`, `claimOwedWithSig` and `collectFees` are `nonReentrant`
through OpenZeppelin's `ReentrancyGuardTransient`, which keeps its flag in
transient storage (EIP-1153, `TLOAD`/`TSTORE`). That requires the Cancun
hard fork, which is live on mainnet and Sepolia and is the pinned
`evmVersion`; the contract must not be deployed on a chain without
EIP-1153. The owner functions `checkIn`, `requestWithdraw`,
`requestChange` and `cancelPending`, the signed `checkInWithSig` and
`cancelPendingWithSig`, and the admin setters are not guarded; they move
no tokens, and their only external calls are the registry view in
`requestChange` and the ERC-1271 `staticcall` in the two signed ones. The
token-moving functions write state before the transfer (checks, effects,
interactions), except that `_pull` necessarily reads the balance after
the incoming transfer.

### Time assumptions

All timing uses `block.timestamp`. `readyAt = uint64(block.timestamp) +
exitDelay` is computed at request time with the delay in force then. The
fallback condition is `block.timestamp >= lastActivity + silencePeriod`
computed in uint256. `lastActivity` is refreshed by the owner's `open`,
`deposit`, `checkIn`, `requestWithdraw`, `requestChange` and
`cancelPending`, by `checkInWithSig` and `cancelPendingWithSig` carrying
the owner's signature, and by nothing else. Signature deadlines are
inclusive (`block.timestamp > deadline` reverts `SignatureExpired`). The
minimum silence (180 days) is longer than the maximum exit delay (90
days). On proof-of-stake Ethereum the timestamp is fixed by the slot, so
proposer skew is not a concern at day granularity. The veto window of a
pending operation ends at `readyAt`, not at execution, because anyone may
execute from that second on.

## 4. Invariants and questions

### Invariants we want you to try to break

1. **Solvency per token.** For every token T, `T.balanceOf(vault)` is at
   least the sum of `balance` over all positions in T, plus the sum of
   `owed[id][payee]` over all positions in T and all payees, plus
   `feesAccrued[T]`. With the curated tokens it is equal unless someone
   transferred T directly to the vault.
2. **Exit paths.** A position's `balance` decreases only in
   `executePending` (Withdraw), `veto` and `executeFallback`. An `owed`
   entry decreases only in `claimOwed` and `claimOwedWithSig`;
   `feesAccrued` only in `collectFees`. Tokens leave the vault only in
   those six functions, and only to, respectively, the `to` fixed at
   `requestWithdraw`, the `recoveryTo` hashed into the active pinned
   digest, the beneficiaries of the active config, the payee of that
   `owed` entry, the destination signed by that payee, and the current
   `feeRecipient`.
3. **Delay.** A withdrawal pays nothing before `readyAt`, which equals the
   request timestamp plus the exit delay in force at the request. A config
   change (including its new digest, new exit delay and new hold mask)
   takes effect only at or after the `readyAt` computed from the delay in
   force at the request. No sequence of calls makes a new, shorter delay
   apply to an operation requested under the old one.
4. **Veto availability.** While a position is open and its `vetoDigest` is
   non-zero, `veto` with the matching `(secret, recoveryTo)` succeeds at
   any time, whatever is pending, whatever the pause, listing and fee
   state, and whether or not the token transfer to `recoveryTo` succeeds.
   It moves exactly the full `balance` to `recoveryTo` (paid or owed),
   takes no fee, clears the pending slot and closes the position.
5. **Digest binding.** `veto` succeeds only if
   `keccak256(abi.encode(VETO_TAG, chainid, vault, owner, secret, recoveryTo))`,
   with `owner` the position's owner, equals the position's active digest.
   The active digest changes only in `executePending` of a Change, and
   only to the digest that was pinned at the matching `requestChange`.
6. **One sheet, one position per owner.** For any two distinct positions
   of the same owner, the sets of digests each has ever held (active or
   pending) are disjoint. `digestPinned[owner][digest]` is set once and
   never cleared, and no call by another address can set it.
7. **Admin has no reach.** Admin functions write only `tokenSupported`,
   `depositsPaused`, the global `feeBps`, `feeRecipient` and ownership
   state. No admin action changes any position (including its `feeBps`),
   `owed` entry, pinned digest or nonce, or makes any of `executePending`,
   `veto`, `executeFallback`, `claimOwed`, `claimOwedWithSig`, `checkIn`,
   `checkInWithSig`, `requestWithdraw`, `requestChange`, `cancelPending` or
   `cancelPendingWithSig` revert.
8. **Exits are never pausable.** Only `_pull` (reached from `open` and
   `deposit`) reads `depositsPaused` and `tokenSupported`.
9. **Fallback payout.** `executeFallback` succeeds only if the silence
   period is non-zero, nothing is pending, and `block.timestamp >=
   lastActivity + silencePeriod`. With `fee = floor(balance * feeBps /
   10000)` and `total = balance - fee`, each beneficiary except the last
   receives `floor(total * share / 10000)`, the last receives the
   remainder, and for every beneficiary the amount is transferred, recorded
   as owed after a failed transfer, or, if its `holdMask` bit is set,
   recorded as owed without a transfer attempt.
10. **Activity.** Only the position owner, by a call or by a valid
    signature, can move `lastActivity`. No action by another address,
    including a deposit, delays the fallback.
11. **Closed is terminal.** Once `closed` is true, no function changes that
    position's balance, config, digest or pending slot; `deposit` and the
    signed owner actions revert. Only `claimOwed` and `claimOwedWithSig`
    still act for it.
12. **Open implies funded.** Every open position has `balance > 0`.
13. **Pending consistency.** At most one operation is pending per
    position. For a pending Withdraw with a fixed amount, `amount <=
    balance` holds at every point until it executes or is cleared.
14. **Owed never freezes.** A failed withdrawal, fallback or veto transfer
    never reverts `executePending`, `executeFallback` or `veto`; the
    payee's `owed` grows by exactly the failed amount, and the entry can
    only ever be paid to that payee or to a destination that payee signed.
15. **Stored configs are valid.** Every active or pending config has an
    exit delay in {7, 30, 90} days; either silence 0, no beneficiaries and
    `holdMask == 0`, or silence in [180, 1095] days with 1 to 10 distinct
    non-zero beneficiaries (none equal to the vault), non-zero shares
    summing to 10,000, and no `holdMask` bit at or above the list length.
16. **Token isolation.** A position is only ever paid in its own token,
    and a hostile token listed by the admin cannot affect the balance,
    exits or fees of positions in any other token.
17. **Fee bounds.** Every fee taken is `floor(amount * p.feeBps / 10000)`
    with `p.feeBps` the rate stored at opening, which is at most both
    `MAX_FEE_BPS` and the opener's `maxFeeBps`. For every withdrawal and
    release, the net paid or owed plus the fee equals exactly the amount
    that left the position's balance.
18. **Signatures.** Each signed action succeeds only with a valid
    signature of the stated signer (owner for check-in and cancel,
    `beneficiary` for a claim) over every argument of the call, under this
    vault's domain, before its deadline, and at most once per nonce. A
    signed cancel cancels only an operation with the signed `readyAt`.
19. **Held shares.** An `owed` entry of a `holdMask` beneficiary without
    code moves only by that beneficiary's own `claimOwed` call or its
    signature.

### Specific questions and areas of concern

- **Q1. Owed accounting with blacklisted payees.** Check `owed` for a
  withdrawal payee blacklisted after the request, for beneficiaries
  blacklisted at fallback time, for a blacklisted `recoveryTo` at veto
  time, for the same address appearing as a withdrawal payee, a
  beneficiary and the recovery wallet, for a token-wide pause (USDC can
  pause all transfers), and for the case where the vault itself is
  blacklisted. Is there any path where `owed` becomes unclaimable while
  the payee is able to receive or sign, or where the sum of balances, owed
  and fees exceeds holdings?
- **Q2. The veto now records owed.** v1's veto reverted on a failed
  transfer, so a paused token across a pending withdrawal's `readyAt`
  left the owner unable to stop the attacker. v2 pays the veto through
  `_payOrOwe`. Please confirm the veto now always wins the race it should,
  that the owed amount for `recoveryTo` cannot be taken by anyone else,
  and whether a caller can deliberately make the veto's transfer fail
  (see Q9) with any effect worse than a delayed claim.
- **Q3. Per-owner pinning.** v1's global `digestPinned[digest]` let anyone
  copy a freshly registered public digest into its own registry history
  and pin it first, burning the victim's sheet. v2 pins per owner and the
  digest binds the owner. Please confirm that no third party can make an
  owner's `open` or `requestChange` revert with `CommitmentReused`, that a
  decoy position holding a copied digest can never be vetoed with the
  owner's secret, and that the per-owner map still stops a revealed secret
  from unlocking a sibling position of the same owner. Also assess that a
  cancelled `requestChange` burns its digest, and that an attacker with the
  owner's key can still burn sheets the owner registered for future
  positions (accepted: the attacker with the key is already the threat
  the delay handles).
- **Q4. Pending operations and fallback timing.** A pending operation
  blocks `executeFallback` until someone executes it, and `executePending`
  does not refresh `lastActivity`. Check that no sequence lets a pending
  operation block the fallback forever, or lets an applied change make the
  fallback executable earlier than the owner could expect. In v2
  `fallbackAvailableAt` returns 0 for unknown or closed positions and for
  no fallback, uses the pending change's silence period when a change is
  pending, and returns the later of `lastActivity + silence` and a pending
  `readyAt`. Please confirm it cannot mislead a relayer into anything
  worse than a revert (for example, a pending `ALL` withdrawal that will
  close the position still reports a time).
- **Q5. `ALL` withdrawals.** `requestWithdraw(id, ALL, to)` resolves to the
  balance at execution and closes the position. Check interaction with
  stranger deposits made after the request, with the fee on the resolved
  amount, with a failed payout recorded as owed, and with a veto or
  fallback racing the execution.
- **Q6. Rounding in fees and share splits.** Confirm that exactly the
  gross amount leaves the position in every case (net plus fee), that
  zero-amount shares are skipped safely, that no beneficiary can be pushed
  below its floor share, and that the remainder given to the last
  beneficiary is bounded by `n - 1` units. The fee rounds down, so a
  withdrawal below `10000 / feeBps` units pays none; each such withdrawal
  waits the full delay, so we consider fee avoidance by splitting
  uneconomic. Please say if you disagree.
- **Q7. Griefing through stranger deposits.** Anyone can deposit into any
  open position. Check effects on fixed-amount withdrawals, on `ALL`, on
  the veto and fallback amounts, on fees, on gas, and the non-technical
  effect of depositing tainted funds into someone else's position.
- **Q8. Mempool front-running of the veto.** A veto transaction reveals
  the secret. We believe a front-runner can only perform the same veto,
  because the destination and owner are in the digest and a digest cannot
  be pinned twice by the same owner. Please also look at the race at
  exactly `readyAt` between a veto and the attacker's `executePending`,
  and at an attacker with the owner's key reacting to a veto in the
  mempool (for example by cancelling and re-requesting). The app sends
  vetoes through a private relay.
- **Q9. Gas griefing of `trySafeTransfer`.** It forwards all gas and treats
  out of gas as failure. Can a caller of `executePending`,
  `executeFallback` or `veto` choose a gas limit that makes a payout fail
  and be recorded as owed, while the rest of the call completes? Our
  estimate is that recording owed (a fresh storage slot) needs more than
  1/64 of what any curated token's transfer needs, so it is infeasible,
  but we want it confirmed. The outcome would be a claimable owed entry,
  not a loss.
- **Q10. USDT.** Confirm that no vault path depends on `approve`, that
  `safeTransferFrom` and `safeTransfer` handle USDT's missing return
  value, and what happens if Tether switches on its transfer fee (we
  expect deposits to be credited net, and payees and the fee recipient to
  receive net while the vault is debited the gross amount, so no
  cross-position loss).
- **Q11. A curated token upgraded to add hooks.** If USDC or USDT (or a
  future listing) gained transfer hooks or callbacks, what can a hook do
  through the unguarded owner and signed functions, or through the guarded
  ones during `_pull`, `executePending`, `veto`, `executeFallback`,
  `claimOwed`, `claimOwedWithSig` or `collectFees`? Is the balance-delta
  measurement in `_pull` safe against a hook that moves vault funds during
  the incoming transfer?
- **Q12. Compromised key without a veto.** For a position opened with
  `NO_VETO`, an attacker with the owner's key and the owner can cancel
  each other's requests indefinitely, and every such call (direct or
  signed) refreshes `lastActivity`, so the fallback never arrives either.
  We consider this an accepted limitation of a position without a veto;
  please say if you see a worse outcome than a stalemate.
- **Q13. Removing the veto.** A config change with `NO_VETO` removes the
  veto after the delay. Confirm the old digest can veto for the whole
  wait and that nothing lets the removal apply early.
- **Q14. Toolchain.** `viaIR` with solc 0.8.35, a transient-storage
  reentrancy guard and EIP-712 immutables: anything in the generated code
  or in the storage of nested dynamic arrays (`delete p.pending`,
  storage-to-storage copy in `_copyConfig`) you would flag.
- **Q15. Signed actions.** Review the three typehashes against the
  encoded fields, the domain (a v1 or other-chain signature must fail),
  malleability, and ERC-1271 behaviour (a verifier that reverts, returns a
  wrong value or short data, or consumes all gas). Two specific points:
  (a) nonces are per signer and purpose, not per position, so an owner
  with several positions consumes one check-in counter across all of them
  and a pre-signed check-in for one position is voided by any check-in
  signature used first for another; (b) `CancelPending` binds `id` and
  `readyAt` but not the kind, amount or destination, so a cancel signed
  for one operation, left unused, would also cancel a later operation on
  the same position with the same `readyAt` (a cancel and re-request in
  the same block under the same delay). We believe both only ever help or
  inconvenience the owner; please confirm.
- **Q16. `holdMask` and the `code.length` gate.** `claimOwed` by a third
  party reverts `ShareIsHeld` only when the payee is held in the current
  config and has no code. Please consider EIP-7702 delegated EOAs (code
  present, so anyone may push, and `SignatureChecker` takes the ERC-1271
  path for them), counterfactual smart wallets that are not yet deployed
  at release, a held beneficiary that is also the withdrawal payee or the
  recovery wallet, and a held key that is lost (its share stays in the
  vault forever; accepted, there is no admin path).
- **Q17. Fee surface.** The admin can redirect all uncollected fees by
  `setFeeRecipient`, and an owner who commits a sheet to their own address
  can leave at once and fee-free through the veto (an accepted business
  fact: a stop is free by design). Please check that no path charges a fee
  twice, charges a fee on an owed claim or a veto, lets a fee change reach
  an open position, or lets `collectFees` for one token affect another.

## 5. How to run

Requirements: Node.js 20 or later, npm, git. Any OS; the maintainers use
Windows PowerShell, where commands are run one per line.

```powershell
git clone <repository URL>
cd computing-sc
git checkout v2026.09.29
npm ci
npx hardhat compile
npx hardhat test test/ShieldVault.spec.ts
npx hardhat test
```

No `.env` is needed for local tests. If a `fork-block.json` and an RPC
variable are present, the Hardhat network forks; set `HARDHAT_NO_FORK=1`
to be sure you get a fresh local chain.

Current result, recorded on 2026-09-29 on the working tree above with
`HARDHAT_NO_FORK=1`:

```
ShieldVault
  40 passing (2m)
```

Wall time about 135 seconds on the maintainer's Windows machine, of which
the property test takes about 113 seconds; every other spec runs in under
two seconds. The full repository suite: 253 passing on the v2 tree
(2026-09-29).

What the 40 specs cover. From v1, adapted: opening and listing; config
validation; token allowlist, fee-on-transfer crediting and pause of
deposits only; delisting blocks deposits, never exits; withdrawal delay
to the second and no replay; owner-only start and cancel, one pending at
a time; veto clears a pending theft; a copied secret cannot redirect;
commitments for another vault, chain or owner, or in the v1 format, fail;
a thief's fresh commitment is useless; scheme-5 and caller-owned
commitments only; config change waits the current delay; fallback
timing, check-in reset, stranger deposits not counting as activity;
pending blocks fallback; blacklisted beneficiary becomes owed; no
fallback without one; blacklisted withdrawal payee becomes owed; `ALL`
against dust; vault not allowed as beneficiary; one sheet per position;
delay composition; exits while paused and delisted;
`fallbackAvailableAt` with a pending operation. New in v2: a copied
digest neither burns the owner's sheet nor absorbs its veto in a decoy
(and `PositionOpened` carries the digest); `open` refuses a fee above
`maxFeeBps`; per-purpose nonces (spent check-ins never void a cancel or a
claim); a held share cannot be pushed onto its paper key's address; a veto
never fails (unpayable recovery wallet becomes owed, the theft is gone);
`fallbackAvailableAt` follows a pending change and is 0 for closed or
unknown positions; the fee is fixed at opening, capped, charged on
withdrawals and releases, never on a veto, and collected to the
recipient; an unpayable fee recipient never blocks an exit; a held share
is claimed by the paper key's signature to any destination, with forged,
redirected, replayed and expired signatures refused; signed check-in and
cancel relayed once, a stale cancel refused for a later operation; a
contract payee is never locked by the hold; 10 held beneficiaries with an
odd total and a fee split exactly; a third party cannot consume a nonce;
ERC-1271 owners sign, and verifiers that revert, return a wrong value or
return short data never pass; two-step ownership and the admin surface
enumerated from the ABI, each admin setter refused to a stranger.

Property test ("over random operation sequences the vault always holds
balances plus owed plus fees"): the vault fee is set to 25 bps, and a
seeded linear congruential generator (seed `0xc0ffee`, so the run is
deterministic) drives 80 steps over three owners and a shared payee set.
Each step picks one of: open with a fresh sheet, owner deposit, request a
withdrawal (a random part or `ALL`), execute pending, cancel or request a
change, veto, fallback, time jump of 1 to 120 days, toggle a 0.5%
transfer fee, toggle a blacklist on a payee, a stranger's dust deposit,
or `claimOwed` / `collectFees`. Invalid moves revert and are ignored.
After every step it asserts that the vault's token balance equals
`feesAccrued` plus the sum of all position balances plus all owed
amounts. It uses `MockAwkwardERC20`, an ERC-20 with a burned transfer fee
and a USDC-style blacklist on sender and receiver. It does not exercise
`holdMask` or the signed functions; those are covered by the unit specs
above.

Coverage: `solidity-coverage` 0.8.16 is installed as a dev dependency but
is not wired (there is no `.solcover.js` and no coverage script), so we
have no coverage figure to give you. There is no CI and no fuzzing or
formal verification harness; the specs above and the Sepolia smoke script
are the whole automated safety net for this contract.

## 6. Intentional design decisions and prior findings

### Intentional, please do not report as bugs

Please do tell us if you think one of these is wrong; we only ask that it
is framed as a design comment rather than a finding.

- Not upgradeable and no admin path into positions. A fix is a new
  deployment.
- `renounceOwnership` is left in place. Renouncing would freeze curation
  and the fee (no new listings, no pause, fees still collectable to the
  last recipient) and affects no position.
- After `readyAt` anyone may execute a pending operation, so the veto
  window ends at `readyAt`. The alerting and the app's private relay are
  built around that.
- Anyone may deposit into any open position; only the owner's deposits
  count as activity.
- One pending operation at a time. A pending operation blocks the fallback
  until someone executes it. Cancel and re-request restarts the full delay.
- A config change waits the current exit delay, not the new one.
- `requestChange` pins its new digest at request time, so the pending
  digest is visible for the whole wait (it is in `ChangeRequested`) and a
  cancelled change burns that sheet for the owner.
- A config change may keep the current digest or remove the veto
  (`NO_VETO`), after the delay.
- The veto pays the whole balance, including strangers' deposits, closes
  the position even when the balance is zero, uses only the active digest,
  never a pending one, is free of fee, and records owed instead of
  reverting when the transfer fails.
- The last beneficiary receives the rounding remainder; zero-amount
  shares are skipped without an owed record.
- `claimOwed` is callable by anyone and always pays the recorded payee,
  except that it refuses to push a held share onto a codeless address.
  The only redirection is `claimOwedWithSig`, signed by the payee itself.
- Exit delays are limited to 7, 30 or 90 days; silence to 0 or 180 to
  1,095 days; at most 10 beneficiaries, which bounds the fallback loop and
  `_isHeld`.
- Fee-on-transfer tokens are credited net; rebasing tokens are refused by
  policy; tokens sent to the vault directly are not recoverable.
- The fee is fixed per position at opening, capped at 0.5% in code, and
  charged on withdrawals and fallback releases only. Uncollected fees
  follow the current `feeRecipient`.
- There is no signed `requestWithdraw` or `requestChange`, and no signed
  deposit.
- Events are emitted before the outgoing transfer in `executePending`,
  `veto`, `executeFallback`, `claimOwed`, `claimOwedWithSig` and
  `collectFees`; the whole call reverts if a reverting transfer fails.
- The registry commitment's `registeredAt` and `recoveryContext` are not
  checked. The digest already binds chain, vault, owner and destination.
- Positions are not transferable, and one position holds one token.

### Events and errors added in v2

Events: `FeeCharged(id, token, amount)`, `ShareHeld(id, beneficiary,
amount)`, `FeeSet(feeBps)`, `FeeRecipientSet(recipient)`,
`FeesCollected(token, to, amount)`. Changed signatures (a new deployment,
so no indexing history to preserve): `PositionOpened` carries
`vetoDigest` and `feeBps` in place of v1's `bool vetoArmed`;
`OwedClaimed` adds the destination `to` (indexed);
`ChangeRequested`'s `beneficiariesHash` now also covers `holdMask`.
Errors: `FeeTooHigh`, `SignatureExpired`, `InvalidSignature`,
`ShareIsHeld`. Views: `fallbackAvailableAt` (revised), `domainSeparator`,
`nonces`, `feesAccrued`.

### Internal adversarial review, 2026-09-28, before the v1 deployment

No Critical or High. Acted on before deployment, and carried into v2:

- Medium: a withdrawal payee that could no longer receive (for example
  blacklisted after the request) made `executePending` revert; with an
  owner unable to cancel, the pending slot would have blocked the fallback
  forever. Fixed: the failed payout becomes `owed` and the slot clears.
- The vault itself can no longer be named as a beneficiary.
- `ALL` withdrawals, so a stranger's dust cannot keep a closing position
  open.
- One digest per position (`digestPinned`, `CommitmentReused`), so a veto
  that reveals a secret cannot also unlock a sibling position.
- `ChangeRequested` carries the new digest and a hash of the new
  beneficiary list, so an alert can name a swapped recovery sheet even
  when the people are unchanged.
- `fallbackAvailableAt` accounts for a pending operation.
- Added tests for exits while paused and delisted, delay composition, and
  the property test.

### Audit preparation and second review, 2026-09-28 to 2026-09-29 (v2)

Writing the v1 version of this package raised two issues we judged worth
a new deployment rather than a note: the veto reverting on a failed
transfer (v1 Q2) and the global digest pin that allowed burning another
user's sheet (v1 Q3). v1 was paused and v2 fixes both (veto through
`_payOrOwe`; owner-bound digest and per-owner pin). The same deployment
folded in the deferred items that would otherwise have needed their own
v3: signed check-in and cancel, paper-key heirs (`holdMask`,
`claimOwedWithSig`), the per-position fee, and the revised
`fallbackAvailableAt`. A second adversarial review of v2 preceded the
deploy; its tests are the "new in v2" specs in section 5.

Before the mainnet deploy of v1 the app was walked end to end on Sepolia
with a real wallet; for v2 the Sepolia deployment passed the smoke script
listed under Deployments.

## 7. Firm shortlist

Only firms we are confident exist and audit Solidity. We have not asked
any of them for prices yet.

| Firm | Shape | Why |
|---|---|---|
| CDSecurity | Boutique, previous auditor | Audited our full suite including the timelocks and premium in October 2025, so they know the codebase, the governance and our conventions. Continuity and the shortest ramp-up. |
| Pashov Audit Group | Boutique team | Known for many small, focused audits with short lead times; a 492 nSLOC single contract is within their usual size. |
| ChainSecurity | Top-tier firm | Long record auditing Lido's contracts, and wstETH is the asset this vault will mostly hold. |
| OpenZeppelin | Top-tier firm | Maintainers of the libraries we inherit (`SafeERC20`, `ReentrancyGuardTransient`, `Ownable2Step`, `EIP712`, `SignatureChecker`); a strong public report for a security-branded product. Likely the longest lead time and highest price. |
| Code4rena (or Sherlock) | Competitive audit platform | Many independent researchers on the same code, good for adversarial edge cases; check the minimum pot and duration, which may be large relative to 492 nSLOC. |
| Cantina | Managed review with a single lead researcher | Lets us book one senior independent researcher from their network for a short fixed engagement, a middle ground between a boutique and a contest. |

### What every quote request must specify

- Scope: `contracts/shield/ShieldVault.sol` (v2), 492 nSLOC, at the
  tag `v2026.09.29`; the deployed mainnet address; the registry
  (47 nSLOC) as an optional line item.
- The inherited OpenZeppelin 5.6.1 contracts (including `EIP712` and
  `SignatureChecker`), solc 0.8.35 with `viaIR`, Cancun.
- Timeline: earliest start date, review duration, and report delivery date.
- Deliverables: a written report with severity classification; one fix
  review round (or, since code cannot change in place, a review of a v3
  deployment diff if findings require one); permission to publish the
  report under our name; optionally, any invariant or fuzz tests they
  write during the review handed over to us.
- Price as a fixed fee, stating what is included and what counts as
  additional.

### Effort estimate (ours, not a quote)

For 492 nSLOC of stateful, funds-holding logic with one external
dependency and three signed entry points, we expect about **4 to 6
auditor-days** of manual review (around 100 to 150 nSLOC per auditor-day,
plus reading the spec and writing the report), and **0.5 to 1
auditor-day** for a fix review. Most firms staff two researchers, so that
is roughly 2 to 3 working days of calendar time. Adding the registry adds
well under one auditor-day. A contest would typically run for a few days
to a week regardless of size. These numbers are our estimate for planning
only; the firms' own scoping decides.

## 8. Quote request email and pre-audit checklist

### Email

> Subject: Audit quote request: ShieldVault (492 nSLOC, Solidity)
>
> Hello,
>
> We are 10102 (Computing, an Ethereum inheritance and timelock app, live
> on mainnet since October 2024 and previously audited by RockSolid
> Security and CDSecurity). We would like a quote for an audit of one
> contract:
>
> - `ShieldVault.sol` (v2), 492 nSLOC, solc 0.8.35 (viaIR, optimizer 200
>   runs, Cancun), inheriting OpenZeppelin 5.6.1 `Ownable2Step`,
>   `ReentrancyGuardTransient` and `EIP712`, and using `SafeERC20` and
>   `SignatureChecker`.
> - Tag `v2026.09.29`; already deployed and verified
>   on mainnet at `0xA1EA2F8C0518458975E09ED63bf5D48980f76C38`.
> - It is a non-upgradeable vault where each position leaves only by a
>   delayed withdrawal, an inactivity fallback to named beneficiaries, or
>   an immediate veto to a pre-committed recovery wallet (a hash preimage
>   registered in our `QuantumRecoveryRegistry`, 47 nSLOC, optional
>   add-on). It also has EIP-712 signed check-ins, cancels and heir
>   claims (EOA and ERC-1271), and an exit fee capped at 0.5%.
>
> We will provide a spec, a threat model, 19 invariants, a list of
> specific questions and a passing test suite (40 specs).
>
> Please include: earliest start date, duration, delivery date, fixed fee,
> one fix review round, and permission to publish the report. We are
> planning to make this contract the default for staked ETH deposits in
> our app and would like the report before that.
>
> Thank you,
> [name], 10102
> security@10102.io

### Checklist before the audit starts

- [ ] Confirm tag `v2026.09.29` resolves to the commit holding v2, and
      do not edit `ShieldVault.sol` before or
      during the audit. Any edit, even a comment, changes the metadata
      hash and the audited source would no longer be the deployed one.
- [ ] Record the bytecode match (done 2026-09-29, see Scope) in the email
      thread so the auditors can rely on it.
- [ ] NatSpec gaps: no function has `@param` or `@return` tags, and the
      constructor, `setTokenSupported`, `setDepositsPaused`,
      `setFeeRecipient`, `checkIn`, `cancelPending`, `positionOf` and
      `positionsOf` have no `@notice`. Supply these explanations in this
      package, not in the frozen source.
- [x] (2026-09-29) Fix the spec drift in `docs/plans/shield-vault.md`: the operations
      table lists `open(token, amount, config, vetoIndex)` without
      `maxFeeBps` and omits the signed functions and `collectFees`; the
      admin surface section says `setTokenSupported` and
      `setDepositsPaused`, "nothing else"; the events list omits the v2
      events; the veto commitment section does not say that pinning is
      per owner; the "Out of scope for v1" section still lists gasless
      check-ins.
- [ ] Wire `solidity-coverage` (add a `.solcover.js`; with `viaIR` it may
      need `configureYulOptimizer: true`), run it on
      `test/ShieldVault.spec.ts`, and attach the line and branch figures.
- [x] (2026-09-29: 253 passing) Re-run the full repository suite on the v2 commit and record the
      count here.
- [ ] Decide repository access (public link or invite) and send this
      document, the spec and the test file with the kickoff.
- [ ] Decide whether the one-click staked ETH default waits for the final
      report or ships after the preliminary one.
- [ ] Migration: v2 is the migration target from v1. v1 has 0 positions on
      mainnet and is paused for deposits; its exits keep working and need
      no action. If a finding needs a fix in v2, the same pattern applies
      again (a v3 deployment, the app opening new positions there only,
      owners leaving v2 through their own delay or veto, alerts
      explaining it).
- [ ] Name one point of contact and a response time commitment for the
      auditors' questions.
- [ ] Tell the auditors the governance Safe is still threshold 1, with the
      move to 2-of-3 pending, so they do not spend time rediscovering it.
- [ ] Agree on the public report and plan where it will be published
      (`README.md` audit section, the audits repository).

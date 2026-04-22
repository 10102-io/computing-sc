# Create-flow v2 — Permit2 + off-chain beneficiary metadata

**Status**: Planned (not started)
**Priority**: Next `computing-sc` milestone after EIP-1167
**Created**: 2026-04-22
**Bundle**: Permit2 + off-chain beneficiary metadata (bundled because both require a
`TransferEOALegacyRouter` redeploy + re-verify + artifact reconcile cycle —
splitting them would double the contract-ops overhead for no benefit)
**Target networks**: mainnet + Sepolia
**Touch radius**: `computing-sc` (new router impl + clone impl + storage-layout
bump), `computing-admin` (new metadata endpoints), `computing` (new create flow +
API client), `computing-subgraph` (drop PII fields), one-time ETL job

---

## 1. Summary (the one paragraph)

Today's real-mainnet EOA legacy create costs ~$20 at typical gas prices and
asks the user for **at least three wallet confirmations** (sign-agreement +
create + 1-per-token approvals). Roughly half of that gas is paying to
persistently store beneficiary names + emails + legacy name on a public
immutable ledger — data that is UX-only, never consulted by claim logic, and
legally radioactive under GDPR. This plan does three things in one coordinated
release:

1. **Trim `initialize()` down to fields that are actually load-bearing on-chain**
   (`GenericLegacy.beneName`, `GenericLegacy.legacyName`, and the
   `PremiumSetting` on-chain email storage all come out), reclaiming the
   storage gas that was going to PII.
2. **Integrate Uniswap's Permit2** (SignatureTransfer + `permitWitnessTransferFrom`)
   so the creator signs one EIP-712 message that binds together "I agree to the
   terms" and "I approve N tokens for legacy address X with allocations Y" —
   collapsing sign-agreement + approvals into a single signature.
3. **Layer EIP-5792 `wallet_sendCalls` on top** so wallets that support it see
   a single atomic confirmation for the whole create, falling back to two
   prompts (sign + send) on older wallets. The Permit2 integration makes this
   possible at all — without it, ERC-20 `approve` calls always need separate
   transactions.

The end-state create flow is **one wallet prompt** on supported wallets, ~60% less
gas than post-EIP-1167, and no new on-chain PII. Beneficiary name + email move
to a creator-signed `computing-admin` endpoint so right-to-be-forgotten requests
can actually be honored.

## 2. Background — current state of `TransferEOALegacy` + neighborhood

All references below are against contracts at the `dev` tip as of 2026-04-22
(release `96218eea`):

- `contracts/forwarding/TransferLegacyEOAContract.sol`
  (`TransferEOALegacy`, the per-legacy clone target).
- `contracts/forwarding/TransferLegacyEOAContractRouter.sol`
  (`TransferEOALegacyRouter`, upgradeable singleton).
- `contracts/common/GenericLegacy.sol` (shared base, holds the `beneName`
  mapping and `legacyName` string — both PII).
- `contracts/common/EOALegacyFactory.sol` (the EIP-1167 clone factory path
  used by the router's `createLegacy`).
- `contracts/premium/PremiumSetting.sol` (holds `legacyCfgs[legacyAddress]`
  with beneficiary `name + email` tuples, plus `userConfigs[user]` with
  owner `name + email`).
- `contracts/term/VerifierTerm.sol` (`EIP712LegacyVerifier`, stores the
  user's terms-of-service signature alongside each legacy).

### 2.1 Fields on-chain today — what they store and who actually reads them

| Field | Lives in | Written by | Read by | Load-bearing? |
|---|---|---|---|---|
| `GenericLegacy.beneName[beneAddress]` | clone storage | `initialize()`, `setLegacyDistributions`, `_setLayer23Distributions` | Only `_transferAssetToBeneficiaries` → `receipt[i].name` → forwarded to `premiumSendMail.sendEmailContractActivatedToOwner` as part of the owner-side email body. The `triggerActivationTransferLegacy` beneficiary-side email path separately reads `name` from `PremiumSetting.legacyCfgs`, not from `beneName`. | **No.** The email path has `PremiumSetting` as an authoritative-enough source for the owner-side receipt too (same user set it there). Remove. |
| `GenericLegacy.legacyName` | clone storage | `setLegacyName` (called from `createLegacy` + `setLegacyConfig`) | `premiumSendMail.sendEmailContractActivatedToOwner` subject + `triggerActivationMultisig` + `triggerOwnerResetReminder` | **Weakly** — used in email subjects. Can be moved off-chain (DB) with the email worker reading from DB by `legacyAddress`. Or just emitted as event + indexed — subgraph can surface it to the worker. |
| `PremiumSetting.legacyCfgs[legacy].beneficiaries[i].{name,email}` | `PremiumSetting` storage | `_updateLegacyConfig` (via `setReminderConfigs` / `updateLegacyConfig`) | `triggerActivationTransferLegacy`, `triggerOwnerResetReminder`, `triggerActivationMultisig` — all call `premiumSendMail` with these strings inline | **Yes** (today). This is the email worker's on-chain source of truth. Replacing it with off-chain means `premiumSendMail` becomes a webhook that resolves emails from a DB keyed by `(chainId, legacyAddress, beneficiaryAddress)`. |
| `PremiumSetting.legacyCfgs[legacy].secondLine + thirdLine` | same | same | same | same analysis |
| `PremiumSetting.userConfigs[owner].{ownerName, ownerEmail}` | same | `_updateUserConfig` (via `setReminderConfigs` / `updateUserConfig`) | same email-worker paths (as the "send to owner" email target) | **Yes** (today). Same off-chain migration applies. |
| watcher `name` + `address` + `isFullVisibility` | *not stored* — only emitted in `WatcherUpdated` events from `setWatchers` | n/a | subgraph indexes events, UI reads from subgraph | Already event-only. Still PII on a public log though — keep the address, strip the name from the event, move name off-chain. |
| legacy `note` (config field) | *not stored* — only in `TransferEOALegacyCreated` event | n/a | subgraph / UI | Same — strip from event. |
| `EIP712LegacyVerifier.legacySigned[user][i].{legacyAddress, timestamp, signature}` | verifier storage | `storeLegacyAgreement` | Legal compliance audit trail, verifiable from the UI | **Load-bearing for compliance.** Keep. This is the actual terms-of-service signature; it must stay on-chain and immutable for legal defensibility. Not PII — just signatures. |

**Upshot**: out of the large on-chain string surface, the *only* truly
load-bearing string is the legacy's own `name` used in email subjects, and
even that can graduate to off-chain DB keyed by legacy address. Everything
else is gas being spent to store data that could have been a row in a
database.

### 2.2 Current create-flow wallet prompts

From the end-user's perspective a "successful create" today looks like:

1. **Sign terms-of-service message** (EIP-191 prefixed, off-chain signature via
   `personal_sign`) — free, no tx.
2. **`TransferEOALegacyRouter.createLegacy(...)`** — ~800k–1.1M gas mainnet
   tx. Writes the clone init, stores the TOS signature on-chain, registers
   Chainlink Automation, emits events.
3. **For each included ERC-20**: one `approve(legacy, amount)` tx per token.
   Typically 1–3 tokens for a median user, each 46k gas.
4. **(Premium only)** separate tx to `setReminderConfigs` — writes owner + bene
   email + name strings to `PremiumSetting`. Another few hundred k gas,
   another wallet prompt.

Step 2's gas is dominated by:

- Clone deploy via `CREATE2` on the LegacyDeployer: ~40k (EIP-1167, already
  landed).
- Initializer SSTOREs: 5–8 per beneficiary (address set insert, distribution
  mapping, `beneName` mapping, plus layer2/3 mirrors if premium) — at
  ~22k–40k gas each when cold, this is ~200–400k gas for a typical
  2-beneficiary premium legacy with a layer-2 fallback.
- `setLegacyName` SSTORE on the clone: ~40k cold.
- `storeLegacyAgreement` → ecrecover (3k) + push onto `legacySigned[user]`
  (~40k first time, ~25k subsequent).
- `setPrivateCodeAndCronjob` → `PremiumSetting` SSTOREs + Chainlink Automation
  registration: ~150k depending on path.
- Event emission + all the remaining bookkeeping: ~50k.

The ERC-20 approvals in step 3 are each ~46k gas plus the wallet-prompt friction
(which is what users actually complain about — the dollar cost of approvals
is rarely the pain point; the five confirmations are).

## 3. Gas target

Post-v2, for a representative create (2 beneficiaries, 1 layer-2 fallback,
premium, 2 ERC-20s included):

| Cost bucket | Today | v2 target | Savings |
|---|---|---|---|
| Clone deploy + init | ~450k | ~230k | Remove `beneName[]` SSTOREs (3×40k = 120k) + remove `legacyName` SSTORE (40k) + cut layer2/3 nickname SSTOREs (2×40k = 80k). No change to distribution logic. |
| TOS signature storage | ~25k | ~25k | No change — compliance-critical, keep. |
| Email config storage | ~180k (separate tx today) | 0 on-chain | Move entirely off-chain; still emit a minimal event so subgraph can flag "has off-chain metadata" for the UI. |
| Chainlink Automation registration | ~150k | ~150k | No change (functionally required). |
| ERC-20 approvals (2 tokens) | 2 × 46k = 92k | 0 (Permit2 handles pulls on-demand) | Move to Permit2 signature — no storage writes during create. First-ever `approve(Permit2, max)` is a separate one-time 46k tx per user per network but amortizes across all future creates + every other Permit2-using dapp. |
| **Total create path** | **~900k–1.1M** | **~400–500k** | **~55–60% reduction** |

Plus the UX win of **one wallet prompt** instead of 3–5, which is worth more
than the gas savings.

## 4. Design pillars

1. **No regressions to claim semantics.** A pre-v2 legacy must still be
   claimable after v2 ships. A v2 legacy must be claimable even if the off-
   chain metadata service is permanently offline (the claim path only needs
   on-chain data: addresses + percentages + activation trigger).
2. **Terms-of-service signature stays on-chain.** This is the one PII-adjacent
   thing we deliberately keep immutable — it's a legal artifact. It's also
   already just a signature (hash), not identifying data.
3. **Off-chain metadata is best-effort / additive.** The UI renders "Beneficiary 1
   (0xabc…)" gracefully when the API is down or a legacy has no metadata row.
4. **Permit2 is a hard requirement, not a nice-to-have.** The single-confirm
   UX doesn't work without it, because arbitrary ERC-20s don't support `permit`
   natively and we can't `transferFrom` without prior approval.
5. **GDPR right-to-delete must be honor-able on day one.** The metadata
   endpoint must support soft-delete with an audit trail. Any string field
   that can carry PII (bene name, bene email, watcher name, owner name, owner
   email, legacy name, legacy note) lives behind that endpoint or in an event
   log we intentionally keep minimal.
6. **Storage-layout safety.** Every change to `TransferEOALegacy` storage
   layout has to pass `hardhat-upgrades` layout checks. Clones share the
   implementation, so a bad layout change corrupts every legacy at once.
7. **No new trusted off-chain actors.** The metadata API auth model is an
   EIP-712 signature verified against the on-chain `legacy.creator()` — no
   admin keys, no backdoor writes. If `computing-admin`'s key is lost, the
   data is read-only and unharmed (still on-chain claimable).

### 4.1 Explicit non-goals

- **Not touching the claim path.** `activeLegacy` / `activeLegacyAndUnswap`
  stay byte-identical.
- **Not changing the activation-trigger / Chainlink-oracle path.**
  `PremiumAutomationManager`, `PremiumAutomation`, and the `checkUpkeep` /
  `performUpkeep` flow are left alone except for the one refactor in §8 (email
  worker reads from DB instead of on-chain strings).
- **Not touching MultisigLegacy beyond the PII-stripping event changes.**
  Safe-backed legacies have a different create flow (Safe's own mechanism) and
  don't need Permit2. Do them in a later release if needed.
- **Not shipping an encrypted IPFS alternative** for metadata. We discussed
  this in `DEFERRED.md`; for GDPR compliance we need the operator to be able
  to delete, which IPFS/immutable storage cannot do. Off-chain DB with
  operator-controlled lifecycle is the correct choice.

## 5. Smart-contract architecture changes (`computing-sc`)

### 5.1 `TransferEOALegacy` clone impl — what comes out

Concrete delete-list in `initialize()`:

- Parameter `string[] calldata nicknames` — removed.
- Parameter `string calldata nickname2` — removed.
- Parameter `string calldata nickname3` — removed.
- Removed calls to `_setBeneNickname(...)` inside `_setDistributions`,
  `_setLayer23Distributions`, and the top of `initialize`.
- Removed calls to `_deleteBeneName(...)` inside `_setLayer23Distributions` and
  `_clearDistributions`.
- Remove function `setLegacyName(...)` from `TransferEOALegacy`. Corresponding
  writes from the router disappear.
- `_setLegacyName` / `legacyName` storage on `GenericLegacy` are kept for
  backward compatibility with pre-v2 clones but no longer used by v2 clones.
  (Deleting the slot would break the storage layout — see §14.3.)
- `beneName` mapping similarly stays in storage (as a dead slot) for layout
  safety; it just never gets written to. See §14.3 for the layout
  justification.

Function count on the clone drops by 1 (`setLegacyName`) but no other external
functions change. Editing functions (`setLegacyDistributions`,
`setDelayAndLayer23Distributions`, etc.) have their `nicknames` parameters
removed too — but those are `onlyRouter`, so the router's ABI is the breakpoint,
not direct user interaction.

### 5.2 `TransferEOALegacyRouter` impl — what changes

New external call signature on `createLegacy`. Current:

```solidity
function createLegacy(
  LegacyMainConfig calldata mainConfig_,    // includes name + note + nickNames[] + distributions[]
  TransferLegacyStruct.LegacyExtraConfig calldata extraConfig_,
  TransferLegacyStruct.Distribution calldata layer2Distribution_,
  TransferLegacyStruct.Distribution calldata layer3Distribution_,
  string calldata nickName2,
  string calldata nickName3,
  uint256 signatureTimestamp,
  bytes calldata agreementSignature
) external returns (address);
```

Proposed v2:

```solidity
struct LegacyMainConfigV2 {
  // name / note / nicknames intentionally removed — move to metadata API
  TransferLegacyStruct.Distribution[] distributions;
}

struct Permit2CreateBundle {
  // Full Permit2 permit struct (see §6). Signed by msg.sender.
  // Empty (.permitted.length == 0) to opt-out of Permit2 on create
  // (caller is doing old-school approve beforehand). Supported for
  // transition but not the happy path.
  ISignatureTransfer.PermitBatchTransferFrom permit;
  ISignatureTransfer.SignatureTransferDetails[] transferDetails;
  bytes signature;
}

function createLegacyV2(
  LegacyMainConfigV2 calldata mainConfig_,
  TransferLegacyStruct.LegacyExtraConfig calldata extraConfig_,
  TransferLegacyStruct.Distribution calldata layer2Distribution_,
  TransferLegacyStruct.Distribution calldata layer3Distribution_,
  Permit2CreateBundle calldata permit2_,
  uint256 signatureTimestamp,
  bytes calldata agreementSignature
) external returns (address legacyAddress);
```

Noteworthy properties:

- `mainConfig_.name`, `.note`, `.nickNames` gone.
- `nickName2`, `nickName3` gone.
- `permit2_` is a structured field — if the user doesn't want to opt into
  Permit2 on create (e.g. because they're using the legacy-style approve+create
  path during the transition), they pass an empty bundle.
- `agreementSignature` stays — distinct from Permit2 signature. See §6.4 for why.
- The `TransferEOALegacyCreated` event similarly drops `mainConfig_` from its
  signature — we emit `(legacyId, legacyAddress, creator, distributions,
  extraConfig, timestamp)`. Subgraph picks this up and indexes
  `creator → legacy` edges without indexing PII.
- `createLegacy` (the old signature) is kept and internally forwards to
  `createLegacyV2` with empty Permit2 bundle + empty strings for nicknames.
  Pre-v2 frontends keep working; they just don't get the gas/UX wins. Marks
  it `@dev deprecated` in NatSpec and we remove it once we've migrated the
  frontend fully (target: release v2+1).

### 5.3 Storage-layout bump

`TransferEOALegacyRouter` gains new state:

```solidity
// v2 additions. New slots only — no reordering, no deletions.
ISignatureTransfer public permit2;
address public metadataRegistry;  // optional — see §7 for whether we register
                                  // legacy metadata on-chain or purely off-chain
```

These go at the end of existing storage. Existing slots untouched. A fresh
`reinitializer(5)` installs them. See §14.3 for the full layout diff and the
plan for verifying it doesn't collide with `initializeV2` / `initializeV3`
reinit counters.

Clones (`TransferEOALegacy`) don't get new state — they only lose semantic
usage of `beneName` + `legacyName` slots, which stay in layout.

### 5.4 Token-whitelist interaction

Today the `TokenWhiteList` contract gates which ERC-20s the router will accept
(see `TimelockRouter._executeEthSwapForToken`). For `TransferEOALegacy` the
whitelist isn't consulted at create-time — beneficiary allocations don't
reference specific tokens, they're just percentages. Tokens are discovered at
claim-time via the `assets_` array passed to `activeLegacy`.

Permit2 integration should:

- **Not** re-introduce a whitelist check at create-time. A beneficiary-percent
  legacy is token-agnostic by design; locking creators into our whitelist
  would be a regression.
- **Optionally** whitelist-gate the *Permit2-signed token pull* on claim-time
  later, if we decide the claim path should reject exotic tokens. This is
  orthogonal to v2 and can be its own follow-up entry in `DEFERRED.md`.

### 5.5 Timelock side

`TimelockRouter.createTimelock` already does `safeTransferFrom` directly from
the user, which requires a prior `approve(TimelockERC20Contract, …)` per
token. Permit2 applies here the same way:

- Add `createTimelockWithPermit2(TimelockRegular calldata, Permit2CreateBundle
  calldata)` — pulls tokens via `permitWitnessTransferFrom` instead of the
  user's approval.
- Keep the old function for back-compat.
- No name/email PII on the timelock side — the only string field is
  `TimelockRegular.name` (and `TimelockGift.giftName`, `TimelockGift.recipient`).
  Recipient is an address, not PII. `name` and `giftName` are arguably
  personal-ish but low-risk; we move them to event-only (drop the SSTORE) and
  let the subgraph index them. Emit as event field, don't store in
  `TimelockInfo.name`.
  - Storage-layout: we can't just delete `TimelockInfo.name` from the struct
    because `timelocks` is a mapping. If we want to really claw back that
    storage, we'd need to migrate and re-index all existing timelocks. Not
    worth it for a string that's rarely read after create. Option: leave the
    field in the struct but stop writing it (empty string). This costs one
    zero-slot write instead of a full SSTORE — ~5k gas instead of ~22k.

## 6. Permit2 integration — deep dive

### 6.1 Why Permit2

The problem the single-confirm flow needs to solve: we need to pull *arbitrary*
ERC-20s from the creator's wallet at claim time (not at create time — the
creator hasn't told the claim contract about specific tokens yet) *without*
requiring N separate `approve` transactions at create.

Options considered:

| Approach | Verdict |
|---|---|
| **EIP-2612 `permit`** (native ERC-20 permit) | Only ~15% of top ERC-20s implement `permit`. USDC does, USDT does not, most memecoins do not. Unreliable. |
| **Pre-approve + Multicall on a bespoke forwarder** | Requires the creator to approve our forwarder first, which is the same confirm the forwarder was supposed to avoid. |
| **Uniswap Permit2** | Works for any ERC-20 (pulls via `transferFrom` through Permit2's allowance manager). Canonical deployment at the same address on every chain. Extensively audited (Spearbit, ABDK, trails.bits). Battle-tested in Universal Router + 1inch + many others. **Winner.** |
| **ERC-4337 account abstraction / Smart accounts** | Solves this elegantly but forces users to migrate away from MetaMask/Ledger EOAs, which we explicitly support today. Not an option for v2 — could be a future Timelock/Legacy SDK path for smart-account users. |
| **EIP-5792 `wallet_sendCalls` alone (no Permit2)** | Lets us send multiple calls atomically from a single user confirmation — but each of those calls still requires the token contract to accept it, and for `approve` + `transferFrom` of an arbitrary ERC-20, EIP-5792 doesn't remove the need for an approval step; it just bundles. Combined with Permit2 though, EIP-5792 gives us **zero approval txs** with one user prompt. See §6.5. |

### 6.2 Canonical address + trust

Permit2 lives at `0x000000000022D473030F116dDEE9F6B43aC78BA3` on every EVM
chain we care about (mainnet, Sepolia, Arbitrum, Optimism, Base, Polygon,
Avalanche — deployed via CREATE2 from a singleton factory). We hardcode this
address in the router's initializer rather than making it configurable — there
is no legitimate reason for us to use a non-canonical Permit2 in production,
and a misconfigured Permit2 address is an apocalyptic bug (token-draining).

Verification before we ship:
- Confirm bytecode hash matches the canonical deployment (`keccak256` of the
  Permit2 runtime bytecode). Hardhat verification step.
- Confirm `DOMAIN_SEPARATOR` on the deployed Permit2 matches expected
  `chainId + address(permit2)`.
- Document the canonical address in `contract-addresses.json` alongside our
  other addresses.

### 6.3 Which Permit2 API do we use

Permit2 has two APIs:

- **`SignatureTransfer`** (aka "one-off / stateless" permits): each permit has
  a nonce that's consumed on use and must be presented with a signature on
  *every* call. No long-lived allowance state. Good for "I want to authorize
  exactly these pulls right now and nothing else."
- **`AllowanceTransfer`** (aka "managed allowances"): Permit2 holds a
  per-(owner, token, spender) allowance struct in storage and lets signed
  permits bump it. Good for "I want to keep this allowance alive across
  multiple pulls."

For create flow, **SignatureTransfer** is the right choice:
- The pulls at create time are token-balance-specific and we'd rather not leave
  lingering allowances.
- Each create is a fresh signature with a fresh deadline — no ambient approval
  to revoke later.
- Smaller gas footprint at call time (Permit2 doesn't have to load + update
  allowance state).

Specifically we want `permitWitnessTransferFrom` on the `PermitBatchTransferFrom`
variant, because (a) we want the witness mechanism to bind the signature to
the legacy's create parameters (so the signature can't be replayed to create a
*different* legacy with the same tokens), and (b) batching so one signature
covers all of the user's chosen tokens.

### 6.4 Witness — binding the Permit2 signature to the create intent

Permit2's witness mechanism lets us specify an extra `bytes32 witness` field
that the user's EIP-712 signature must commit to. We use it to bind the
signature to the exact legacy-create parameters:

```solidity
struct LegacyCreateWitness {
  address creator;
  // Claim-path-relevant on-chain fields only. PII stays out.
  TransferLegacyStruct.Distribution[] distributions;
  TransferLegacyStruct.Distribution layer2Distribution;
  TransferLegacyStruct.Distribution layer3Distribution;
  uint128 lackOfOutgoingTxRange;
  uint256 delayLayer2;
  uint256 delayLayer3;
  uint256 termsTimestamp;
  bytes32 termsSignatureHash; // keccak256 of the EIP-191 TOS signature
}

string constant WITNESS_TYPE_STRING =
  "LegacyCreateWitness witness)LegacyCreateWitness(address creator,"
  "Distribution[] distributions,Distribution layer2Distribution,"
  "Distribution layer3Distribution,uint128 lackOfOutgoingTxRange,"
  "uint256 delayLayer2,uint256 delayLayer3,uint256 termsTimestamp,"
  "bytes32 termsSignatureHash)Distribution(address user,uint256 percent)";

bytes32 witness = keccak256(abi.encode(
  LEGACY_CREATE_WITNESS_TYPEHASH,
  msg.sender,
  keccak256(abi.encodePacked(hashDistributions(mainConfig.distributions))),
  hashDistribution(layer2Distribution),
  hashDistribution(layer3Distribution),
  extraConfig.lackOfOutgoingTxRange,
  extraConfig.delayLayer2,
  extraConfig.delayLayer3,
  signatureTimestamp,
  keccak256(agreementSignature)
));

permit2.permitWitnessTransferFrom(
  permit2_.permit,
  permit2_.transferDetails,
  msg.sender,
  witness,
  WITNESS_TYPE_STRING,
  permit2_.signature
);
```

What this buys us:

- **No signature replay to a different legacy.** If an attacker intercepts the
  signed Permit2 payload and tries to use it to create a legacy with different
  beneficiaries, the witness hash doesn't match and Permit2 rejects.
- **Coupling of TOS signature and token approval.** We include
  `keccak256(agreementSignature)` inside the witness so the Permit2 signature
  is only valid if paired with the exact TOS signature the user also signed.
  This is what lets us safely fold the two into one user prompt via EIP-5792
  without losing the "user agreed to terms" audit trail — the TOS signature
  stays a first-class on-chain artifact stored by `EIP712LegacyVerifier`.
- **Frontend can't sneak different params past the user.** The wallet's
  transaction-preview shows beneficiary addresses + percentages; if a
  malicious frontend tries to swap those at submission time, Permit2 rejects.

### 6.5 Why we still need a separate TOS signature

Open question — can we remove the `storeLegacyAgreement` call entirely and rely
on Permit2's EIP-712 signature as the TOS signature?

Answer: **no, keep it separate.**

Reasons:

1. **Wording.** The TOS signature is over a specific human-readable message
   (`"By proceeding with creating a new contract, I agree to 10102's Terms of
   Service at timestamp X."`). A Permit2 signature is over structured-data that
   wallets render as "Authorize Permit2 to transfer N tokens." Those are
   different consents; conflating them is a legal accessibility problem (the
   user is signing a Permit2 hash and our audit log says they agreed to
   TOS — a defense lawyer has a point).
2. **Revocation.** The TOS signature is a *positive* record of consent we
   pre-reserve the ability to present in court. Permit2 signatures are
   consumed and we don't want to have to re-derive them from Permit2's
   internal nonce-bitmap state.
3. **Signature reuse cost.** The TOS signature is ~25k to store on-chain
   once. Folding the TOS hash into Permit2's witness (§6.4) keeps the
   pairing tight without needing to re-store the Permit2 sig itself.

So the model is: user signs the TOS message (EIP-191 personal_sign, free,
off-chain), then signs the Permit2 EIP-712 payload (which embeds the TOS
signature hash in its witness, also free / off-chain). Router's `createLegacyV2`
is the single on-chain tx that:

1. Calls `EIP712LegacyVerifier.storeLegacyAgreement` with the TOS signature.
2. Calls `permit2.permitWitnessTransferFrom` with the Permit2 signature + witness
   that includes the TOS signature hash. Permit2 pulls tokens from the user's
   wallet to the legacy address atomically.
3. Deploys the clone and runs `initialize()`.

On EIP-5792-capable wallets the two *signatures* (TOS + Permit2) can be
prompted in one wallet UI if the wallet supports grouped off-chain signatures
(most do, as ordered `personal_sign` + `eth_signTypedData_v4`). The *on-chain
tx* remains one call. So net: one wallet interaction for everything visible
to the user.

### 6.6 Replay / cross-chain safety

Permit2's `DOMAIN_SEPARATOR` includes `chainId + address(this)` so a
Permit2 signature is chain-specific by construction. No extra work needed.

For the TOS signature we already have `timestamp` ± 30 min offset bounds and
the `signatureUsed[signature]` mapping preventing reuse (`VerifierTerm.sol`,
lines 65–68).

For the Permit2 signature, nonce handling is Permit2's own nonce bitmap. No
action required from us.

### 6.7 Unlimited Permit2 approval — is it safe

First-time users approve Permit2 once with `type(uint256).max` allowance on
every ERC-20 they intend to ever use with it. This is the Permit2 standard
pattern and the ecosystem trust model. Upsides:

- Every future Permit2 user (Universal Router, us, 1inch, …) inherits that
  approval — user pays the approval cost once per token across the entire
  Permit2-using dapp ecosystem.
- The per-permit signature re-establishes the user's consent each time, so
  the unlimited allowance isn't a standing risk in the "granted to a single
  dapp forever" sense.

Risks and mitigations:

- If Permit2 itself is compromised (zero-day), any token approved to it across
  any chain is drainable. Mitigation: Permit2 is immutable + unownable + has
  no upgrade hatch + is used by >$X billion of weekly flow. Historical
  incident rate: zero as of writing. We accept this risk on par with using
  Uniswap itself.
- If our router's signature-consumption logic is buggy (e.g. we construct the
  wrong witness, accept signatures without verifying `msg.sender == permit
  signer`), an attacker with a *legitimate* Permit2 signature from a user
  might be able to redirect token pulls. Mitigation: the witness must be
  derived exclusively from `msg.sender` + the actual create parameters
  (§6.4), with no user-controlled path through it. Test with invariant +
  fuzz tests.
- Permit2 signatures are replayable until nonce is consumed. If a user signs
  a create, then the tx fails (reverts), the signature is *not* consumed —
  they can retry. But if the tx succeeds and then the user wants to
  "undo", they can't. Standard Ethereum semantics; not new.

## 7. Off-chain beneficiary metadata API

### 7.1 Home for the API

Options:
- **Extend `computing-admin`** (existing Next.js backend with a database + auth
  infrastructure).
- **New service `computing-api`.**

Recommendation: **extend `computing-admin`** for v2.

Rationale: `computing-admin` already has the DB layer and a deployment pipeline
with the right operational maturity (monitoring, auth middleware, backup
policies). Adding a `/legacies/:chainId/:address/metadata` endpoint is a
straight extension. Spinning up a new service adds ops surface area that
doesn't pay back until we have a reason to split (e.g. different SLAs,
different scaling profile). Revisit if metadata read volume grows to the
point it affects admin-dashboard latency.

### 7.2 Data model

```typescript
type Beneficiary = {
  address: `0x${string}`;     // checksummed EVM address, indexed
  layer: 1 | 2 | 3;
  name?: string;              // <= 64 chars
  email?: string;             // <= 256 chars, validated RFC-5322ish
};

type Watcher = {
  address: `0x${string}`;
  name?: string;
};

type LegacyMetadata = {
  chainId: number;
  legacyAddress: `0x${string}`;
  // Creator-asserted at write time. We verify against the on-chain legacy
  // contract's `creator()` on every write to prevent squatting.
  creator: `0x${string}`;

  legacyName?: string;
  legacyNote?: string;
  beneficiaries: Beneficiary[];
  watchers: Watcher[];

  ownerName?: string;   // for email reminder template rendering
  ownerEmail?: string;

  createdAt: string;
  updatedAt: string;
  deletedAt?: string;   // soft delete for GDPR; row retained for audit w/ nulled fields
  version: number;      // monotonic, incremented each write
};
```

Primary key: `(chainId, legacyAddress)`. Secondary index:
`creator` for "list my legacies' metadata."

### 7.3 Endpoints

```
PUT  /v1/legacies/:chainId/:address/metadata
GET  /v1/legacies/:chainId/:address/metadata
DELETE /v1/legacies/:chainId/:address/metadata        # GDPR soft-delete
GET  /v1/legacies/by-creator/:address                 # list all my legacies' metadata
POST /v1/legacies/migrate                             # one-time ETL bootstrap (§11)
```

Each write is authenticated by an EIP-712 signed envelope:

```typescript
// EIP-712 domain
{
  name: "10102 Computing Legacy — Metadata",
  version: "1",
  chainId: <target chain>,
  verifyingContract: <the target legacy address — so signature is scoped per-legacy>,
}

// Message
{
  action: "UPSERT" | "DELETE",
  payload: <the metadata object, or empty object for DELETE>,
  version: <current-version + 1>,
  issuedAt: <unix seconds>,
  validUntil: <unix seconds, max +5min>,
}
```

Server-side verification pipeline:
1. Recover signer from EIP-712 signature.
2. RPC call `legacy.creator()` — verify `signer == creator`.
3. Verify `issuedAt` window, `version` monotonicity, and the envelope action
   matches the route.
4. Apply the write inside a DB transaction.

### 7.4 GDPR / right-to-delete

`DELETE` is a **soft-delete**: the row is retained with all PII fields nulled
out, `deletedAt` set, `version` incremented, and an append-only `metadata_audit`
table records `{ chainId, legacyAddress, action, payload_hash, version,
timestamp }`. This satisfies the dual requirement of (a) being able to tell a
regulator "yes, we deleted" and (b) having an audit trail for our own sanity.

Hard-deletion (row-drop) is reserved for cases where we need to purge *even
the audit record*, which is rare and done manually by operators under
explicit legal guidance. Not an endpoint.

### 7.5 Caching + availability

- CDN (Cloudflare / Fastly) in front of `GET` with `Cache-Control: public,
  max-age=30`. Short TTL because metadata can change. Cache busts on write
  via a purge webhook triggered by the write path.
- The frontend treats a `GET` 404 or 5xx as "no metadata available" and
  renders the address-only view.
- SLO target: 99.5% for reads (two nines and a half is plenty for a
  display-only best-effort path). Not an SLO the protocol depends on.

### 7.6 Frontend integration

In `computing`:

- New `useLegacyMetadata(chainId, legacyAddress)` hook; merges with on-chain
  data from the subgraph.
- Create flow: two parallel requests at submit time — (a) the on-chain
  `createLegacyV2` tx, (b) the metadata `PUT`. If (a) succeeds and (b) fails,
  the legacy is still created and fully functional; we toast a
  "your beneficiary nicknames will appear after you retry saving" and the
  user can retry from the legacy detail page. The on-chain path is the source
  of truth for correctness; metadata is UX polish.

Importantly, the EIP-712 metadata signature uses `verifyingContract = legacyAddress`,
which is known at create time because CREATE2 lets us *compute* the legacy
address before deploying it (§2 in `architecture/legacy-contracts-created-with-eoas.md`).
So we can capture the metadata signature in the same user session before the
on-chain tx even lands. Nice property.

## 8. Email worker refactor

Today `PremiumSetting.triggerActivationTransferLegacy` reads emails from
`legacyCfgs[legacyAddress]` and passes them inline to `premiumSendMail` (which
is itself an on-chain interface — `IPremiumSendMail` on the premium contracts,
see `PremiumMailActivated.sol` etc.). Chainlink Automation calls
`performUpkeep` which eventually triggers `sendNotifyFromCronjob` which ends
up writing events + calling `premiumSendMail.sendMail*` functions.

The off-chain email delivery (actually sending the message via SendGrid or
similar) listens to `IPremiumSendMail`'s emitted events.

v2 plan:

1. Leave the Chainlink Automation + `checkUpkeep` / `performUpkeep` paths
   **structurally unchanged**. Those work on trigger timestamps, not PII, so
   they're unaffected by moving names/emails off-chain.
2. Change `PremiumSetting.triggerActivationTransferLegacy` +
   `triggerOwnerResetReminder` + `triggerActivationMultisig` so they **emit
   an event** (`LegacyEmailNotifyRequested(chainId, legacyAddress, creator,
   layerActivated, recipientAddresses, notifyType)`) instead of directly
   calling `premiumSendMail` with inline strings.
3. Replace the email worker with an off-chain service listening to
   `LegacyEmailNotifyRequested`, resolving emails from the DB (§7), and
   posting to SendGrid.
4. Deprecate `PremiumSetting.setReminderConfigs` / `updateLegacyConfig` /
   `updateUserConfig`. They stay in the ABI for pre-v2 legacies that have
   on-chain email rows, but the UI stops calling them for v2 legacies.
5. Eventually (release v2+2 or later) strip the whole `legacyCfgs` + `userConfigs`
   mappings from `PremiumSetting` in a separate migration-only release. Not
   in v2 — that's two storage-layout upgrades in a row and a migration to a
   pure-events-driven worker is already a big-enough lift.

Safety property: the email worker never has privileged access to cause funds
to move. Worst case if someone spoofs an event in the subgraph: users get
a spurious "hey someone claimed your legacy" email. Annoying, not
catastrophic. (But we also verify the event originated from a known contract
address — trivial for an indexed event.)

## 9. Subgraph changes (`computing-subgraph`)

- Drop `name` + `email` fields from the `Beneficiary` + `Watcher` entities.
- Drop `name` + `note` from the `Legacy` entity (or keep, depending on whether
  we want to migrate to a "legacy name comes from DB" model completely —
  see §11 for the ETL coexistence).
- Update event handlers to match the new event signatures
  (`TransferEOALegacyCreated` no longer carries `LegacyMainConfig`, etc.).
- Subgraph redeploy + reindex is required, coordinated with the on-chain
  deploy.

Indexing load should go **down** (shorter events, fewer string fields).

## 10. Frontend changes (`computing`)

### 10.1 Create flow

1. User fills the create form (beneficiaries, allocations, trigger, etc.).
2. On submit, frontend computes the predicted legacy address via
   `TransferEOALegacyRouter.getNextLegacyAddress(msg.sender)` (existing view
   call — supports the clone path already).
3. Frontend asks wallet for two off-chain signatures:
   - TOS message signature (existing).
   - Permit2 `permitWitnessTransferFrom` signature, with witness computed
     client-side exactly as the router will recompute it.
4. (Optional) Metadata signature (EIP-712 over the metadata blob,
   verifyingContract = predicted legacy address). Wallets can group this with
   the two above if the UI leans on EIP-5792's atomic-sign grouping; if not,
   it's a third silent prompt.
5. Frontend submits `TransferEOALegacyRouter.createLegacyV2(...)` with the
   Permit2 bundle + TOS signature.
6. On `createLegacyV2` success, frontend `PUT`s the metadata to
   `computing-admin` with the step-4 signature.
7. On metadata success, show "Legacy created." On metadata failure,
   show "Legacy created; nicknames will be added when you retry saving."
   (Non-blocking.)

### 10.2 Legacy detail / edit flows

- Reads merge on-chain (subgraph) + metadata (API).
- Edit to on-chain fields (allocations, trigger, layer distributions) goes
  through the existing `setLegacyConfig` / `setActivationTrigger` paths.
- Edit to metadata-only fields (nicknames, emails, note, legacy name) is a
  single API `PUT` with a fresh EIP-712 signature. No on-chain tx.
  **This is a major UX win** — nickname fixes become free + instantaneous.

### 10.3 Library choices

- Permit2 TS client: `@uniswap/permit2-sdk` (official, well-maintained).
- EIP-5792: `viem`'s `walletActionsEip5792` extension (stable in recent viem).
- No new state management — existing wagmi query cache handles everything.

## 11. Migration plan

### 11.1 Pre-cutover inventory

- List all live legacies on mainnet + Sepolia.
- Snapshot current on-chain `beneName` + `legacyName` + `PremiumSetting.legacyCfgs`
  for each.

### 11.2 ETL job

One-shot script (`scripts/migrate-metadata-to-api.ts` in `computing-sc`):

1. Enumerate all `TransferEOALegacyCreated` events via the subgraph.
2. For each legacy: call `getBeneNickname(bene)` for each bene, `getLegacyName()`,
   and `PremiumSetting.getBeneficiaryData / getUserData` for each owner.
3. Post to the v2 metadata API with a special "migration" envelope signed by
   an ops key (the API whitelists this key for `action: "MIGRATE"`, which
   only writes if no existing row).
4. Flag the legacy row as `migrated: true` with a `sourceVersion` pointer.
5. Report run completeness — count of legacies, count of successful migrations,
   count of failures, per-network.

Pre-cutover legacies' on-chain fields remain in storage; we stop *writing* to
them in v2 but old reads still return the value for legacies that were never
updated. The UI preferentially reads the DB; on DB-miss for a pre-cutover
legacy it falls back to the on-chain value.

### 11.3 Deploy sequence

1. Deploy new `TransferEOALegacyRouter` impl to Sepolia.
2. Proxy upgrade on Sepolia via `admin.upgradeAndCall(…, initializeV4(permit2Address, metadataRegistryAddress))`.
3. Deploy new `TransferEOALegacy` clone impl to Sepolia.
4. Register new clone impl via `router.setLegacyImplementation(newImpl)` — new
   Sepolia creates use v2 immediately. Existing Sepolia legacies still
   reference the *old* clone impl (they were created from the previous
   implementation address, by design of EIP-1167 — each clone is bound to
   its exact implementation). Those continue to work via the old code path.
5. Subgraph redeploy for Sepolia. Frontend (Sepolia) cutover behind a feature
   flag.
6. End-to-end tests: create v2, Permit2 pulls, claim, email-worker,
   off-chain metadata.
7. **Same sequence on mainnet**, coordinated with a subgraph cut window.
8. Artifact reconcile (§13 of DEFERRED) — this is automatic given the scripts
   are in place.

### 11.4 Back-compat contract for users mid-flight

- Old `createLegacy` → forwards to `createLegacyV2` with empty strings for
  nicknames.
- `setReminderConfigs` / `updateUserConfig` left callable (for pre-v2 users
  who still want their email in on-chain storage — though we'll discourage
  it in the UI).
- Pre-v2 legacies keep their on-chain strings forever. No back-fill attempt.

### 11.5 Subgraph reindex strategy

- Deploy new subgraph version alongside old; dual-read in the frontend for a
  week to validate.
- Old subgraph stays live at its endpoint to support any external integrators
  — they get a deprecation notice with a 90-day sunset.

## 12. Timelock parallel track

Lower priority since Timelock creates are already simpler (no beneficiaries
with names):

- Add `createTimelockWithPermit2` variants for Regular / Soft / Gift.
- Move `TimelockInfo.name` + `TimelockGift.giftName` writes to event-only (keep
  the struct fields to preserve storage layout, just stop SSTORE-ing).
- Recipient address stays on-chain (it's load-bearing for the Gift claim path).
- Decide whether timelock names deserve an off-chain API row. Lean: yes, same
  table as legacy metadata, different `kind` discriminator.

Can ship with or behind legacies. If we ship together, the release message
becomes "Create-flow v2 for legacies + timelocks".

## 13. Audit + test strategy

### 13.1 Unit + integration tests

- Full property coverage on Permit2 witness construction — given a set of
  create inputs, the witness the contract computes must match the witness
  the frontend computes. One test per field combination.
- Witness mutation tests: flip a bit in any witness field, signature must
  reject.
- Permit2 nonce / deadline edge cases.
- `createLegacyV2` with empty Permit2 bundle must behave identically to
  `createLegacy` post-forward. Back-compat safety.
- Off-chain metadata signature — valid signer passes, non-creator fails,
  expired envelope fails, replay of prior version fails.

### 13.2 Fork tests (Foundry or Hardhat)

- Fork mainnet at current head. Call `createLegacyV2` with a real Permit2
  signature. Verify token pulls happened. Verify storage layout of the
  upgraded proxy.
- Fork Sepolia, same.
- Run through the full migration script on a fork before running it for real.

### 13.3 Fuzz + invariant tests

- Invariant: no code path can create a legacy where `creator` differs from
  `msg.sender`.
- Invariant: `beneName` mapping is never written in v2 init. (Catches layout
  regressions where a v2 code accidentally re-enables the old writes.)
- Fuzz: random `Distribution[]` arrays with random addresses and percents;
  only passes when percents sum to `MAX_PERCENT`.

### 13.4 Storage-layout regression

- Snapshot storage layout pre-upgrade via `hardhat-upgrades validateUpgrade`.
- Fail CI if layout changes aren't append-only.
- Include the snapshot file in the commit for easy diff review.

### 13.5 External audit

Strongly recommend a contract-focused audit (Spearbit / Zellic / Trail of
Bits) for v2, because:
- Permit2 is a new attack surface.
- A bug in `createLegacyV2` affects every future legacy (vs. the EIP-1167
  refactor which was "just" a deployment path change).
- Upgrade path + migration script are themselves audit targets.

Budget: 2-week audit window after code-freeze, 1 week for fixes + re-review.
Target firm engagement 4 weeks before mainnet deploy.

## 14. Security considerations

### 14.1 Permit2 misuse

- ✅ Use canonical Permit2 address (hardcoded, documented, verified).
- ✅ Validate `msg.sender == permit.owner` — the router only accepts Permit2
  signatures from the same EOA calling `createLegacyV2`. Prevents a
  griefer from submitting someone else's signed Permit2 to create a legacy
  where the griefer is the "creator" while the victim's tokens get pulled.
  (Also: `creator = msg.sender` is hard-wired in `_setLegacyInfo`.)
- ✅ Witness must be computed from `msg.sender`, never from a user-provided
  field that the sender could manipulate without re-signing.
- ✅ Deadline enforced server-side by Permit2. We *also* enforce our own
  deadline for the TOS signature (±30min). Two independent time bounds.
- ❌ Don't support `AllowanceTransfer` in this release. SignatureTransfer
  is the lowest-surface choice.
- ❌ Don't allow arbitrary `recipient` in transferDetails — our code hard-
  wires `recipient = legacyAddress` (the predicted CREATE2 address) for the
  create-time pulls. Prevents exfiltration.

### 14.2 Terms-of-service signature handling

- Keep `EIP712LegacyVerifier.storeLegacyAgreement` semantics unchanged.
- Additionally, include `keccak256(agreementSignature)` in the Permit2 witness
  (§6.4). This binds the two signatures such that the Permit2 pull only works
  if the TOS signature is the exact one the user also agreed to.

### 14.3 Storage layout

Current `TransferEOALegacyRouter` layout (approximate, annotate at impl time):

| Slot | Source | Field |
|---|---|---|
| 0 | `OZ Initializable` | `_initialized` + `_initializing` (packed) |
| 1 | `LegacyRouter` | (existing — verify against actual contract) |
| … | `EOALegacyFactory` | `_legacyId`, `legacyDeployerContract`, `legacyAddresses` (mapping), `isCreateLegacy` (mapping) |
| … | router's own | `premiumSetting`, `verifier`, `paymentContract`, `uniswapRouter`, `weth`, `legacyCreationCode`, `_codeAdmin` |
| last | router's own (EIP-1167 add) | `legacyImplementation` |

v2 appends:
- `ISignatureTransfer permit2;`
- `address metadataRegistry;` (optional, see §7 — may be empty for v2 if we
  don't need on-chain coordination)

**Gap reserve**: add a `uint256[48] __gap;` at the end after v2 additions to
give us room for future additions without layout juggling. (We didn't use gaps
pre-v2 — it's not too late to add one at the end, as long as we don't insert
in the middle.)

`TransferEOALegacy` (clone impl) storage:
- `GenericLegacy` inherited slots (`_legacyId`, `_owner`, `_isActive`,
  `_lackOfOutgoingTxRange`, `router`, `legacyName`, `beneName` mapping).
- Clone-specific: `adminFeePercent`, `paymentContract`, `uniswapRouter`,
  `weth`, `_lastTimestamp`, `_isLive`, `_beneficiariesSet`, `_distributions`
  mapping, `_layer2Beneficiary`, `_layer2Distribution`, `_layer3Beneficiary`,
  `_layer3Distribution`, `delayLayer2`, `delayLayer3`, `premiumSetting`,
  `creator`, `eoaStorageToken`.

v2 changes: **no layout changes** on the clone. We stop *writing* to
`legacyName` and `beneName` but the slots stay reserved forever. New clones
still have those slots empty.

**IMPORTANT**: Before merging v2, run `hardhat-upgrades validateUpgrade`
comparing the v1 Router impl (mainnet bytecode) vs the v2 Router impl. Must
report `compatible` — no slot reordering, no deletions, only appends.

### 14.4 Reinitializer sequencing

`TransferEOALegacyRouter` has `initialize` (= v1), `initializeV2(codeAdmin)`
(= v2), `initializeV3(codeAdmin)` (= v3, for proxies whose counter advanced
past v2 via the EIP-1167 re-init cycle).

v2 adds `initializeV4(permit2, metadataRegistry)` with `reinitializer(5)`.
Caveat: the reinit counter must be advanced exactly to 5 on both mainnet and
Sepolia. On mainnet, post-EIP-1167 upgrade the counter should be at 4 (we
called `initializeV3` during that rotation). On Sepolia, it's at 3 (we called
`initializeV2` pre-EIP-1167 and never needed `initializeV3`). Check with
`provider.getStorageAt(router, <initializable slot>)` before the upgrade so
we know which reinitializer to run.

If counters differ, we ship **two** new reinit functions
(`initializeV4(…)` with `reinitializer(4)` for Sepolia and
`initializeV5(…)` with `reinitializer(5)` for mainnet) — we've already done
this pattern for `initializeV2`/`initializeV3`.

### 14.5 Clone init front-running

`EOALegacyFactory._cloneLegacy` deploys via `CREATE2` and returns the address;
`createLegacyV2` then calls `initialize` on it in the same transaction. Since
the address is determined at the `CREATE2` call (same tx), no window exists
for an outsider to front-run the init. Same property as the pre-v2 code — no
new risk.

The `notInitialized` modifier (`GenericLegacy.sol` line 41) defends against
accidental double-init regardless.

### 14.6 Metadata API trust boundary

- API can only accept writes signed by the current on-chain `legacy.creator()`.
- If we change `creator` logic in a future release (not planned), the API
  must read `creator()` at write time — not cache it. Our schema does that.
- If the creator's private key is lost, they can no longer update metadata,
  but the legacy is still claimable on-chain (this is a feature of separating
  the axes).
- DoS risk: spam writes. Rate-limit per source IP + per creator address.
  Already part of `computing-admin`'s existing middleware.

### 14.7 Chain-ID safety for all signatures

- Permit2: chain-id baked into its domain separator. ✅
- TOS signature: not chain-bound in the current implementation. Verify this
  is acceptable — a TOS signature is a consent record and reuse across chains
  is arguably *correct* (the user really did agree to TOS). Worst case,
  chain-bind the TOS signature too in a future cleanup.
- Metadata API envelope: chain-id included in EIP-712 domain. ✅

### 14.8 Subgraph / event-based trust

- `LegacyEmailNotifyRequested` events carry data that the off-chain email
  worker trusts. The worker must verify:
  - Event came from the known `PremiumSetting` address.
  - `creator` + `legacyAddress` referenced in the event match the DB row.
  - The email being sent matches the currently-stored DB email (prevents
    "send email to old address after user updated").

### 14.9 Checklist before mainnet

- [ ] External audit complete with all findings triaged.
- [ ] Storage-layout validation passes on both Sepolia and mainnet proxy
      bytecode vs v2 impl.
- [ ] Permit2 witness golden-master tests: frontend computes == contract
      computes, for 50+ distinct create input combinations.
- [ ] Fork mainnet at a recent block and execute a full v2 create + claim.
- [ ] Metadata API deploy tested with the ETL dry-run.
- [ ] Subgraph v2 dual-read for 72 hours without divergence.
- [ ] Contract creation-code and runtime bytecode verified on Etherscan
      (Sourcify + Etherscan V2 API) — with solc-upgrade considered, see
      `solc-upgrade.md` as a potential concurrent track.

## 15. Rollback plan

On-chain rollback options are ugly (as always with upgradeable proxies):

- **No tokens touched, just create path broken** — pause the router by calling
  `setLegacyImplementation(address(0))` (existing code-admin path). Downgrade
  router proxy to v1 impl. Users fall back to old `createLegacy`.
- **Permit2 pulls going to wrong address** — this is the catastrophic case.
  Pause immediately, audit, communicate. The SignatureTransfer path means no
  lingering allowance state remains, but any completed malicious pulls are
  irreversible (as always). Tests before mainnet must make this path
  provably safe.
- **Metadata API corruption / outage** — not a rollback, just operate with
  the DB degraded and fix forward. Claims unaffected.

The upgrade path uses `upgradeAndCall` so the impl swap + reinit are atomic.
No window for a half-initialized state.

## 16. Deployment timeline (rough)

| Week | Activity |
|---|---|
| 1 | Detailed impl: Router V4, clone V2, migration script, API endpoint |
| 2 | Test coverage (unit + fork + fuzz), subgraph v2 alongside |
| 3 | Code freeze → external audit starts |
| 4 | Audit week 1 |
| 5 | Audit week 2 + fixes week 1 |
| 6 | Fixes week 2 + re-review |
| 7 | Sepolia deploy, E2E testing, bug-bash |
| 8 | Mainnet deploy + ETL + subgraph cutover |

Total: ~2 months from greenlight to mainnet. Plan accordingly.

## 17. Open questions

1. **Do we chain-bind the TOS signature?** Pro: prevents cross-chain replay of
   TOS. Con: breaks the "signature is a pure consent record" framing. Lean:
   chain-bind it as a nice-to-have cleanup; not blocking.
2. **Keep `legacyName` on-chain as event-only or off-chain entirely?** Events
   are ~15k gas per field vs ~40k SSTORE. Lean: event-only. Names appear in
   the subgraph as before; if the frontend ever wants to render a name
   without the API, it can read from the subgraph. But then the name is still
   publicly immutable — not a GDPR win. So: **off-chain entirely**; no event
   field either.
3. **`PremiumSetting` deprecation window.** Hard-delete `legacyCfgs` +
   `userConfigs` mappings in v2? Or keep them alive for 6 months as a
   deprecated path? Lean: keep alive for v2, delete in v2+2 after the off-
   chain flow is proven.
4. **Do we need a `metadataRegistry` on-chain contract?** A small on-chain
   registry that records "metadata URL for legacy X = URL" would make us
   censorship-resistant against our own DNS/hosting going away. Lean: not for
   v2. If we lose our domain, the legacies still work; the names just disappear.
   Overengineering for a UX feature.
5. **Should v2 strip the `note` field from `TransferEOALegacyCreated` event?**
   Today it's emitted as part of `LegacyMainConfig`. Yes, strip — move to API.
6. **EIP-5792 wallet support matrix at ship time.** Need to verify MetaMask /
   Rabby / Coinbase Wallet / WalletConnect / Safe support grouped
   signatures with a good UX. If matrix is too thin, we ship with two
   sequential prompts and plan to enable the grouped path later.
7. **Bundle with Timelock's Permit2 integration (§12) or ship separately?**
   Lean: bundle. One audit + deploy cycle for both.

## 18. References

- [ERC-1167: Minimal Proxy Contract](https://eips.ethereum.org/EIPS/eip-1167)
- [Uniswap Permit2 GitHub](https://github.com/Uniswap/permit2)
- [Permit2 audits](https://github.com/Uniswap/permit2/tree/main/audits) —
  Spearbit, ABDK, Trail of Bits
- [EIP-2612: ERC-20 Permit](https://eips.ethereum.org/EIPS/eip-2612) (why not this)
- [EIP-712: Typed structured data hashing and signing](https://eips.ethereum.org/EIPS/eip-712)
- [EIP-5792: Wallet Send Calls API](https://eips.ethereum.org/EIPS/eip-5792)
- [EIP-191: Signed Data Standard](https://eips.ethereum.org/EIPS/eip-191)
- [OpenZeppelin upgradeable patterns](https://docs.openzeppelin.com/upgrades-plugins/1.x/)
- Internal: `docs/plans/solc-upgrade.md`,
  `architecture/legacy-contracts-created-with-eoas.md`
  (in `computing-docs` — specifically the CREATE2 + EIP-1167 section).

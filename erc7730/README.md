# ERC-7730 clear-signing descriptors

`registry/10102/` is the exact folder in the
[ERC-7730 registry](https://github.com/ethereum/clear-signing-erc7730-registry)
(moved from LedgerHQ to the `ethereum` org in 2026; consumed by Ledger,
MetaMask, Trezor and other wallets). With it, a signer sees "Create legacy",
"Check in", "Seal gift" and the beneficiaries, shares, durations and amounts
instead of raw calldata. Merged 2026-10-26 in
[PR #3110](https://github.com/ethereum/clear-signing-erc7730-registry/pull/3110)
after a human review of every field; any later change goes in as a new PR
from the `10102-labs` fork, and a contract upgrade that changes a selector
needs one before wallets show it.

| Descriptor | Contract (mainnet) | Functions |
|---|---|---|
| `calldata-TransferEOALegacyRouter.json` | `0x4E81E1Ed…6275b` (proxy) | create (v2, and v2 with a claim fee bound, which the app sends since 2026-11-07), check-in, edits, auto-renew, gas-free claims switch, ETH conversion, withdraw, delete, release for a new create, claim |
| `calldata-TimeLockRouter.json` | `0x2B947E3c…76A42` (proxy) | create (regular, soft, gift), soft unlock, withdraw |
| `calldata-ShieldVault.json` | `0xA1EA2F8C…76C38` (Shield Vault v2; deposits paused since 2026-11-11, exits work) | open, deposit, check-in, withdrawal request, cancel, execute, release, change, veto, held-share claim |
| `calldata-ShieldVaultV3.json` | `0x1610DC8D…1EB59` (Shield Vault v3; every new holding since 2026-11-11) | the same ten functions as v2, worded for v3's fee: only a release to the beneficiaries takes one |

In the registry on 2026-11-13: the first three, as merged in #3110. Submitted
the same day and waiting for a maintainer's review:

- [PR #3147](https://github.com/ethereum/clear-signing-erc7730-registry/pull/3147)
  (branch `10102-followup` of the `10102-labs` fork; open since
  2026-10-26): held shares and who renews a legacy, and since 2026-11-13
  the legacy router's two new formats, `createLegacyV2WithMaxFee` and
  `releaseCreateFlag`. The app's create calls `createLegacyV2WithMaxFee`
  since 2026-11-07, so until this is merged a hardware wallet shows a
  legacy create as raw data;
- [PR #3223](https://github.com/ethereum/clear-signing-erc7730-registry/pull/3223)
  (branch `10102-shield-vault-v3`): the Shield Vault v3 descriptor. Until it
  is merged, a hardware wallet shows a v3 call as raw data.

Not described on purpose: owner and upgrade functions (signed by the
governance Safe), relayer-only entry points (`*For`, `*WithSig`), the v1
`createLegacy`, the timelock `*WithPermit2` variants the app does not
send, the routers' `invalidateSponsorNonce()` (it voids the caller's own
unsent gas-free signatures and nothing else, takes no argument, and the
app never sends it), and the vaults' `collectFees` (anyone may call it, it
pays the fee recipient, and the app never sends it). The EIP-712 messages
behind gas-free check-ins and claims are a possible follow-up.

## Regenerating

Format keys are built from the Sourcify ABIs of the deployed contracts, so
a selector cannot be mistyped. The routers are proxies: `fetch-abis.mjs`
names an implementation, and the descriptor names the proxy. For the legacy
router it names `0x8F897128…974eb`, the implementation the timelock
installs on 2026-11-13; its ABI is the same, fragment for fragment, as that
of `0xe3d1bc20…706A1`, live since 2026-11-07, so the descriptor holds
before and after that upgrade. For the timelock router it still names the
implementation of the October submission: the functions described are
unchanged in the live one (the linter checks the descriptor against the
live implementation), and the next change to that descriptor moves it.
After an implementation upgrade:

```bash
cd erc7730/tooling
node fetch-abis.mjs        # refresh abis/ from Sourcify (update addresses first)
node build.mjs             # writes out/registry/10102 (descriptors + testsv2)
```

`fetch-abis.mjs` and `accept.mjs` take contract names
(`node fetch-abis.mjs ShieldVaultV3`), so adding one contract leaves the
reviewed ABIs and expectations of the others untouched. `fetch-abis.mjs`
stops when a contract is not an exact match on Sourcify.

Then, in a checkout of the registry, replace `registry/10102` with
`out/registry/10102` and run what CI runs:

```bash
pip install -r .github/requirements.txt -r .github/requirements-schema.txt   # erc7730 linter, check-jsonschema; Python 3.12+
npm ci                                           # the coverage and index scripts need viem
erc7730 format registry/10102                    # registry formatting (LF line endings)
erc7730 lint --require-verified registry/10102/calldata-*.json   # only "Missing display format" for admin functions is expected
node .github/scripts/check-selector-coverage.js registry/10102
.github/scripts/validate-json-schemas.sh registry/10102/*.json registry/10102/testsv2/*.json
node tools/scripts/generate-index.js --validate  # no (chain, address) is claimed by two descriptors
# Sourcify runner, pinned in .github/actions/run-sourcify-tests/action.yml
node <clear-signing-test-runner>/dist/cli.js registry/10102/testsv2/calldata-<Name>.tests.json --output results/<Name>.json
# Rust runner, pinned in .github/actions/run-rust-tests/action.yml (CI runs both)
cs-test run registry/10102/testsv2/calldata-<Name>.tests.json --registry registry --output results-rust/<Name>.json
```

The linter and both runners are pinned by commit in the registry and the
pins move: install the commits that the registry's `master` names, not the
ones from the last submission.

A new or changed case has no expectation yet: review the runner's rendering,
copy `results/*.json` into `tooling/results/`, run `node accept.mjs` to record
it in `tooling/expected/`, rebuild, and copy the formatted folder back here.
`build.mjs` fails on a label over 20 or an intent over 30 characters.

On Windows: `erc7730 format` writes CRLF, so convert to LF when copying back;
the schema script needs Git Bash, a `jq.exe` on its path (Git for Windows
ships none), and a `python3` that prints `/` paths (Windows Python prints
`\`, which the script reports as a bad `$schema`). The Rust runner builds
without admin rights with rustup's `x86_64-pc-windows-gnullvm` toolchain and
an unpacked llvm-mingw on the path (with the plain `gnu` toolchain the
build stops at `dlltool`).

## Notes on the rendering

- Durations use the spec's `duration` format (HH:MM:ss, so 180 days shows
  as `4320:00:00`); wallets may render it more readably.
- Lists whose entries belong together (beneficiary and share, permitted token,
  amount and expiry, NFT collection, id and quantity) are `iteration:
  "bundled"` groups, so each entry is shown as one block.
- A backup's `percent` is a switch in the legacy: 0 removes the backup even
  when an address is given, any other value gives it 100% of its layer. So
  "Backup share" is always shown, as an enum of the two values the app sends
  ("None", "100%"); any other value renders raw. Empty backup addresses, zero
  delays and unused ETH fields stay hidden with `visible: { ifNotIn: [...] }`
  on creates; on `setLegacyConfig` the first backup address stays visible.
  The single-backup setters reject a zero address.
- The two legacy creates show the same screens, in the same order.
  `createLegacyV2WithMaxFee` adds "Maximum claim fee" after the legacy's
  own settings: the highest claim fee rate the creator accepts, shown as a
  percentage (the argument is in basis points). Nothing is paid at the
  create. The new legacy stores the rate `Payment` gives at that moment,
  for good, and the create reverts when that rate is above the bound; the
  stored rate is taken from what is claimed, at each claim, for `Payment`.
  The app passes the fee it showed, and 0 when it showed none. A new legacy
  refuses a rate above 0.5% whatever the bound.
- `releaseCreateFlag` ("Allow creating a new legacy") names the legacy
  that ended as "Ended legacy": it reverts while that legacy is live and
  for anyone but its owner, and it changes only the router's mark that the
  wallet already has a legacy.
- Beneficiaries and recipients have no address `types`: they may be
  contracts (a Safe), and `wallet` would mean the signer's own account.
- WETH is wrapped 1:1 and ignores the swap minimum (and, on the legacy, the
  deadline), hence "Swap min (not WETH)".
- Timelock ERC-20 amounts are what leaves the wallet; the lock records what
  arrives, which is less for a fee-on-transfer token ("Token sent to lock").
- Shield Vault withdrawals and deposits do not carry the token, so the amount
  is shown in base units; `type(uint256).max` means "everything". The
  recovery sheet index is shown raw, and its maximum (`NO_VETO`) means no
  recovery; a zero silence period means no fallback. This holds for v2 and
  v3.
- Shield Vault v2 and v3 have the same ABI, selector for selector, and
  still have a descriptor each, because the fee differs and a second
  deployment on v2's descriptor would tell a v3 signer of a fee that is
  never taken. Neither states the rate, which is fixed per holding when it
  opens.
  - v2 takes the fee from a completed withdrawal and from a release to the
    beneficiaries. Its withdrawal amount is labelled "Before fee" (the
    recipient gets it minus the fee), its withdrawal, completion and
    release intents say a fee is taken, and the bound a signer sets at
    opening is the "Maximum exit fee".
  - v3 takes the fee only from a release to the beneficiaries after the
    owner's silence (`executeFallback`). Its withdrawal amount is labelled
    "Amount" (the recipient gets all of it), its withdrawal and completion
    intents name no fee, the release intent still does, and the bound is
    the "Maximum release fee".
  - In both, a completed settings change, a recovery (veto) and a
    held-share claim pay no fee.
- Labels stay within 20 characters and intents within 30 so Ledger screens
  do not truncate them.

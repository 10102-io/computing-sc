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
| `calldata-TransferEOALegacyRouter.json` | `0x4E81E1Ed…6275b` (proxy) | create (v2), check-in, edits, auto-renew, gas-free claims switch, ETH conversion, withdraw, delete, claim |
| `calldata-TimeLockRouter.json` | `0x2B947E3c…76A42` (proxy) | create (regular, soft, gift), soft unlock, withdraw |
| `calldata-ShieldVault.json` | `0xA1EA2F8C…76C38` | open, deposit, check-in, withdrawal request, cancel, execute, release, change, veto, held-share claim |

Not described on purpose: owner and upgrade functions (signed by the
governance Safe), relayer-only entry points (`*For`, `*WithSig`), the v1
`createLegacy`, and the timelock `*WithPermit2` variants the app does not
send. The EIP-712 messages behind gas-free check-ins and claims are a
possible follow-up.

## Regenerating

Format keys are built from the Sourcify ABIs of the live implementations, so
a selector cannot be mistyped. After an implementation upgrade:

```bash
cd erc7730/tooling
node fetch-abis.mjs        # refresh abis/ from Sourcify (update addresses first)
node build.mjs             # writes out/registry/10102 (descriptors + testsv2)
```

Then, in a checkout of the registry, replace `registry/10102` with
`out/registry/10102` and run what CI runs:

```bash
pip install -r .github/requirements.txt -r .github/requirements-schema.txt   # erc7730 linter, check-jsonschema; Python 3.12+
npm ci                                           # the coverage script needs viem
erc7730 format registry/10102                    # registry formatting (LF line endings)
erc7730 lint --require-verified registry/10102/calldata-*.json   # only "Missing display format" for admin functions is expected
node .github/scripts/check-selector-coverage.js registry/10102
.github/scripts/validate-json-schemas.sh registry/10102/*.json registry/10102/testsv2/*.json
# Sourcify runner, pinned in .github/actions/run-sourcify-tests/action.yml
node <clear-signing-test-runner>/dist/cli.js registry/10102/testsv2/calldata-<Name>.tests.json --output results/<Name>.json
```

A new or changed case has no expectation yet: review the runner's rendering,
copy `results/*.json` into `tooling/results/`, run `node accept.mjs` to record
it in `tooling/expected/`, rebuild, and copy the formatted folder back here.
`build.mjs` fails on a label over 20 or an intent over 30 characters.

On Windows: `erc7730 format` writes CRLF, so convert to LF when copying back;
the schema script needs Git Bash with `jq`, and a `python3` that prints `/`
paths (Windows Python prints `\`, which the script reports as a bad
`$schema`).

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
- Beneficiaries and recipients have no address `types`: they may be
  contracts (a Safe), and `wallet` would mean the signer's own account.
- WETH is wrapped 1:1 and ignores the swap minimum (and, on the legacy, the
  deadline), hence "Swap min (not WETH)".
- Timelock ERC-20 amounts are what leaves the wallet; the lock records what
  arrives, which is less for a fee-on-transfer token ("Token sent to lock").
- Shield Vault withdrawals and deposits do not carry the token, so the amount
  is shown in base units; `type(uint256).max` means "everything". A
  withdrawal's amount is labelled "Before fee": the recipient gets it minus
  the holding's exit fee. The recovery
  sheet index is shown raw, and its maximum (`NO_VETO`) means no recovery; a
  zero silence period means no fallback. Withdrawal, completion and fallback
  intents say a fee is taken without stating the rate, which is fixed per
  holding when it opens (bounded by "Maximum exit fee"). A completed settings
  change pays no fee.
- Labels stay within 20 characters and intents within 30 so Ledger screens
  do not truncate them.

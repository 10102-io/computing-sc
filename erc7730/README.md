# ERC-7730 clear-signing descriptors

`registry/10102/` is the exact folder submitted to the
[ERC-7730 registry](https://github.com/ethereum/clear-signing-erc7730-registry)
(moved from LedgerHQ to the `ethereum` org in 2026; consumed by Ledger,
MetaMask, Trezor and other wallets). With it, a signer sees "Create legacy",
"Check in", "Seal gift" and the beneficiaries, shares, durations and amounts
instead of raw calldata.

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
pip install -r .github/requirements.txt          # erc7730 linter, Python 3.12+
erc7730 format registry/10102                    # registry formatting (LF line endings)
erc7730 lint registry/10102/calldata-*.json      # only "Missing display format" for admin functions is expected
node .github/scripts/check-selector-coverage.js registry/10102
.github/scripts/validate-json-schemas.sh registry/10102/*.json registry/10102/testsv2/*.json
# Sourcify runner, pinned in .github/actions/run-sourcify-tests/action.yml
node <clear-signing-test-runner>/dist/cli.js registry/10102/testsv2/calldata-<Name>.tests.json --output results/<Name>.json
```

A new or changed case has no expectation yet: review the runner's rendering,
copy `results/*.json` into `tooling/results/`, run `node accept.mjs` to record
it in `tooling/expected/`, rebuild, and copy the formatted folder back here.

## Notes on the rendering

- Durations use the spec's `duration` format (HH:MM:ss, so 180 days shows
  as `4320:00:00`); wallets may render it more readably.
- Empty backups, zero delays and unused ETH fields are hidden with
  `visible: { ifNotIn: [...] }` on creates. On the backup-only edits a zero
  address stays visible, because there it means "remove this backup".
- Shield Vault withdrawals and deposits do not carry the token, so the amount
  is shown in base units; `type(uint256).max` means "everything".
- Labels stay within 20 characters and intents within 30 so Ledger screens
  do not truncate them.

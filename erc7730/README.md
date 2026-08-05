# ERC-7730 clear-signing descriptors

Draft descriptors for the
[ERC-7730 clear-signing registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry)
(EF-stewarded; consumed by MetaMask, Ledger, and Trezor for rendering
named, human-readable transaction screens instead of raw calldata).

Context: the create flow's Permit2 batch names the immutable
`LegacyPullVault` (`0x95F0981026C7e804fD6ba8bE738cA7c380C7f978`,
mainnet) as spender. Wallets that adopt these descriptors render
"Grant the 10102 LegacyPullVault permission…" instead of hex, which is
the designed end state of the 2026-07-28 wallet-warning decision
(`computing/docs/DEFERRED.md`).

Status: **draft, not yet submitted upstream**. Before opening the
registry PR:

1. Validate against the registry's JSON schema and lint
   (`erc7730 lint` from the registry tooling).
2. Confirm the exact canonical function-signature keys against the
   deployed ABI (the tuple encodings below were hand-derived).
3. Follow the registry's `registry/<owner>/` folder conventions.

Field-format notes live inline in the descriptor JSON.

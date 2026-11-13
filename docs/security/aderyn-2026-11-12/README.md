# Aderyn: the last reports (2026-11-12)

Aderyn 0.6.8 ran in CI beside Slither from 2026-10-29. Its maintainer
(Cyfrin) retired it on 2026-11-13 and withdrew the release downloads, so it
can no longer be installed and CI runs Slither alone since that day.

These are the reports of its last run, the security workflow of commit
`8e32e70` (2026-11-12 22:16 UTC), unedited. No contract source has changed
between that commit and the day the tool was retired, so they describe the
contracts as deployed:

- `aderyn-report.md`: ShieldVault v2, ShieldVault v3 and
  QuantumRecoveryRegistry. 0 High, 5 Low. This run was a gate: a High would
  have failed the job.
- `aderyn-v3-report.md`: legacy v3, NftCollectionWhiteList and
  LegacyPullVaultV2, report only.

Every result is triaged in `../static-analysis.md`. A later contract change
is not covered by these files: it gets Slither, and a second analyser if one
is chosen (`../static-analysis.md`, "Aderyn retired").

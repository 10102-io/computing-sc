# scripts/_archive

One-shot scripts that have already done their job, kept here for
forensic / audit reference rather than active use.

## When to move a script here

Move a script into this folder once **all** of the following are true:

- The script targets a single network and a single point-in-time
  on-chain state (an incident, a one-time migration, a one-time
  diagnostic against a now-defunct contract, etc.).
- The script is unlikely to be reusable as-is on a different network,
  contract version, or a future similar incident.
- The work the script performed has been documented in
  `deployments/CHANGELOG.md` (or a Sentry / runbook entry).

Generic, network-aware, reusable scripts (probes, preflights, upgrade
helpers parameterised by deploy artifact) **stay under `scripts/`**.

## Rules

- **Never delete archived scripts** without an explicit decision; they
  are forensic evidence of what was done on chain and when.
- Don't import from archived scripts in active code.
- If you find yourself wanting to "tweak and re-run" an archived
  script, that's a signal it shouldn't have been archived — pull it
  back into `scripts/` and parameterise it instead.

## Naming

If multiple scripts relate to the same incident, prefix them with the
ISO date, e.g. `2026-05-04-eoa-receive-fix-verify.ts`. Otherwise keep
the original filename.

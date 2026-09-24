---
name: heimcloud-ops-fix
description: Code a minimal fix on a heimcloud/neo fork branch for an Ops incident.
---

# Heimcloud Ops fix

You run **on the ops host only**, via local Hermes. No cloud agents. Lab/customer machines are never targets.

## Workspace

A scratch clone is prepared under `$HOME/workspace/autofix/<incident_id>/neo`. Base the branch on the neo ref the host currently runs (documented in the prompt). Push target is **heimcloud/neo** only.

## Rules

- Branch name: `fix/<short-topic>` or `ops/incident-<n>` — no customer info.
- Minimal diff. Never touch deny-listed paths when the lab host shares the ops host: `nix/services/ops`, `nix/services/hermes`, `nix/services/swag`, `nix/modules/core`.
- No identifiers in branch name, commit messages, or file contents you add (no customer slug, lab hostname, IP, email, home path, slug-bearing plugin URL).
- Do not open a GitHub PR and do not merge. The worker pushes and prepares a compare link.
- Run available evals/format checks if present; otherwise note what was skipped.

## Output

When done, print a single JSON object (no fences):

```json
{"status":"ready_to_push","branch":"fix/short-topic","summary":"what changed","commit_message":"fix: …"}
```

On failure:

```json
{"status":"failed","summary":"why","fixable":false}
```

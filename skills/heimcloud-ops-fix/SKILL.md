---
name: heimcloud-ops-fix
description: Code a minimal fix on a heimcloud/neo fork branch for an Ops incident.
---

# Heimcloud Ops fix

You run **on the ops host only**, via local Hermes. No cloud agents. Lab/customer machines are never targets.

## Workspace

The worker prepares a fresh partial clone under `$HOME/workspace/autofix/<job>/neo`, already checked out at the neo ref the host runs (named in the prompt). Work only inside that clone. Push target is **heimcloud/neo**, but **the worker pushes, not you**.

## Rules

- Branch name: `fix/<short-topic>` or `ops/incident-<n>` — no customer info.
- **Commit** your change on that branch (`git switch -c <branch>` then `git commit`). The worker only pushes commits on top of the base ref; uncommitted edits are discarded.
- Git author/committer identity is preset by the worker. Do not run `git config`, do not amend the base history.
- Do **not** `git push`, do not open a GitHub PR, do not merge. The worker runs a fail-closed redaction and deny-list gate, pushes, and prepares a compare link; Damo opens the upstream PR.
- Minimal diff. Never touch deny-listed paths when the lab host shares the ops host: `nix/services/ops`, `nix/services/hermes`, `nix/services/swag`, `nix/modules/core`.
- No identifiers in branch name, commit messages, or file contents you add (no customer slug, hostname, IP, email, home path, slug-bearing plugin URL). Any 10-character upper-case token blocks the push.
- If the prompt includes a previous lab-test failure, fix forward with a new commit on the same branch.
- Run available evals/format checks if present (e.g. `nix-instantiate --parse` on changed files); otherwise note what was skipped in `summary`.

## Output

When done, print a single JSON object (no fences):

```json
{"status":"ready_to_push","branch":"fix/short-topic","summary":"what changed and what was checked","commit_message":"fix: …"}
```

On failure:

```json
{"status":"failed","summary":"why","fixable":false}
```

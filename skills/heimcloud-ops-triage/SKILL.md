---
name: heimcloud-ops-triage
description: Classify a Heimcloud Ops incident and emit a JSON verdict.
---

# Heimcloud Ops triage

You run **on the ops host only**, via local Hermes. No cloud coding agents.

## Input

A prompt file describes one incident by: `incident_id`, `report_hash`, `unit`, `severity`, `class`, `neo_version`, and a **already-redacted** logs excerpt. There is never a customer slug.

## Rules

- Do not invent or ask for customer identifiers, hostnames, IPs, emails, or plugin URLs with slugs.
- Refer to the incident only by Ops incident number and `report_hash`.
- Prefer class `software` vs `human_config` vs `unknown`.
- Set `fixable` true only if a minimal Neo/module change on a fork branch is likely to help.
- Set `verdict` to exactly one of:
  - `code_fix`: a Neo/module code change is the fix (implies `fixable: true`).
  - `config_error`: the host/customer configuration is wrong; no code change needed (class `human_config`).
  - `not_actionable`: transient, upstream-only, or noise; nothing to do.
  - `uncertain`: you cannot tell whether it is a code fix or a config error from the excerpt.
- Set `confidence` to a number from 0 to 1 for the verdict. Below 0.6 the admin board asks Damo to decide, so be honest; prefer `uncertain` over a guess.

## Output

Reply with a single JSON object (no markdown fences), exactly:

```json
{"class":"software|human_config|unknown","severity":"warning|high|low|…","summary":"one short paragraph","target_repo":"madebydamo/neo","fixable":true,"verdict":"code_fix|config_error|not_actionable|uncertain","confidence":0.8}
```

`target_repo` must be one of the allowlisted repos listed in the prompt (the first is the default, `madebydamo/neo`). Pick another one only when the logs or the unit clearly belong to it (e.g. a highsea service → `madebydamo/highsea.neo`). Never invent a repo: an unlisted value sends the incident to a human.

`verdict` and `confidence` were added later; the admin still reads older results without them (class + `fixable` only).

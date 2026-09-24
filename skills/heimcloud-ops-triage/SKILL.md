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

## Output

Reply with a single JSON object (no markdown fences), exactly:

```json
{"class":"software|human_config|unknown","severity":"warning|high|low|…","summary":"one short paragraph","target_repo":"madebydamo/neo","fixable":true}
```

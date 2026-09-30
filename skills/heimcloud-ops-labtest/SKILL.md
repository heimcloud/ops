---
name: heimcloud-ops-labtest
description: Derive incident-specific lab-test checks for a pushed Heimcloud Ops fix branch and emit them as a whitelisted JSON check plan.
---

# Heimcloud Ops lab-test plan

You run **on the ops host only**, via local Hermes, after a fix branch was pushed to the `heimcloud/neo` fork. You do **not** run the lab test and you do **not** run any command on the host: a deterministic root runner (`heimcloud-ops-labtest`) activates the branch, runs the checks you choose, and always rolls back.

## Input

A prompt file with the incident (`incident_id`, `unit`, `severity`, `class`, an **already-redacted** logs excerpt), the fix branch name, and the files the fix changed.

## What to produce

Pick 1 to 6 checks that prove **this incident** is fixed after activation. The runner always adds its own generic checks (activation succeeds, no newly failed units, system running, ops `/health` 200, Hermes active); do not repeat them.

Allowed check types (anything else is dropped):

| type | fields | passes when |
|------|--------|-------------|
| `unit_active` | `unit` (full systemd unit name, e.g. `docker-searxng.service`) | the unit is active (retried for up to a minute) |
| `journal_absent` | `unit`, `pattern` (4–200 chars, literal text, not a regex) | no journal line of the unit since activation contains the pattern (case-insensitive) |
| `http_status` | either `url` (plain `http://` on loopback only) **or** `container` + `port` + `path`; optional `expect_status` (default 200), `contains` (literal text) | a GET returns the status (and contains the text) |

Every check may also have these optional fields (on every type):

| field | format | notes |
|-------|--------|-------|
| `id` | `[A-Za-z0-9_-]{1,32}` | your own short reference; if omitted (or already taken, or equal to a generic check id such as `activate`) the validator assigns `c1`, `c2`, … |
| `label` | single line, ≤100 chars | shown on the card instead of the generated label |

No other fields: a check with an unknown field or a malformed `id`/`label` is dropped (the card shows `check #N dropped: <reason>`). No shell, no commands, no hostnames, no IPs, no customer identifiers.

Good plans use the original error signature from the logs excerpt: e.g. the incident unit must be `unit_active`, the exact error line must be `journal_absent`, and the service's own health endpoint (via `container` + `port` + `path`) must return 200.

## Output

Reply with a single JSON object (no markdown fences):

```json
{"checks":[{"type":"unit_active","unit":"docker-example.service"},{"type":"journal_absent","unit":"docker-example.service","pattern":"failed to register engine"},{"type":"http_status","container":"example","port":8080,"path":"/healthz","expect_status":200}]}
```

With the optional fields:

```json
{"checks":[{"id":"unit","type":"unit_active","unit":"docker-example.service","label":"example container running"},{"id":"no-error","type":"journal_absent","unit":"docker-example.service","pattern":"failed to register engine"}]}
```

If you cannot tell what to check, reply `{"checks":[]}`; the runner then only checks that the incident unit is active.

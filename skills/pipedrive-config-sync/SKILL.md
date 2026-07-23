---
name: pipedrive-config-sync
description: >-
  Fetch and verify the live Pipedrive configuration (custom fields, option values,
  pipelines, stages, activity types, project boards and phases) before doing
  anything that depends on it. Use this whenever creating or designing a Pipedrive
  automation or Make.com / Zapier scenario, referencing or suggesting a Pipedrive
  field name / option / stage / pipeline / project board / phase, writing or
  editing anything under a project's pipedrive/ or docs/specs/ directory, reviewing
  production settings, setting up a fresh Pipedrive environment, managing deal
  filters (saved list views) or project boards and phases, or debugging a failed
  field mapping - basically any time a project's local pipedrive/*.csv mirror files
  might be out of date. It runs the bundled pipedrive-sync.mjs to detect drift,
  refresh the mirrors (--write), manage deal filters, create project boards and
  phases, and flag orphaned options whose parent field was deleted. Always run the
  drift check before trusting a field key, so an automation never maps to a stale
  or deleted field.
---

# Pipedrive Config Sync

## Why this exists

Field references (Make.com module mappings, Pipedrive variable merges, stage gates,
automation specs, Looker Studio queries) are only correct if the field key actually
exists in production. A project's local mirror files in `pipedrive/` silently fall
out of date when someone adds, renames, or deletes a field or option in Pipedrive.
Two failure modes have already bitten real client projects:

- Mapping a Make.com module to a **deleted custom field** (the field is gone but a
  stale row lingers in `data_fields_options.csv`). The mapping fails silently.
- Designing an automation around an **option that no longer exists**, or missing a
  **new field** that was added in production but never mirrored locally.

`pipedrive-sync.mjs` fetches the live configuration over the Pipedrive API and
compares it against the local mirrors, so you catch this before writing a spec
rather than after the automation breaks. Run it as the first step of any
config-dependent task.

This skill is global: one script, any Pipedrive project. It resolves which project's
mirrors to use from the working directory.

## When to run it

Run the **drift check** before, or at the start of, any of these:

- Designing or editing a Make.com scenario or Pipedrive automation.
- Suggesting or writing a field merge, variable reference, stage gate, or option value.
- Reviewing what's currently configured in production ("what fields/options/stages exist?").
- Editing anything under `pipedrive/` or `docs/specs/` that names fields or options.
- Debugging why a mapping or automation isn't working (suspected deleted/renamed field).

Run **`--write`** when:

- Setting up a fresh environment / first checkout (create the local mirror files).
- The drift check reported changes and you want to bring the mirrors current.

## Prerequisites

The script needs a Pipedrive API token. It reads `PIPEDRIVE_API_TOKEN` from the
environment, or from `.env` / `.env.local` in the project root or its `pipedrive/`
directory (all gitignored; `.env.local` wins).

If the token is missing the script exits with a clear message. **Do not invent or
hardcode a token, and do not skip the check and guess at field names.** Tell the
user the token is missing, then continue once it is in place. (Node 14+ required;
no npm dependencies.)

## Which project it operates on

The script never writes next to itself. It resolves the **mirror directory** in this
order:

1. `$PIPEDRIVE_MIRROR_DIR`, if set.
2. The nearest `pipedrive/` directory at or above the current working directory.
3. The current working directory (last resort).

So run it from the project root (or anywhere inside the project) and it targets that
project's `pipedrive/` mirrors. It prints the resolved directory on every run - check
that line before trusting the output.

## Commands

```bash
SYNC=~/.claude/skills/pipedrive-config-sync/pipedrive-sync.mjs

node $SYNC                  # drift check: report differences, exit 1 if any, 0 if in sync
node $SYNC --write          # refresh local mirrors from live (also pipelines/stages/activity_types.csv)
node $SYNC --json           # same check, machine-readable JSON
node $SYNC filters list     # list deal filters (saved list views) with their ids
node $SYNC filters ensure   # create the filters defined in pipedrive/filters.json (idempotent)
node $SYNC projects list    # list project boards and their phases with ids
node $SYNC projects ensure  # create boards + phases + reference projects/tasks from pipedrive/projects.json (idempotent)
```

The local mirror files the script maintains, in the project's `pipedrive/`:

| File | Contents |
|------|----------|
| `data_fields.csv` | All fields (system + custom) per entity, incl. Project, with API key |
| `data_fields_options.csv` | Option values for option-type fields |
| `pipelines.csv` | Pipelines (id, name, active, order) |
| `stages.csv` | Stages (id, name, pipeline, order, probability) |
| `activity_types.csv` | Activity types |
| `boards.csv` | Project boards (id, name, order) |
| `phases.csv` | Project phases (id, name, board, order) |
| `filters.json` | Deal-filter definitions for `filters ensure` (per project, optional) |
| `projects.json` | Board + phase (+ optional reference-project/task) definitions for `projects ensure` (per project, optional) |

## How to act on the output

The drift report groups differences into categories. Read them and respond before
continuing your task:

| Report section | What it means | What to do |
|----------------|---------------|------------|
| NEW custom fields in production | A field exists live but not in the local CSV | The field is real and safe to reference. Run `--write` to add it to the mirror. |
| Custom fields DELETED in production | The local CSV lists a custom field that no longer exists | Do not reference it. Run `--write` to drop it. |
| Field LABEL changed | A field was renamed in production | Use the live name. Run `--write` to update. |
| NEW options in production | A field gained option values | Safe to reference. `--write` to mirror. |
| Options REMOVED | An option value was deleted (field still exists) | Do not reference that option. `--write` to drop. |
| ORPHANED options - parent field is DELETED | Options linger for a field that was deleted | **Never map to this field key.** This is the gotcha below. |
| In sync | Mirrors match production | Proceed; the local CSVs are trustworthy. |

After acting, if you ran `--write`, review the git diff before committing - only
custom (hash-keyed) fields and options are reconciled; system rows are preserved from
the native export.

## The orphaned-field gotcha

`data_fields_options.csv` can contain option rows for fields that have been **deleted**
in Pipedrive. A field key is only authoritative if it also appears in `data_fields.csv`.
The drift check automates this cross-check (the "ORPHANED options" section), but the
rule applies any time you read the options file by hand: before citing or mapping an
option, confirm its `Field API key` exists as a live field.

Real example (FPAF): the old custom "Loss Reason" field
(`79a37d39d7ae8b1f3a5ae923f85104efae4f91d1`) and "Take Session"
(`755b6a665330fe9ed31533f025c2154dfd599316`) are deleted; the real loss-reason
mechanism is Pipedrive's native `lost_reason` field. Always verify field names against
`data_fields.csv` and option values against `data_fields_options.csv`.

## Managing deal filters (saved list views)

`filters list` prints every deal filter with its id. `filters ensure` creates the
filters defined in the project's `pipedrive/filters.json` and is **idempotent** - it
skips any filter whose name already exists, so it is safe to re-run. Filters default to
`visible_to: "7"` (entire company) so the whole team sees them.

`filters.json` is either a bare array of filter specs, or an object with an optional
`visible_to`:

```json
{
  "visible_to": "7",
  "filters": [
    { "name": "Donations - Won this month",
      "and": [["pipeline", "=", "6"], ["status", "=", "won"], ["won_time", "=", "this_month"]] },
    { "name": "Donations - Open disputes",
      "and": [["pipeline", "=", "6"]],
      "or": [["Dispute status", "=", "needs response"], ["Dispute status", "=", "under review"]] }
  ]
}
```

A condition is `["<field>", "<operator>"]` or `["<field>", "<operator>", "<value>"]`:

- **`<field>`** is a standard key (`pipeline`, `status`, `stage_id`, `won_time`,
  `add_time`, `value`, …) or a custom field's **exact name** (e.g. `"Stripe Payment
  status"`). The script resolves it to the numeric `field_id` from live `dealFields`,
  so ids are never hardcoded.
- **enum `<value>`** is the option **label** (e.g. `"Refunded"`, `"C3"`, `"Monthly"`);
  it is resolved to the numeric option id automatically.
- Pipedrive enum conditions only support `=`, so an **"is one of A, B"** set must go in
  the `or` array - the filter evaluates as `(and group) AND (or group)`. Put shared
  constraints (e.g. `pipeline = 6`) in `and` and the alternatives in `or`.
- **Relative date tokens** Pipedrive accepts: `today`, `yesterday`, `this_week`,
  `last_week`, `this_month`, `last_month`, `this_quarter`, `last_quarter`, `this_year`,
  `last_year`, `next_week`, `next_month`. There is **no** arbitrary "last N days" token.
  With `=`, a period token matches the whole period.
- `IS NULL` / `IS NOT NULL` take no value (e.g. `["Receipt Link", "IS NULL"]`).

The write path uses `x-api-token` (GET/POST) against the v1 `/filters` endpoint; like
the drift check it never prints the token. Field/option ids are resolved from the v1
`dealFields` endpoint (v2 omits standard fields such as `pipeline`).

## Projects: fields, boards, and phases

Pipedrive Projects have their own custom fields, boards, and phases (all on the v2
API, currently **in beta**). The skill covers all three:

- **Project custom fields** are part of the drift check, exactly like Deal/Person
  fields. They land in `data_fields.csv` under item type `Project` (keyed by the v2
  `field_code`, a 40-char hash), and their options in `data_fields_options.csv`. So
  the same "verify before you reference" rule covers project fields too.
- **Boards and phases** are mirrored to `boards.csv` and `phases.csv` on `--write`,
  the same way pipelines and stages are. Reference a board or phase id from those
  files rather than guessing.
- The Projects v2 endpoints are **beta and may be disabled** on an account. The skill
  treats them as optional: if they're unavailable, the drift check prints a `(warn)`
  line, leaves any existing project rows / `boards.csv` / `phases.csv` untouched (it
  never flags them as deleted), and finishes the rest of the report normally.

`projects list` prints every board with its phases and ids. `projects ensure` creates
boards, phases, and (optionally) **reference projects with task checklists** from the
project's `pipedrive/projects.json` and is **idempotent** - a board is matched by name,
a phase by (board, name), a reference project by title, and a task by title; only
missing items are created, and nothing is renamed, reordered, or deleted.

`projects.json` is either a bare array of boards, or an object with a `boards` array.
A phase is a plain string (name only) or an object `{ "name", "order_nr" }`. A board
may also carry an optional `reference_project` - a project card pre-loaded with a task
checklist, so it can be **"Saved as template"** in the Pipedrive UI. A task is a plain
string (title) or an object `{ "title", "phase?", "description?" }`, where `phase` (a
phase name on the same board) places the task under that phase:

```json
{
  "boards": [
    { "name": "Production", "order_nr": 1,
      "phases": ["Intake", "Pre-Session", "Session", "Editing", "Ordered", "Delivered"],
      "reference_project": {
        "title": "TEMPLATE - Production",
        "tasks": [
          { "phase": "Intake", "title": "Confirm brief" },
          { "phase": "Editing", "title": "First-pass edit" }
        ]
      }
    }
  ]
}
```

The write path uses `x-api-token` and never prints the token: boards + phases via the v2
`/boards` and `/phases` endpoints; a reference project via v2 `POST /projects`; its tasks
via v1 `POST /tasks`, then placed under a phase via v1 `PUT /projects/{id}/plan/tasks/{taskId}`.
`order_nr` is optional; omit it to let Pipedrive append in the given order. Note: a task's
phase placement lives in the project **plan**, not on the task's own `phase_id` field
(which reads null) - view it via the project plan or the Pipedrive UI.

## Typical flows

**Designing a new automation (most common):**

1. Run the drift check.
2. If in sync, reference fields/options directly from the local CSVs.
3. If drift touches fields your automation uses, run `--write`, eyeball the diff, then
   design against the refreshed values. Flag any deleted/renamed field you were about
   to rely on.

**Initial setup / fresh checkout:**

1. Confirm the token is configured (see Prerequisites).
2. Run `--write` from the project root to generate all mirror files from live.
3. Commit the generated CSVs as the baseline.

**Reviewing production settings:**

1. Run the drift check (or `--write` to also snapshot pipelines/stages/activity types
   and project boards/phases).
2. Report current fields/options/stages/boards/phases from the now-current mirror files.

**Standing up a project board:**

1. Define the board and its phases in `pipedrive/projects.json`.
2. Run `projects ensure`. Re-run freely - it only creates what's missing.
3. Run `--write` to refresh `boards.csv` / `phases.csv` so specs can reference the ids.

## Guardrails

- Never hardcode or print the API token; never commit `.env` / `.env.local`.
- Check the "Mirror dir:" line the script prints - make sure it points at the project
  you meant.
- Pipedrive's **native data-fields export** remains the source of truth for the full
  system-field set. `--write` only reconciles custom fields/options and preserves system
  rows, so it is safe to run, but it does not invent system fields the API omits.
- The drift check is read-only against Pipedrive (GET only); it never modifies
  production. Only `filters ensure` and `projects ensure` write to Pipedrive, and only
  by **creating** filters / boards / phases that do not already exist - they never
  rename, reorder, or delete.
- Projects endpoints are v2 **beta**. If they're disabled on the account the drift
  check warns and skips them without failing; `projects list` / `projects ensure` exit
  with a clear "beta may be disabled" message. Don't work around this - it means the
  account can't use the Projects API yet.

## API version policy (v1 CRUD deprecation)

Pipedrive is **retiring the v1 CRUD endpoints** for activities, deals, persons,
organizations, products, **pipelines**, **stages**, and itemSearch - every verb,
including `GET`. The changelog dates this end of 2025; partner-facing notices have since
quoted mid-2026. **Treat them as gone.** When designing any automation, Make.com /
Zapier module, or helper script for these projects, always target `/api/v2` for those
entities.

What this means for anyone extending this skill or writing sibling scripts:

- **Never introduce a v1 call** for a deprecated entity - not even for one-off
  debugging. `GET /v1/persons/{id}` is tempting because it returns every custom field
  inline, but it is on the retirement list. Use `GET /api/v2/persons/{id}` and name the
  hashes you need via `?custom_fields=<hash>,<hash>` (v2 omits custom fields otherwise;
  `?include_fields=custom_fields` is **not** valid for persons and returns a schema
  error).
- **The v1 calls this skill still makes are deliberate** - they are the ones with no v2
  successor: field definitions (`{entity}Fields`), `filters`, `activityTypes`, and the
  project `templates` / `tasks` / `plan` endpoints. `activityTypes` is **not** on the
  deprecation list. Pipelines and stages **are**, and this skill already reads both from
  v2.
- **Auth:** always the `x-api-token` header, never the token as a query parameter (it
  leaks into logs and URLs). This script already does this and never prints the token.
- **A failed request still returns HTTP-200-shaped JSON with `success:false`**, so a
  script that blindly reads `.data.<hash>` silently prints empty for every field and
  looks like a clean "unset" result. Always check `success` before believing a negative.
  (This script's fetch helpers already reject on `success:false`.)
- **Editing field options via `PUT /v1/{entity}Fields/{id}` REPLACES all options** - it
  does not append. To add one safely: GET current options, append, PUT the full list
  back. Sending just the new option destroys every existing option (and their ids, which
  breaks every deal/person referencing them).
- **Set / multi-option fields in v2 take an array of integer option ids**
  (`[884, 891, 923]`), never a comma-separated string (v2 returns 400). Phone-type
  **custom** fields take a plain string, not the array-of-objects shape used by the
  native `phones` field.

The authoritative reference (with the full deprecated-endpoint list and the v1 calls
that legitimately remain) is `docs/pipedrive-api.md` in the gtm-tools repo.

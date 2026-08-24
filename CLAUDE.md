# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **distribution repo** for reusable go-to-market tooling — Claude Code skills, standalone
scripts, and templates for a Pipedrive / Make.com / Apollo / CloudTalk / BigQuery stack.
There is no build, no package.json, no test suite, and no dependencies: the only code is
`skills/pipedrive-config-sync/pipedrive-sync.mjs`, plain Node 14+ ESM using `https` and `fs`.
(The `pipedrive-automations` skill is documentation-only — it owns the design knowledge and
defers all API reading, including the automation mirror, to `pipedrive-config-sync`.)

The important consequence of that: **this repo produces nothing that runs here.** Everything
is consumed from *other* project repos, which hold the per-project state (the `pipedrive/`
CSV mirrors, `filters.json`, `projects.json`, and the API token). Nothing client-specific —
names, ids, field hashes, tokens — belongs in this repo.

## Install model (why edits here take effect immediately)

`./install.sh` **symlinks** each `skills/<name>/` into `~/.claude/skills/<name>/` by default
(`--copy` pins a snapshot instead; `CLAUDE_SKILLS_DIR` overrides the destination). A skill
directory is anything under `skills/` containing a `SKILL.md`.

So when the default symlink install is in place, editing `skills/pipedrive-config-sync/`
here changes the live global skill for **every project on the machine** with no reinstall
step. Treat edits to that directory as production changes, and keep the script
project-agnostic.

```bash
./install.sh                              # symlink every skill
./install.sh pipedrive-config-sync        # one skill
./install.sh --copy                       # snapshot instead of symlink
ls -l ~/.claude/skills                    # verify; then /skills in Claude Code
```

## Running the script

It is never run from this repo — run it from the project whose Pipedrive account you're
working on. One script, `pipedrive-sync.mjs`, with subcommands for every entity it reads,
including the automation mirror:

```bash
SYNC=~/.claude/skills/pipedrive-config-sync/pipedrive-sync.mjs
node $SYNC                  # config drift check (read-only GETs); exit 1 = drift, 0 = in sync, 2 = error
node $SYNC --write          # refresh the project's pipedrive/*.csv mirrors from live
node $SYNC --json           # machine-readable drift report
node $SYNC filters list|ensure    # deal filters from pipedrive/filters.json (idempotent)
node $SYNC projects list|ensure   # boards/phases from pipedrive/projects.json (idempotent)
node $SYNC filters ensure --dry-run   # preview: resolve/validate against live, write nothing
node $SYNC projects ensure --dry-run  # preview boards/phases/reference projects, write nothing
node $SYNC automations      # drift-check the native-automation mirror (read-only; no write endpoint)
node $SYNC automations --write  # refresh <mirror>/automations/ (one JSON per rule + index.md/json)
node $SYNC automations --json   # machine-readable automation summary
```

The `pipedrive-automations` skill is documentation-only and runs nothing; it defers the
mirror above to this script.

Token: `PIPEDRIVE_API_TOKEN` from the environment, or `.env` / `.env.local` at the project
root or in the mirror dir (`.env.local` wins). All gitignored. Never hardcode or print it.

To test a change against a real account, point it at a scratch mirror dir rather than a
client project: `PIPEDRIVE_MIRROR_DIR=/tmp/pd-test node $SYNC` (create the dir first).

## Architecture of pipedrive-sync.mjs

Read the header comment in the file first — it states the API surface and version policy.
The design decisions that aren't obvious from any single function:

**Mirror-dir resolution.** The script lives in the *global* skill dir, so it must never
write next to itself. `resolveMirrorDir()` picks, in order: `$PIPEDRIVE_MIRROR_DIR` → the
nearest `pipedrive/` at or above cwd → cwd. It prints `Mirror dir:` on every run; that line
is the contract with the user, so keep it.

**System vs custom rows is the central invariant.** Pipedrive's native CSV export and the
API disagree about the *system* field inventory, so `--write` reconciles only custom fields
and options — identified purely by `HASH_RE` (a 40-char hex key) — and copies every
non-hash row through byte-identical. Both `computeDrift()` and `writeMirrors()` gate on
this. Break it and `--write` starts silently deleting system rows from a client's mirror.

**Orphaned options.** `data_fields_options.csv` can hold options for a field that no longer
exists. `computeDrift()` splits a missing option into `optionsRemoved` (parent field still
live) vs `optionsOrphanedDeletedField` (parent gone) — the second is the failure mode the
whole skill exists to prevent, so it gets its own report section.

**Optional endpoints degrade, never fail.** Project fields, boards, and phases are v2
**beta** and may be disabled per account. Entities flagged `optional: true` in `ENTITIES`
are skipped with a `(warn)` on fetch failure, and `FETCHED_ENTITIES` gates the deletion
check so unfetched entities are never reported as deleted. `writeMirrors()` skips
`boards.csv` / `phases.csv` entirely when the fetch failed, so a disabled endpoint can't
truncate an existing mirror to an empty file. Preserve this pattern for any new optional
endpoint.

**Idempotent writes only.** `filters ensure` matches by name, `projects ensure` matches a
board by name, a phase by (board, name), a reference project by title, a task by title.
They only ever **create** what's missing — never rename, reorder, or delete. `ensure`
commands must stay safe to re-run. Both accept **`--dry-run`**, which still does the
read-only resolution (field/option-name → id, existing-item lookup) but creates nothing;
keep the non-dry-run output path byte-identical when touching these functions.

### The `automations` subcommand (native-automation mirror)

`node pipedrive-sync.mjs automations` mirrors an account's native workflow automations into
`<mirror>/automations/` and is deliberately **read-only** — Pipedrive exposes no write endpoint
for automations, so the design is *build in the UI, mirror by API, diff in git*. It is a
subcommand of the same script (like `filters` / `projects`), reusing `httpsGetJson`, `loadToken`,
`MIRROR_DIR` and the rate-limit helpers, so it behaves identically to the rest of the tool. The
design knowledge for the automations themselves lives in the separate `pipedrive-automations`
skill; this is only the read side.

The non-obvious parts:

**The endpoint is singular and undocumented.** `GET /api/v2/automation/workflow`; the plural
`/automations` 404s. On any fetch failure the subcommand exits **2** ("could not check"), never
1 ("everything was deleted") — a Pipedrive-side change to an undocumented path must not read
as a mass deletion. Same `success:false`-on-HTTP-200 trap as the rest of the script;
`httpsGetJson` rejects on it.

**`context` splits two things sharing one endpoint.** `context: "automation"` is a workflow
rule; `context: "automatic-assignment"` is the separate assignment tool (its record carries a
literal string where a uuid belongs). `mirrorAutomations` filters to `automation` or it miscounts.

**Webhook resolution is optional and degrades.** A webhook action step carries a webhook id,
not a URL, so `/v1/webhooks` is read to name destinations in the index — but that endpoint
is unavailable on some accounts (permissions/plan). On failure it `(warn)`s, writes the mirror
without it, and never reports a pre-existing `webhooks.json` as removed. Preserve this
degrade-never-fail pattern, mirroring config-sync's optional endpoints.

**Credentials are stripped before git.** An inline `Basic`/`Bearer` string anywhere in a
definition is redacted one-way (there's no write endpoint to inject back into), and webhooks'
write-only `http_auth_*` fields are dropped rather than mirrored as a misleading `null`. Keep
any new field that could carry a secret out of the committed mirror.

**Decode by trailing key, not full resource id.** `dynamicRegistry.eventFields` is keyed by the
full `dynamic-event-field@…/{hash}` id while `triggerFieldResourceIds` uses a different prefix
for the same field; the label sits at `.field.label`, not `.label`. Match on the trailing hash
or the index renders bare 40-char keys that look resolved but aren't. Labels are a snapshot from
when the rule was saved, so the index warns to grep the key, not the label.

## Pipedrive API rules (non-negotiable)

`docs/pipedrive-api.md` is the authoritative reference; the same policy is restated in the
skill's SKILL.md and the script header. The load-bearing parts:

- **Never introduce a v1 CRUD call** for activities, deals, persons, organizations,
  products, **pipelines**, **stages**, or itemSearch — every verb including `GET`, not even
  for one-off debugging. They're being retired; use `/api/v2`. Pipelines and stages are
  already on v2 here.
- The v1 calls that remain are deliberate: `filters`, `activityTypes`, `notes`, and the
  project `tasks` / `plan` / `projectTemplates` endpoints have no v2 successor. `{entity}Fields`
  is the nuanced one — v2 field endpoints **do** exist and the drift inventory uses them
  (custom fields under `field_code`, companions nested in `subfields`), but v1 `{entity}Fields`
  is still read for the **filters** path because only v1 returns the numeric field/option ids.
  Field endpoints are not on the deprecation list, so both are safe. See `docs/pipedrive-api.md`.
- Auth is the **`x-api-token` header**, never a query parameter (it leaks into logs/URLs).
- **A failed request returns HTTP-200-shaped JSON with `success:false`.** A script that
  reads `.data.<hash>` blindly prints empty and looks like a clean "unset" result. Both
  `httpsGetJson` and `httpsSendJson` already reject on `success:false` — keep any new
  helper doing the same.
- **`PUT /v1/{entity}Fields/{id}` with `options` REPLACES all options**, destroying option
  ids that existing records reference. GET → append → PUT the full list.
- v2 set/multi-option fields take an array of **integer option ids**, not a comma-separated
  string. Phone-type *custom* fields take a plain string, not the array-of-objects shape.
- v2 omits custom fields on persons unless named: `?custom_fields=<hash>,<hash>`.
  `?include_fields=custom_fields` is invalid for persons and returns a schema error.

## Adding to this repo

- **Skills** → `skills/<name>/` with a `SKILL.md` carrying `name` + `description`
  frontmatter (the description is what triggers the skill, so make it enumerate the
  situations that should invoke it) plus any bundled scripts.
- **Scripts** → `scripts/`, standalone with a real `--help`. If a script starts sharing
  logic with a skill, factor the shared part out rather than copy-pasting.
- **Templates** → `templates/`.
- Adding a skill means updating three places: the table in `README.md`, `docs/INSTALL.md`
  (including its per-skill requirements section), and this file if it changes the
  architecture.

## Subagents v1.0

Spawn subagents to isolate context, parallelize independent work, or offload bulk mechanical tasks. Don't spawn when the parent needs the reasoning, when synthesis requires holding things together, or when spawn overhead dominates.

Pick the cheapest model that can do the subtask well:
- Haiku: bulk mechanical work, no judgment
- Sonnet: scoped research, code exploration, in-scope synthesis
- Opus: subtasks needing real planning or tradeoffs

If a subagent realizes it needs a higher tier than itself, return to the parent.

Parent owns final output and cross-spawn synthesis. User instructions override.

## Preferred Tools

### Data Fetching

1. **WebFetch**: free, text-only, works on public pages that don't block bots.
2. **agent-browser CLI**: free, local Rust CLI + Chrome via CDP. For dynamic pages or auth walls that WebFetch can't handle. Returns the accessibility tree with element refs (@e1, @e2). ~82% fewer tokens than screenshot-based tools. Install: `npm i -g agent-browser && agent-browser install`. Use `snapshot` for AI-friendly DOM state, element refs for interaction.
3. **Notice recurring fetch patterns and propose wrapping them as dedicated tools.** When the same fetch/parse logic comes up more than once, suggest wrapping it as a named tool (e.g. a skill file or a .py script that calls `agent-browser` with the snapshot and extraction steps baked in for that source). Add the entry to `## Dedicated Tools` below and reference it by name on future calls.

### PDF Files

Use 'pdftotext', not the 'Read' tool. Use 'Read' only when the user directly asks to analyze images or charts inside the document. Read loads PDFs as images.

# Pipedrive API reference (for gtm-tools)

Shared guidance for any script, skill, or automation in this repo that talks to
Pipedrive. The single most important rule is the **v1 CRUD deprecation** below.

## Authentication

Always use the `x-api-token` **header**. Never pass the token as a query parameter - it
leaks into logs, browser history, and proxy URLs.

```bash
curl -s -H "x-api-token: $PIPEDRIVE_API_TOKEN" \
  "https://api.pipedrive.com/api/v2/persons?limit=10"
```

Keep tokens out of the repo: environment variable or a gitignored `.env` / `.env.local`,
or a secrets manager. Never hardcode or print them.

## API versions

Pipedrive runs two API versions and some endpoints exist in only one.

- **v2** (`/api/v2/`): entity CRUD (persons, deals, organizations, products, pipelines,
  stages, activities), Projects (boards, phases, fields), **and field-definition endpoints**
  (`/api/v2/dealFields`, `personFields`, `organizationFields`, `productFields`,
  `activityFields` - verified live). v2 field endpoints key custom fields by `field_code`
  (the 40-char hash), carry the label as `field_name`, expose `is_custom_field`, and nest
  companion subfields (`<hash>_currency`, address parts, range ends) under a `subfields`
  array instead of listing them separately. Set / multi-option fields expect an **array of
  integer option ids** (e.g. `[117, 234]`), not a comma-separated string. Cursor pagination
  (`limit` up to 500, `cursor`).
- **v1** (`/v1/`): filters, activity types, notes, users, recents, merge, undelete, and the
  project templates/tasks/plan endpoints. The v1 **field-definition** endpoints also remain
  useful even though v2 has them: v1 exposes the **numeric** field id and option ids that v2
  omits (needed to resolve filter conditions) and lists companion subfields as separate rows.
  Field-definition endpoints are **not** on the v1 CRUD deprecation list, so either version is
  sunset-safe. v1 returns everything in one response (offset pagination where paginated at all).

### v1 CRUD deprecation - use v2 for anything CRUD

Pipedrive is [retiring the v1 CRUD endpoints](https://developers.pipedrive.com/changelog/post/deprecation-of-selected-api-v1-endpoints)
for **activities, deals, persons, organizations, products, pipelines, stages, and
itemSearch** - every verb, including `GET /v1/persons/{id}`. The changelog states
**December 31, 2025**; partner-facing notices have since quoted **July 31, 2026**. Treat
them as gone and target `/api/v2` for all of these entities.

**Do not reintroduce a v1 CRUD call**, including for one-off debugging.

The v1 calls that legitimately remain:

| Still v1 | Why |
|---|---|
| `/v1/{entity}Fields` | v2 field endpoints exist but omit the **numeric** field/option ids filters need; use v2 for the field/option inventory, v1 to resolve filter conditions. Not on the deprecation list. |
| `/v1/filters` | no v2 filters endpoint |
| `/v1/activityTypes` | not on the deprecation list; no v2 equivalent |
| `/v1/notes` | notes were never migrated |
| `/v1/persons/{id}/merge` | no v2 merge |
| `/v1/users/me` | no v2 users |
| `/v1/recents` | only feed that reports **deleted** entities |
| `/v1/projects/{id}/tasks`, `/v1/tasks`, `/v1/projects/{id}/plan/...`, `/v1/projectTemplates` | Projects tasks/plan/templates are v1-only |
| `PUT /v1/{entity}/{id}` (undelete) | on the retirement list, **no successor** |

That last one has no v2 replacement at all: `PATCH /api/v2/persons/{id}` accepts neither
`active_flag` nor `is_deleted`, and Pipedrive purges deleted records after ~30 days. Once
v1 goes dark, recovering a mass-delete becomes a support ticket - plan accordingly.

## Reading custom fields on a person (v2)

v2 omits custom fields unless you name them. Pass `custom_fields` with the hashes you
want:

```bash
curl -s -H "x-api-token: $PIPEDRIVE_API_TOKEN" \
  "https://api.pipedrive.com/api/v2/persons/121483?custom_fields=<hash1>,<hash2>"
```

Two traps:

- `?include_fields=custom_fields` is **not valid** for persons - it returns
  `ERR_SCHEMA_VALIDATION_FAILED`. `include_fields` is for native fields v2 omits by
  default (e.g. `include_fields=marketing_status`).
- `GET /v1/persons/{id}` returns every custom field inline as a top-level key, which makes
  it a tempting shortcut. It is on the retirement list - don't use it.

## The `success:false` gotcha

A failed request still returns **HTTP-200-shaped JSON** with `"success": false`. A script
that blindly reads `.data.<hash>` prints empty for every field and looks like a clean
"field is unset" result. **Check `success` before believing a negative.**

## Custom fields

Custom fields are identified by a 40-char hash key (e.g.
`583f4da237dd96220c7f4f57c88332635e52cd27`). Definitions and option **labels** come from
either version - `GET /api/v2/{entity}Fields` (custom fields under `field_code`, label under
`field_name`, companions nested in `subfields`) or `GET /v1/{entity}Fields` (custom fields
under `key`, label under `name`). Only v1 also returns the **numeric** field id and option
ids, which filter conditions need.

- **Set / multi-option** fields: array of integer option ids in v2, e.g.
  `{"<hash>": [884, 891, 923]}`. Comma-separated strings return a 400.
- **Enum** fields: a single integer option id (or string value, depending on the field).
- **Phone-type custom** fields: a **plain string**, NOT the array-of-objects
  `[{"value","primary","label"}]` shape used by the native person `phones` field. Sending
  the array returns `400 ERR_SCHEMA_VALIDATION_FAILED`.

## Modifying field options (append safely)

`PUT /v1/{entity}Fields/{id}` with `options` **REPLACES all options** - it does not
append. Sending only the new option **destroys every existing option** (and their ids,
breaking every record that referenced them). Always GET, append, then PUT the full list:

```bash
# 1. GET current options
OPTIONS=$(curl -s -H "x-api-token: $TOKEN" \
  "https://api.pipedrive.com/v1/personFields/132" | jq '.data.options')
# 2. Append
NEW_OPTIONS=$(echo "$OPTIONS" | jq '. + [{"label": "New Option"}]')
# 3. PUT the full list back
curl -s -X PUT -H "x-api-token: $TOKEN" -H "Content-Type: application/json" \
  "https://api.pipedrive.com/v1/personFields/132" \
  -d "{\"options\": $NEW_OPTIONS}"
```

## Field-observed behaviors (production, API v2)

Behaviors observed in production against API v2 (mid-2026) while building a two-way sync,
most either undocumented or documented less specifically. Instance-specific details have been
stripped. Pipedrive ships behavior changes without changelog entries, so re-verify against a
current sandbox before encoding any of these as a hard rule.

### Custom-field value shapes (don't infer from the native field)

A wrong shape returns `400 ERR_SCHEMA_VALIDATION_FAILED` naming the expected type.

- **`time`** custom fields take an **object**: `{"value": "HH:MM:SS"}`; a bare `"14:30:00"`
  is rejected. (The `phone` and set/multi-option shapes are covered under "Custom fields" above.)
- **Timezone:** date/time values are stored and returned in the **account's** timezone, with no
  offset echoed back. Normalize before diffing a stored time against a UTC source.

### Native vs custom is a *placement* fork, not just naming

A 40-hex key goes inside `custom_fields`; anything else is a **top-level** payload property.
Getting this wrong **fails silently** - the write returns success and the value lands nowhere.
Prefer the native target where one exists (it drives UI features the custom shadow doesn't):
person address -> native `postal_address` (an object); phone/email -> native `phones`/`emails`
arrays. Audit any mapping layer for custom fields that shadow a native field.

### Reads omit fields; omitted is indistinguishable from unset

See "Reading custom fields on a person" above for the mechanics. The trap: a field you forgot
to request reads empty, so a **read-modify-write** concludes "unset" and overwrites a real
value. Any RMW against v2 needs an explicit field list - `?custom_fields=<hash>,<hash>` for
custom fields and `?include_fields=<name>` for omitted native ones (e.g. `marketing_status`).

### `source_lead_id` (the lead→deal link) lives only on the v1 deal

The lead a deal was converted from is recorded as `source_lead_id`, but it is returned **only
by the v1 deal** (`GET /v1/deals/{id}`) - **v2 omits it entirely**. Because v1 deal endpoints
are on the retirement list, a recurring/scheduled scenario must **not** read it from v1.

**Migration pattern (touch v1 exactly once):** copy `source_lead_id` into a custom **Text**
field in a single backfill pass over the affected deals, reading from v1 just for that one run.
The ongoing scenario then reads the custom field from **v2** and never calls a v1 deal endpoint.
Only lead-sourced deals get a value - deals created directly stay blank, which is correct, not
missing data. (Verify the custom field's key against the drift check like any other.)

### Enum options: resolve case-insensitively, fail on a miss

Option labels must match exactly on the wire, but source systems disagree on casing (`TSgt`
vs `TSGT`). Normalize `lower(trim(...))` on both sides. On an unresolved label, **omit the
field** (record writes) or **raise a clear error** (filter conditions) rather than sending the
raw string - a bad value 400s the request or writes garbage. `filters ensure` in this repo now
does exactly this. Any option-id lookup table also goes stale when someone edits options in the
UI - which is what the drift check is for.

### Deals: two rules that only bite on update (invisible to create-only integrations)

- A deal with a **product attached** rejects native `value`/`currency` updates
  (`ERR_DEAL_WITH_PRODUCTS_CANT_UPDATE_VALUE`) - the product line owns the amount. Set
  `value`/`currency` **create-only**; carry the figure in a custom field for updates.
- **Archiving is a field update:** `PATCH /api/v2/deals/{id}` `{"is_archived": true}`. There is
  no archive endpoint.

### Notes (v1): no client key, but updatable by id

There is no upsert and no client-supplied idempotency key, so a naive re-sync duplicates every
note. But `PUT /v1/notes/{id}` edits in place, so **persist the returned note id** against your
own record and update on later syncs. Fallback when the id wasn't stored: list the parent's
notes, delete the ones you wrote (matched on a marker you control in the body), re-create - 3+
calls, briefly note-less, fragile. Notes can be **backdated** via `add_time`
(`"YYYY-MM-DD HH:MM:SS"`). **Generalizable:** for any child object with no natural key (notes,
activities, files), capture the id the create call returns and store it - retrofitting later is
a list-and-match migration.

### Deletion semantics

- **Person deletion is a soft delete** - the record still reads back with `is_deleted: true`
  (the reliable way to confirm a bulk delete actually completed).
- **Deleting a person does not delete their deals** - they survive as orphans with a dangling
  `person_id`. On any restore, **rewire the existing deal** (a `PATCH` carrying the new
  `person_id`) rather than creating a replacement, or every restore doubles the deal count.

### Webhooks: merges arrive as delete + change (system-of-record consumers)

A merge emits a **`delete` on the loser** and a **`change` on the winner** - there is no
`action: "merge"`, so code branching on one is dead code. The linkage is in the event `meta`:
`merged_to_id` (loser) / `merged_from_id` (winner). Miss it and you keep references to deleted
ids -> a permanent 404 loop on later writes. API-performed merges are attributed to **your own
API user**, so a self-echo guard (`change_source == "api" AND user_id == <ours>`) eats both
events - exempt any event carrying a merged id. Separately, `marketing_status` is **absent from
person webhooks entirely** and is **billed per subscriber**, so a GET-before-write is mandatory
and it is a state machine, not a boolean (never overwrite `unsubscribed` / `bounced` /
`pending_upgrade`).

### Bulk / backfill

Every field backfill is one write per record. **Hash the outbound payload and skip unchanged
records** so a full re-sync only touches genuinely-changed rows; for a new field on a large
population, **passive convergence** (fill as each record next changes) often beats a bulk pass.
Drive batches from a resumable queue with per-record error isolation, not a single "walk
everything" pass that aborts on one transient error.

### Coverage gaps

- **No public Campaigns API** - per-campaign aggregates come only from the internal insights
  gateway behind a per-report hash: unversioned, undocumented, and dead the moment that shared
  report is regenerated. Treat anything built on it as a scrape and isolate it.
- **No suffix / post-nominal field on persons** by default - create the destination field first
  if a source system carries one.

## Rate limiting

Pipedrive uses token-based rate limiting per company; v2 endpoints cost ~50% fewer tokens
than their v1 equivalents. Watch the response headers and back off as you approach the
limit:

- `x-ratelimit-remaining` - requests left in the current window
- `x-ratelimit-reset` - seconds until the window resets

**It fails quietly.** Under a burst, requests can come back **empty rather than erroring** (an
empty HTTP-200 body, not a 429). A tight verification loop after a batch of writes then reports
"nothing landed" when everything landed - a false negative that invites a destructive re-run.
Space verification reads (~1.5s between calls was enough in practice), prefer your **own
persisted state** as the success signal, and treat Pipedrive reads as confirmation of a sample.
`pipedrive-sync.mjs` reads these headers in its HTTP helpers and pauses when the window is
nearly spent.

## References

- [Deprecation of selected API v1 endpoints](https://developers.pipedrive.com/changelog/post/deprecation-of-selected-api-v1-endpoints)
- [API v2 migration guide](https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide)
- [API reference](https://developers.pipedrive.com/docs/api/v1)

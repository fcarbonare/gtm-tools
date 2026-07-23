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
  stages, activities), plus Projects (boards, phases, fields). Set / multi-option fields
  expect an **array of integer option ids** (e.g. `[117, 234]`), not a comma-separated
  string. Cursor pagination (`limit` up to 500, `cursor`).
- **v1** (`/v1/`): the endpoints with no v2 successor yet - field definitions, filters,
  activity types, notes, users, recents, merge, undelete, and the project
  templates/tasks/plan endpoints. Field-definition endpoints return everything in one
  response (offset pagination where paginated at all).

### v1 CRUD deprecation - use v2 for anything CRUD

Pipedrive is [retiring the v1 CRUD endpoints](https://developers.pipedrive.com/changelog/post/deprecation-of-selected-api-v1-endpoints)
for **activities, deals, persons, organizations, products, pipelines, stages, and
itemSearch** - every verb, including `GET /v1/persons/{id}`. The changelog states
**December 31, 2025**; partner-facing notices have since quoted **July 31, 2026**. Treat
them as gone and target `/api/v2` for all of these entities.

**Do not reintroduce a v1 CRUD call**, including for one-off debugging.

The v1 calls that legitimately remain (no v2 successor):

| Still v1 | Why |
|---|---|
| `/v1/{entity}Fields` | v2 has no field-definition endpoints |
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
`583f4da237dd96220c7f4f57c88332635e52cd27`). Definitions, keys, and option ids come from
`GET /v1/{entity}Fields`.

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

## Rate limiting

Pipedrive uses token-based rate limiting per company; v2 endpoints cost ~50% fewer tokens
than their v1 equivalents. Watch the response headers and back off as you approach the
limit:

- `x-ratelimit-remaining` - requests left in the current window
- `x-ratelimit-reset` - seconds until the window resets

## References

- [Deprecation of selected API v1 endpoints](https://developers.pipedrive.com/changelog/post/deprecation-of-selected-api-v1-endpoints)
- [API v2 migration guide](https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide)
- [API reference](https://developers.pipedrive.com/docs/api/v1)

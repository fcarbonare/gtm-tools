# Reading and validating automations over the API

Reference for the `pipedrive-config-sync` skill, which reads and mirrors every Pipedrive entity
over the API — automations included. The `pipedrive-sync.mjs automations` subcommand implements
the mirror recipe below; this doc is the API knowledge behind it and the audit recipes for the
result. **Designing, scoping and validating the automations themselves is the separate
`pipedrive-automations` skill** — this file is only about how to read them.

Native automations **are** readable. The endpoint is undocumented and is not the one the
name suggests, which is why it is widely believed to be missing.

Everything here was proven against a live Pipedrive account on **21 August 2026**. It is
undocumented, therefore unsupported, therefore it can change. Carry the date when you cite
it, and re-check before you build tooling that depends on it.

## The path that does not exist, and the one that does

| Path | Result |
|---|---|
| `GET /api/v1/automations` | 404 |
| `GET /api/v2/automations` | 404, or the app's HTML shell |
| `GET /v1/workflows` | 404 |
| **`GET /api/v2/automation/workflow`** | **the list** |
| **`GET /api/v2/automation/workflow/{uuid}`** | **the full definition** |

Singular `automation`, then `workflow`. A 404 on a guessed path is evidence about the guess,
never about the platform.

**How to find an undocumented endpoint.** Open the feature in the browser with the network
panel recording, then read the XHR the page fires. Every screen in Pipedrive is backed by one.
That is how the path above was found, after the guessed ones had been recorded as proof of
absence for weeks.

## Authenticating

Ordinary API token, in the header, never as a query parameter:

```bash
set -a && . ./.env.local && set +a     # PIPEDRIVE_API_TOKEN=...
curl -s -H "x-api-token: $PIPEDRIVE_API_TOKEN" \
     "https://{company}.pipedrive.com/api/v2/automation/workflow?limit=200"
```

The account-scoped host **`https://api.pipedrive.com/api/v2/automation/workflow`** also works with
the same token, with no company subdomain (verified 2026-08-21). That is the form
`pipedrive-sync.mjs automations` uses, so it stays project-agnostic.

The token is per user. It returns every automation on the account, including other people's,
which the UI list does not do by default (see the filter trap below).

**A shell gotcha that eats the token.** An unquoted value with a space anywhere in `.env.local`
makes `. ./.env.local` fail part way through, and `$PIPEDRIVE_API_TOKEN` silently ends up empty
or stale. Quote every value.

**Endpoints the token does not reach.** A few screens are backed by internal endpoints that want
the browser's `session_token` query parameter instead. Read those in a logged-in browser and
copy the URL out of the network panel. Treat that token as a credential: never print it, never
commit it, and prefer the API token wherever it works.

## What the list returns

```
{ success, data: { docs: [...], bookmark }, additional_data }
```

Note `data.docs`, not `data`. An empty `docs` with `success: true` means the filter excluded
everything, not that the account is empty. Per record:

`uuid`, `rev`, `name`, `description`, `ownerId`, `context`, `triggerResourceId`,
`triggeredBySelfOnly`, `tags`, `accessList`, `metadata`, `lastUpdateDate`, `lastUpdateUserId`.

**`context` splits two different things sharing one endpoint.** `context: "automation"` is a
workflow automation. `context: "automatic-assignment"` is the separate Automatic assignment
tool, whose record has a literal string for a uuid rather than a real one, and which the
automations list screen never shows. Filter on `context` or you will miscount.

**`accessList` is per-user subscription, not on/off.** Each entry is
`{id, subscription: {enabled}}`. It is not the same number the list screen shows in its `x/y`
column, which uses a wider denominator for company-wide shares. Do not derive "active" from it.
For the real count use the usage cap endpoint below.

## What the single record returns

Everything the list returns, plus `createdDate`, `createdUserId`, `rootStep`, `steps` and
`dynamicRegistry`. This is the complete definition. There is nothing the UI shows that is not
in here.

**`steps`** is a map of `stepId` to step, and **`rootStep`** names the entry point. Walk it by
following `nextStepId`. Step types seen live:

| `type` | Carries |
|---|---|
| `trigger` | `event.resourceId`, and `configuration.triggerFieldResourceIds`, the "on change of these fields" list |
| `date-trigger` | `configuration.recurrence` (frequency, time, **timezone**) and `filterByDateField` (which date field, offset, direction, window) |
| `condition` | `conditionSets`, plus `nextStepId` and **`fallbackStepId`**, the else branch |
| `sequential-condition` | `conditionSteps`, first match wins |
| `action` | `action.resourceId` and `action.inputs` |
| `delay` | `spanConfiguration`: unit, amount, `skipWeekends`, timezone |
| `refresh-resources` | re-reads the record after a delay |

**Follow `fallbackStepId` or you will read half the automation.** A three-way branch looks like
a two-step chain until you walk the else paths.

**`dynamicRegistry.eventFields` decodes the hashes.** Each entry carries the field `label`, its
`valueType`, and for enums the full `options` array with ids and labels. A definition is
therefore self-describing: you can name every field and option without touching the fields
export. Cross-check against the export anyway, because a label in the registry is a snapshot
from when the automation was saved.

**Operands.** A condition's `leftOperand` is usually
`dynamic-event-field@deal:currentState/{40-char-hash}` for a custom field, or
`event-field@deal:currentState/{name}` for a native one. `:previousState` reads the value before
the change. Action inputs are lists of `{type: "value", inputValue}` or
`{type: "resource", resourceId}`.

**Unwrap `resourceType: "refresh"`.** After a delay step, an input can be
`{type: "resource", resourceType: "refresh", stepId, resource: {...the real operand}}`. A reader
that only handles the flat shape renders these as empty and will report a working automation as
broken. This mistake has been made.

## Which rules have actually fired

```
GET /api/v1/automation-execution-history/executions?limit=50
```

Returns `{total, bookmark, items[]}` with `name`, `workflowUuid`, `state`, `startDate`,
`endDate`, `stateReason`, `triggeredBy`, `triggerEntityType`, `triggerEntityId`. The `state`
query parameter takes a fixed vocabulary and rejects `all` with a 400; omit it to get
everything. Retention is limited, so `bookmark` is the oldest run still held, not the beginning
of time.

**This is the difference between wired and working.** A definition proves what a rule would do.
The history proves whether it has ever done it. Use it before reporting an automation as
harmful or as verified.

`state: "completed"` means every step ran without error. It does not mean an email arrived.

**`triggeredBy` on a scheduled trigger** resolves to the automation's own user, so a
`fromAccountId: trigger-user` mail step does have a sender on a date-triggered rule. Proven by
one completed scheduled run, 21 August 2026.

## The ceiling, without guessing

```
GET /v1/usage-caps/features/automation_active_workflows
```

Returns `{cap, usage, isCapped, canIncreaseCap, hasPlanUpgrade}`. This is the authoritative
active count and ceiling, and it beats both the published plan table and counting rows yourself.

Pipedrive has been observed showing a banner warning that an account is "over the new company
limit" while the same page reports usage far under the cap. Report both readings and resolve
nothing by inference.

## Everything else a definition points at

A step's inputs reference ids that mean nothing on their own. Resolve them before you claim to
know what a rule does:

| Id in the definition | Resolve with |
|---|---|
| `stage_id`, `pipeline_id` | the config-sync mirrors |
| option ids on enum conditions | `dynamicRegistry`, or the options export |
| `template: {n}` on a mail step | `GET /api/v1/mailbox/mailTemplates` for the list, `/{id}` for name, subject and body |
| lead label uuids | `GET /api/v1/leadLabels` |
| `user_id`, `ownerId`, assignment targets | `GET /api/v1/users`, and check `active_flag` |
| `type` on an activity step | the activity types mirror |

**Read the mail template body, not its name.** A template called "Reminder to X" has been found
being sent to Y. The name is the author's intent; the body's salutation is the evidence.

**Check `active_flag` on every user id a rule writes.** Assignment rules pointing at a
deactivated user look completely healthy in the UI.

## The list screen defaults to "Owned by me"

`/settings/automation/list` filters to the current user. On an account where one consultant
built everything, it renders "No automations found" for everyone else and reads as an empty
account. Use `?owners=user_others`, or read the API, which has no such default.

## Recipes

**Inventory, with a diffable mirror.** The **`pipedrive-sync.mjs automations`** subcommand implements
this: it fetches the list, fetches each uuid, and writes one JSON file per automation plus an
`index.md` / `index.json` into `<mirror>/automations/`. `automations --write` refreshes the mirror;
the plain `automations` run is the drift check and exits non-zero when the mirror is stale, which
turns it into a pre-build gate. It strips inline credentials before anything reaches git, and
degrades rather than failing when the optional webhook lookup is unavailable. Read-only: it never
creates, edits or deletes an automation.

**Which automations touch this field?** Grep the mirror for the 40-character key. This answers
"is it safe to delete or rename this field" in one command, and it is the only reliable way,
because the automation UI has no usage view.

**Are we reading a duplicate field?** When an account has two fields with the same label, grep
the mirror for both keys. Automations referencing the empty twin are otherwise invisible.

**Audit a rule you did not build.** Walk the steps, resolve every id, then read the execution
history for its uuid. Report trigger, conditions, actions, recipients, and whether it has ever
run. That is a specification. A name and a description are not.

## Writing is untested

Reads are proven. `POST`, `PUT` and `PATCH` on `/api/v2/automation/workflow` have **not** been
tested, deliberately: the only accounts available were live client environments, and a failed
write to an automation set is not a cheap mistake. `[VERIFY]` on a throwaway account before
assuming an automation can be created or edited programmatically.

Until then, treat the API as read-only: build in the UI, mirror by API, diff in git.

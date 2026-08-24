# Capability Map

What a native Pipedrive automation can and cannot express. Each row carries how it was established, because "not offered in the UI" and "impossible" are different claims and only one of them is safe to write down.

Status key: **proven** means tested live in an account in August 2026. **published** means Pipedrive's own documentation. **unproven** means neither, and it is the next thing to test rather than a fact to design around.

## Cross-object writes

**Automations traverse many-to-one, never one-to-many.** Full matrix in the SKILL. The short version: a Deal may write to itself, its Organization and its Person. A Person may write to its Organization. Nothing writes to a collection.

**Status: proven.** Found in the UI. The one-to-many actions are not offered at all, so this fails at design time rather than at runtime.

**The trap this closes:** a rule recorded as "read a linked Organization's field and write it to a Deal field" is two capabilities. The read is real; the write is not. Verify a capability in the direction you intend to use it.

## Reacting to an event on another object

| Want | Native answer | Status |
|---|---|---|
| Organization changes, Deal must react | Deal-triggered automation binds the Org, then `wait for condition` | **proven** |
| Person changes, Organization must react | Person-triggered automation writes to `Person organization` | **proven** |
| Organization changes, its Persons must react | None | not offered in the UI |
| Any object changes, all its Deals must react | None | not offered in the UI |
| A second, later change on an Organization with no deal event of its own | None natively | not offered in the UI |

**The wait step, three undocumented properties, all proven:**

1. The Organization is selectable as a wait target only after an earlier step interacts with it. Bind with an `Update organization fields` step on `Deal organization`; later steps address it by that step's number.
2. The wait re-fetches. `Data fetching successful` appears in the log after the condition passes, and subsequent steps read post-change values. One wait serves many later reads.
3. The wait fires on an **update event**, not on current state. Already-satisfied means expired, not passed.

**Wait step limits, published:** maximum 7 days per wait step. Three wait steps per automation on Advanced, ten on Professional and above.

**Design consequence.** One gate automation carries the wait and ends with a stage change. Every downstream rule triggers on that stage change, so a single wait serves the whole model instead of one per rule.

## Branching

**`IF/ELSE CONDITION` exists**, with `CONDITION MET` and `CONDITION NOT MET` paths. **Status: proven**, nested at least five levels deep in a single automation.

This was asserted three times to be impossible during one build. It is not.

**What branching buys.** Every set of mutually exclusive rules collapses into one automation. A four-outcome cascade needs three levels of nesting. Order the branches **highest tier first** so a matched branch never falls through into a lower one.

## Filters as conditions

**A filter can be an automation condition** (`Filter matches`), and **a deal filter can carry conditions on a linked Organization or Person**. **Status: proven.** The condition shape is `{"object": "organization", "field_id": N, "operator": "...", "value": ...}` inside a deals filter.

> **Filters have an API. Automations do not.**

Every condition moved into a filter becomes readable, diffable, reviewable, and rebuildable from a declarative file. This is the single highest-value structural decision in a Pipedrive automation build.

**Filter condition trees are exactly two flat groups**, one `and` and one `or`, evaluated as `(and) AND (or)`. **Status: proven** by a 400 response: `body/conditions/conditions/1/conditions/0 must have required property 'object'`. There is no nesting, so anything needing real boolean structure must be precomputed into a field first.

**The automation condition builder does nest**, unlike the filter tree, so an N-of-M gate *could* live inline as every qualifying pair joined by OR. Precompute it into one field anyway: inline logic is neither reviewable nor reportable, and a precomputed field can be filtered, grouped and charted.

**Enum conditions support `=` only**, so "is one of A, B" belongs in the `or` group with shared constraints in the `and` group.

## Counting and aggregation

| Want | Native answer | Status |
|---|---|---|
| Count related records (contacts on an account, deals on an org) | **None.** Precompute one Yes/No flag per category instead | not offered in the UI |
| "At least N of M flags are Yes" as a filter condition | **None.** Filters cannot express N-of-M | proven, by construction |
| "At least N of M" as an automation condition | Precompute it into a single field, then filter on that field | **proven** |
| Rolling time window ("3 contacts engaged within 30 days") | **None**, in Pipedrive or in a typical enrichment vendor's scoring | not offered in either |

**The pattern that works.** One flag per category, each set by a many-to-one write. Testing how many flags are set is equivalent to counting distinct categories, and it delivers exclusions for free: a value matching no branch sets no flag and therefore scores nothing.

**Then precompute the gate.** A second automation writes a single `gate met` Yes/No field when the N-of-M condition holds, and the filter tests that one field. This is what makes an N-of-M gate reviewable.

**Flags do not clear themselves.** Changing the source value does not lower a flag already set, and a change can set a second flag while the first remains. Accept for a first build, plan it into data hygiene.

## Formula fields

**Published constraints:**

- **Deal only.** "Although formula fields are created using lead or deal custom fields, they only calculate values in deals."
- **Numeric or monetary deal fields only** as inputs. No conditionals, no cross-object inputs.
- **One empty input blanks the whole result**, permanently and silently, with the message `not calculated`.
- **Ten per account.**
- Recalculation triggers: formula created or edited, deals created, or an input field edited.
- Requires Premium or above.

**Unproven and worth ten minutes before designing on it: does an automation write count as an edit for recalculation?** Test it with a throwaway numeric input field, a formula doubling it, a manual set to confirm the formula works, then an automation write. If the output does not move, the fallback is the deal list view's **Recalculate if input is changed** and **Force recalculate** bulk actions, which turn a live score into a periodic manual refresh. Delete both test fields either way.

**Two settings that are easy to get wrong:**

- The dialog defaults to **"apply formula to only new deals."** Choose **new and open deals**, or the value computes once at creation and never revisits.
- **A plain numerical field cannot be converted to a formula field.** Delete and recreate under the same name, which is only safe while no record carries a value.

**Zero-initialise every component.** An automation writing "0 points" is not the same as an automation not firing, and with several components summed, one blank blanks every record.

## Account limits

**Published, per company:** Growth 50 automations, Premium 150, Ultimate 250.

**Ask the account, do not read the table.** The real cap and usage for the plan actually in force
come from `pipedrive-config-sync` (its usage-caps read; see reading-automations.md there) — the
authoritative number, one request, rather than the published table. Proven 21 August 2026.

**The banner has been seen to disagree with the cap**, warning on two separate accounts that they were
"over the new company limit" while the same page reported usage far under it. On one of them the change was
dated to a billing cycle a year out, when the limit moves from per seat to per company, and the new company
number was published nowhere. Report both readings, resolve nothing by inference, and carry the
per-seat-to-per-company change into any handover: it is a renewal conversation, not a build constraint.

## Where the boundary is

Native automations are the right home while the rule stays inside the matrix above. Leave native when the rule needs any of:

- A write into a one-to-many collection
- Counting or aggregating related records at query time rather than by precomputed flag
- A rolling time window
- Fill-empty-only semantics against an integration that has no such mode
- Anything an integration refuses to sync at all

Those belong in a scheduled script against the REST API. Record the choice in the registry, because the reason a rule left native is the first thing the next person will ask.

## What integrations can reach

A CRM integration that syncs **Persons and Organizations only** can never touch a Deal, a stage, or an activity, whatever the automation design. Combined with the cardinality rule, that means **nothing on the integration side can push to a Deal**. The Deal has to go and fetch it with bind-and-wait.

Check the vendor's own documentation for the list of objects it refuses to sync, and treat it as permanent. Also check whether the integration has a **fill-empty-only mode**; many do not, and then the only governance lever is whether a field is mapped at all. Mapped means the vendor overwrites; unmapped means it never writes. "Write only when empty" requires the script route.

# Condition Traps

How Pipedrive evaluates a condition, and the places it does not do what the wording says. Every entry here cost a real fix.

These are silent failures. The automation shows as active, the history log shows steps running, and the rule does nothing or the wrong thing.

## Empty is not No

**Pipedrive has no boolean type.** A Yes/No field is a Single option enum with two options. A field nothing has ever written is **empty**, which is a third state.

| Condition | Matches empty | Use it for |
|---|---|---|
| `is Yes` | No | Testing that something was affirmatively set |
| `is No` | **No** | Almost nothing. This is the trap |
| `is not Yes` | **Yes** | Testing that something is not affirmatively set |

**Never write a condition as `is No`.** It will not match the records that have never been touched, which on a fresh account is all of them.

Two ways out, and they compose:

- Write the condition as **`is not Yes`**, which treats empty and No identically.
- **Default the flags on creation**, so a human reading the record sees explicit `No` values rather than blanks. This is readability, not correctness, and it makes a good bind-step write.

**Default fields are also the fix for a blank formula**, where an unwritten numeric component blanks the entire result.

## A short token matches inside longer words

`contains` is a substring test with no word boundaries. This failed in both directions in one build and cost four separate fixes.

| Wrote | Matched | Should have been |
|---|---|---|
| `contains CTO` | `Postdoctoral Researcher`, `Doctoral Candidate` | `is CTO` |
| `contains IT director` | `Audit Director`, `Unit Director`, `Credit Director` | `is IT Director`, plus `contains director of IT` |
| `contains engineer` | every engineering leader, swallowed into the wrong branch | catch the seniority terms in an earlier branch |
| `contains CTO` (only) | nothing, for `Chief Technology Officer` | add the spelled-out form as its own `contains` |

**The rule:**

> **`is` for abbreviations and single words. `contains` only for multi-word phrases that cannot appear accidentally inside another value.**

**Both directions fail.** A short token over-matches, and an abbreviation-only test under-matches the spelled-out form. Cover both.

**Verify against a case set, not against intuition.** Write down fifteen to twenty real values, including the ones that should match *nothing*, and walk each through the branches. The `Postdoctoral Researcher` case was the serious one: it landed in the top tier, and it is high-volume in exactly the segment the model was meant to score down.

**Accept some residuals explicitly.** `Head of Italy` still matches `head of IT`. Record it in the registry so nobody rediscovers it as a bug, with the reason it is tolerable.

**Order the branches highest tier first.** A cascade where a matched branch never falls through is what stops a catch-all term from swallowing everything above it.

## Comma-separated list fields

An enrichment vendor writing a technology stack or similar writes one comma-separated string. `contains` is the only viable operator and **noise is expected**. Design the rule to tolerate a false positive rather than to be exact.

## Triggers

**Watch named fields, never "any field updated."** A rule that writes to a deal re-triggers every other rule watching that deal, and they chain into each other until the frequency limit stops them.

**Scope every rule with a stage or pipeline check**, even when the trigger looks specific enough. Without it a rule fires on records created directly into other stages or other pipelines, which is what an import or a manual entry does.

**Two rules triggered by record creation race.** If rule B checks a state that rule A sets, B may evaluate before A writes. Fix it by making B trigger on the *stage change* A performs, not on creation.

**Trigger on the second source too.** A rule watching only a user-entered field never fires when an integration populates the record another way. Add the integration's own provenance field (an enrichment date, an external id) to the watched list.

**A field that transitions once can only be waited on once.** An external id that never returns to empty means the empty-to-populated event happens exactly once per record, forever. Any rule depending on that transition needs a companion for records that already have it, and the rule stamping it must never be deactivated, because the transition cannot be replayed.

## Filters used as conditions

**Visibility.** A filter created owner-only silently narrows an automation that runs for everyone. Set it to the entire company and check this on every filter used as a condition.

**Numeric field ids, not hash keys.** Filter conditions carry a numeric `field_id`. Grepping a filter definition for a 40-character hash finds nothing and hides a broken filter. Expand the conditions and read `field_id`.

**There is no "current user" filter.** A filter scoped to owner "me" silently matches nothing. Build state-based filters plus an explicit owner selector.

**Two flat groups only**, one `and` and one `or`, evaluated as `(and) AND (or)`. No nesting. Anything needing real boolean structure gets precomputed into a field first.

**Test the negative case.** Creating a filter proves the syntax parsed. It does not prove the filter excludes what it is supposed to exclude. Set the flag on a test record, confirm it drops out of the filter, then restore the record.

## Time

**The timezone is inherited from whoever built the rule**, not from the client. An account's country setting is an artifact of whoever created the account and is not evidence of where the client is.

Pin the client's timezone explicitly on every activity, due date, and scheduled job. An hour of drift is enough to move a due date across a day boundary.

**Day counting inherits the same timezone**, so stalled-deal and rotten-deal thresholds drift with it.

**Reconcile flat thresholds against per-stage thresholds.** A flat 7-day stalled alert and a per-stage rotten threshold of 5 days disagree by design: the record is rotten in the list view and silent in the alert. Pick one, or state that the alert is approximate.

## Reads reflect the reader

An API read is rendered for the token owner, not for the client.

The canonical case is revenue: a goal set in one currency comes back converted into the *viewing user's* profile currency, so a GBP target reads as an EUR number and looks like a misconfiguration. **Do not diagnose a configuration fault from an API read alone.** Check it in the UI as the client sees it.

The same caution applies to any value that could be locale-rendered before you compare it to a specification.

## Verifying a field before you reference it

**A field key is only real if it appears in the live field list.** Option values can linger for fields that have already been deleted, so an option found in an options export is not evidence the parent field exists. Cross-check both.

**A failed API request can return an HTTP-200-shaped body with `success: false`.** A script that reads the payload without checking `success` prints empty for every field and looks exactly like a clean "nothing configured" result. Check `success` before believing a negative.

**Under a burst, an empty HTTP-200 body can arrive instead of a 429.** Same failure mode: it reads as "nothing exists".

## Verifying the automation itself

Verification is two layers, and skipping either is how a broken rule ships.

**First, validate the definition against the plan.** Mirror the rule you just built with config-sync
(`pipedrive-sync.mjs automations --write`) and read its definition back, item by item, against the spec
you wrote before building: trigger and watched fields, every condition and operator, each action and the
object it writes to, and the resolved recipient / stage / webhook ids. The build is done only when the
mirror matches the plan. A `contains` where the plan said `is`, a wait on an already-set field, or a write
aimed at the wrong object is visible here — before it ever runs.

**Then confirm behaviour** by inspecting the records the automation left behind:

- Did the field actually change, on a record you can name?
- Does the history log show each step, and does the wait show `Condition passed` rather than `Expired`?
- Sweep deal titles for `(copy)`, the fingerprint of a duplicate-deal rule nobody meant to leave on.
- The committed mirror + git diff is the durable record of what shipped; a screenshot of the step list is a useful supplement, not the only record any more.

**"I built it" is not verification.** Neither is "the automation is active". The mirror matching the plan, and the record actually changing, are.

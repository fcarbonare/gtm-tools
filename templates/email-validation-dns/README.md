# Make scenario — Email validation via DNS/MX (webhook)

A Make.com scenario blueprint that validates an email address over a **webhook** and
returns a JSON verdict, for use as a **pre-screening** step other automations call. It
mirrors the n8n "website check" pattern (webhook in → syntax gate → external check →
branch → respond) but checks **email deliverability by resolving the domain's MX records
over DNS-over-HTTPS**, with a **5-second timeout on the primary resolver (Google) and an
automatic fallback to Cloudflare** — no third-party validation service, no API key.

File: [`email-validation-dns.make-blueprint.json`](./email-validation-dns.make-blueprint.json)

## What it checks

1. **Syntax** — the address has one `@` and the domain part contains a `.`. Malformed
   input returns `400` and never hits DNS.
2. **Deliverability signal** — a DoH MX lookup for the domain. A domain with MX records
   can receive mail; one with none (typo domain, parked/dead domain, fake domain) is
   flagged undeliverable.

It does **not** verify that the specific mailbox exists (that needs an SMTP probe, which
most providers rate-limit or blackhole) — MX presence is the standard cheap pre-screen
that removes the bulk of bad addresses.

**Null MX (RFC 7505).** A domain can publish a single `MX 0 .` record to declare it accepts
no mail (`example.com` does this). This scenario counts any MX answer as deliverable, so a
null-MX domain reads as `mx_records`. It's uncommon among addresses worth pre-screening; to
exclude it, tighten the "has MX" check to require the answer isn't `.` / `0 .`.

## Resolver + fallback

- **Primary: Google** `https://dns.google/resolve` with a **5s timeout** (DoH normally
  answers in <0.5s; the short timeout bounds the wait so a hung request fails fast rather
  than hanging the synchronous webhook — the module default is 300s).
- **Fallback: Cloudflare** `https://cloudflare-dns.com/dns-query` (header
  `accept: application/dns-json`). It runs **only when Google errors or times out**
  (an `onerror` Resume lets the flow continue, and a router branch routes to Cloudflare).
- The response `source` field reports which resolver answered (`google` / `cloudflare`).

## Webhook contract

**Request** — send the address as `email`, either as a query param (GET) or JSON body
(POST); Make merges both into the trigger bundle:

```
GET  https://hook.<zone>.make.com/<hook-id>?email=jane@acme.com
POST https://hook.<zone>.make.com/<hook-id>     {"email": "jane@acme.com"}
```

**Response** — always JSON (`Content-Type: application/json`):

| HTTP | `reason` | Meaning |
|------|----------|---------|
| `200` | `mx_records` | Domain has MX records — deliverable. `valid: true`. |
| `200` | `no_mx_records` | Domain resolved but has no MX — undeliverable. `valid: false`. |
| `400` | `invalid_syntax` | Not a well-formed address; DNS was not queried. `valid: false`. |

```json
{ "email": "jane@acme.com", "valid": true, "reason": "mx_records", "dns_status": "0", "source": "google", "checked_at": "2026-08-13T10:00:00.000Z" }
```

Consumers should branch on the `valid` boolean (a completed check is `200` whether or not
the address is deliverable; `400` means the caller sent bad input). `dns_status` is the DoH
response code on the Google path (`0` = NOERROR, `3` = NXDOMAIN); it is blank on the
Cloudflare-fallback path. `source` is `google` or `cloudflare`.

## Flow

```
Webhook (email in) → Router: Syntax gate
  ├─ valid syntax → HTTP: Google DoH MX (5s timeout; onerror → Resume) → Router: provider + MX result
  │     ├─ Google Answer exists            → 200 · deliverable  (source: google)
  │     ├─ Google ran, no Answer            → 200 · no MX        (source: google)
  │     └─ Google failed/timed out → HTTP: Cloudflare DoH → Router
  │            ├─ body contains "Answer"    → 200 · deliverable  (source: cloudflare)
  │            └─ no "Answer"               → 200 · no MX        (source: cloudflare)
  └─ malformed → 400 · invalid_syntax
```

Every response is on a **separate router route** so exactly one fires per request (a filter
that blocks in a *linear* chain would stop the whole chain — hence the nested routers).

## Import & activate

1. **Import** the blueprint: Make → *Create a new scenario* → ⋯ menu → **Import Blueprint**
   → select the JSON.
2. **Attach the webhook**: open the first module (*Custom webhook*), **Add** a new webhook,
   copy its URL.
3. **Teach it the payload**: with the webhook listening, send one sample request carrying
   `email` (or *Redetermine data structure* and paste a sample) so `{{1.email}}` resolves.
4. **Scheduling**: leave it on **Immediately** (webhook/instant trigger).
5. **Activate** the scenario, then call the URL from your other automation.

## Verified live

Created and tested end-to-end in a Make **Pro** org (eu1 zone), both the Google path and the
Cloudflare fallback (forced by temporarily pointing Google at an unresolvable host):

| Path | Input | Response |
|------|-------|----------|
| Google | `test@gmail.com` | `200` · `{valid:true, reason:"mx_records", dns_status:"0", source:"google"}` |
| Google | nonexistent domain | `200` · `{valid:false, reason:"no_mx_records", dns_status:"3", source:"google"}` |
| Google | `notanemail` | `400` · `{valid:false, reason:"invalid_syntax"}` |
| **Cloudflare** | `test@gmail.com` | `200` · `{valid:true, reason:"mx_records", source:"cloudflare"}` |
| **Cloudflare** | nonexistent domain | `200` · `{valid:false, reason:"no_mx_records", source:"cloudflare"}` |

Module versions confirmed: `gateway:CustomWebHook` v1, `builtin:BasicRouter` v1,
`http:ActionSendData` v3, `builtin:Resume` v1, `gateway:WebhookRespond` v1. On import you
still **attach a webhook** and **send one sample** so `email` resolves downstream.

### Make gotchas baked into this design (learned the hard way)

- Make IML uses **`&` for AND** (not the word `and`), and evaluates **both branches of `if`
  eagerly** — so a reference to a conditionally-skipped module inside an unused `if` branch
  still throws. Provider selection is done with **router routes**, not `if`-coalescing.
- **A `WebhookRespond` inside an `onerror` route does not reach the caller** (returns the
  generic `Accepted`). The fallback response is produced in the **main flow**, not the error
  handler; the error handler only does `Resume` to let the flow continue.
- **`builtin:Resume` ignores its mapper** — it resumes with an *empty* output, so it can't
  carry the failed module's data forward. Cloudflare therefore runs as its own module.
- **Cloudflare returns `content-type: application/dns-json`**, which Make's `parseResponse`
  does **not** auto-parse. This blueprint reads Cloudflare's raw body and detects MX with a
  string check (`contains(toString(...); "Answer")`) rather than field access.
- In a **linear** flow a blocked filter stops the whole chain — so mutually-exclusive
  responses must each be on their **own router route**.

## Extending it

- **A-record fallback (RFC 5321).** A domain with no MX but a valid A record still accepts
  mail. To avoid rejecting those, add a `type=A` DoH lookup on the no-MX branch and treat an
  A answer as deliverable (`reason: a_record`).
- **Disposable / role-based filtering.** Add a filter comparing the domain against a
  block-list (mailinator, etc.) or the local-part against `info@`/`sales@` before the DNS
  step.
- **Both-provider corroboration.** For stricter checks, query both resolvers and require
  agreement instead of using Cloudflare only on Google failure.

# templates

Reusable document and config templates (SOPs, spec skeletons, Make.com scenario
blueprints, per-project config samples such as Pipedrive `filters.json` / `projects.json`,
and so on).

| Template | What it is |
|----------|------------|
| [`email-validation-dns/`](email-validation-dns/) | Webhook-triggered email validation that resolves the domain's **MX records over DNS-over-HTTPS** (Google primary with a 5s timeout, automatic **Cloudflare fallback**) and returns a JSON verdict — a pre-screening step other automations call. No third-party service or API key. Ships as a **Make.com** blueprint and an **n8n** workflow, both verified live. |

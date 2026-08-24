# gtm-tools

Reusable go-to-market tooling: Claude/Claude Code **skills**, plus **scripts** and
**templates** for running a modern sales and revenue-operations stack (Pipedrive,
Make.com, Apollo, CloudTalk, BigQuery, and friends).

The idea is one place for the tooling that would otherwise get copy-pasted between
client projects and drift out of sync. Skills here are **global** - install them into
`~/.claude/skills/` once and they work in any repo.

## What's inside

```
gtm-tools/
├── skills/                     # Claude Code skills (install into ~/.claude/skills)
│   ├── pipedrive-config-sync/  # read/verify/mirror live Pipedrive config + automations
│   └── pipedrive-automations/  # scope, plan + validate native Pipedrive automations
├── scripts/                    # standalone helper scripts (see scripts/README.md)
├── templates/                  # doc / config templates (see templates/README.md)
│   └── email-validation-dns/   # Make.com + n8n webhook: email validation via DNS/MX
├── docs/
│   ├── INSTALL.md              # install everything, or one skill at a time
│   └── pipedrive-api.md        # Pipedrive API reference + v1 CRUD deprecation policy
└── install.sh                  # one-command installer for the skills
```

## Skills

| Skill | What it does |
|-------|--------------|
| [`pipedrive-config-sync`](skills/pipedrive-config-sync/) | The skill that **reads, verifies and mirrors live Pipedrive over the API**. Drift-checks a project's `pipedrive/*.csv` mirrors (custom fields incl. Projects, options, pipelines, stages, activity types, boards, phases), refreshes them, creates deal filters and project boards/phases from per-project JSON, and mirrors native **workflow automations** read-only via the `automations` subcommand (`GET /api/v2/automation/workflow`, singular) so an inherited set can be diffed in git. Reads pipelines and stages from the v2 API - the v1 CRUD endpoints are being retired (see [docs/pipedrive-api.md](docs/pipedrive-api.md)). |
| [`pipedrive-automations`](skills/pipedrive-automations/) | **Scope, plan and validate** native Pipedrive **workflow automations** - the design knowledge, no API access of its own. Covers the cardinality rule (many-to-one writes only), bind-then-wait for cross-object events, `IF/ELSE` branching, filters-as-conditions, and the silent condition traps (empty≠No, `contains` substring matches, timezone drift). To read or mirror an existing set it defers to `pipedrive-config-sync` (`automations` subcommand); mirror there, judge here. |

## Templates

Reusable automation blueprints and config skeletons (see [templates/](templates/)).

| Template | What it is |
|----------|------------|
| [`email-validation-dns`](templates/email-validation-dns/) | Webhook-triggered **email pre-screening** — validates syntax, then resolves the domain's **MX records over DNS-over-HTTPS** (Google primary with a 5s timeout, automatic **Cloudflare fallback**) and returns a JSON verdict for other automations to consume. No third-party service or API key. Ships as both a **Make.com** scenario blueprint and an **n8n** workflow, both verified live end-to-end. |

## Install

Quickest - install every skill (symlinks, so `git pull` updates them in place):

```bash
git clone https://github.com/fcarbonare/gtm-tools.git
cd gtm-tools
./install.sh
```

Install one skill, or copy instead of symlink, or see verification steps:
[docs/INSTALL.md](docs/INSTALL.md).

After installing, `/skills` inside Claude Code should list the installed skill(s).

## Conventions for adding to this repo

- **Skills** go in `skills/<name>/` with a `SKILL.md` (name + description frontmatter)
  and any bundled scripts. Keep them project-agnostic: no client names, ids, or field
  hashes baked in - per-project config belongs in each project's own repo.
- **Scripts** go in `scripts/` and should be runnable standalone with clear `--help`.
- **Templates** go in `templates/`.
- Update the tables above and `docs/INSTALL.md` when you add a skill.
- Never commit credentials. `.env`, `.env.local`, and API tokens stay out of the repo
  (see `.gitignore`).

## License

MIT - see [LICENSE](LICENSE).

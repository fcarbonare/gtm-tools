# scripts

Standalone helper scripts for the GTM stack. Unlike skills (which Claude Code loads by
description), these are run directly by a person or from CI.

Conventions:
- One script per task, runnable with `--help`.
- No hardcoded credentials - read from the environment or a gitignored `.env`.
- If a script starts sharing logic with a skill, factor the shared part out rather than
  copy-pasting.

_None yet - add them here._

# Installing gtm-tools skills

Skills are picked up by Claude Code from `~/.claude/skills/`. Installing a skill means
putting (or linking) its folder there. `install.sh` does this for you, but you can also
do it by hand.

## Install everything

From the repo root:

```bash
./install.sh
```

This **symlinks** every folder under `skills/` into `~/.claude/skills/`. Symlinks mean a
later `git pull` updates the installed skills automatically - nothing to reinstall.

## Install specific skills

Pass one or more skill names (the folder names under `skills/`):

```bash
./install.sh pipedrive-config-sync
```

## Copy instead of symlink

If you'd rather pin a snapshot that won't change when you pull:

```bash
./install.sh --copy                       # all skills, copied
./install.sh --copy pipedrive-config-sync # one skill, copied
```

## Do it by hand

Symlink one skill:

```bash
mkdir -p ~/.claude/skills
ln -sfn "$PWD/skills/pipedrive-config-sync" ~/.claude/skills/pipedrive-config-sync
```

Or copy it:

```bash
mkdir -p ~/.claude/skills
cp -R skills/pipedrive-config-sync ~/.claude/skills/
```

## Verify

```bash
ls -l ~/.claude/skills            # the skill (or its symlink) should be listed
```

Then in Claude Code, run `/skills` - the installed skill should appear by name. Start a
task that matches its description and confirm it triggers.

## Uninstall

```bash
rm ~/.claude/skills/pipedrive-config-sync   # removes the symlink or copy
```

## Per-skill requirements

Some skills need tooling or credentials in the project where you run them, not at install
time:

- **pipedrive-config-sync** - needs Node 14+ (no npm dependencies) and a
  `PIPEDRIVE_API_TOKEN` in the environment or in a `.env` / `.env.local` at the project
  root or its `pipedrive/` directory. Bundles `pipedrive-sync.mjs`, which also mirrors
  native **workflow automations** read-only via its `automations` subcommand (into
  `<mirror>/automations/`). See the skill's
  [SKILL.md](../skills/pipedrive-config-sync/SKILL.md) and
  [reading-automations.md](../skills/pipedrive-config-sync/reading-automations.md) for
  details, including the Pipedrive **v1 CRUD deprecation policy**
  ([docs/pipedrive-api.md](pipedrive-api.md)).

- **pipedrive-automations** - documentation-only (no bundled script, no credentials): the
  design knowledge for scoping, planning and validating native automations. It reads and
  mirrors nothing itself - to mirror an existing set it defers to **pipedrive-config-sync**
  (`node pipedrive-sync.mjs automations --write`), so install that too. See the skill's
  [SKILL.md](../skills/pipedrive-automations/SKILL.md).

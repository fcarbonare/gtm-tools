#!/usr/bin/env bash
# Install gtm-tools skills into ~/.claude/skills/.
#
# Usage:
#   ./install.sh                       # symlink every skill
#   ./install.sh <name> [<name>...]    # symlink only the named skill(s)
#   ./install.sh --copy [<name>...]    # copy instead of symlink (pins a snapshot)
#   ./install.sh --help
#
# Symlink (default) means a later `git pull` updates installed skills in place.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$REPO_DIR/skills"
SKILLS_DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

MODE="symlink"
NAMES=()
for arg in "$@"; do
  case "$arg" in
    --copy) MODE="copy" ;;
    --symlink) MODE="symlink" ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) NAMES+=("$arg") ;;
  esac
done

# Default to every skill directory that contains a SKILL.md
if [ "${#NAMES[@]}" -eq 0 ]; then
  for d in "$SKILLS_SRC"/*/; do
    [ -f "$d/SKILL.md" ] && NAMES+=("$(basename "$d")")
  done
fi

if [ "${#NAMES[@]}" -eq 0 ]; then
  echo "No skills found under $SKILLS_SRC" >&2
  exit 1
fi

mkdir -p "$SKILLS_DEST"
echo "Installing into $SKILLS_DEST (mode: $MODE)"

for name in "${NAMES[@]}"; do
  src="$SKILLS_SRC/$name"
  dest="$SKILLS_DEST/$name"
  if [ ! -f "$src/SKILL.md" ]; then
    echo "  skip   $name (no skills/$name/SKILL.md)" >&2
    continue
  fi
  rm -rf "$dest"
  if [ "$MODE" = "copy" ]; then
    cp -R "$src" "$dest"
    echo "  copied  $name"
  else
    ln -sfn "$src" "$dest"
    echo "  linked  $name -> $src"
  fi
done

echo "Done. Run /skills in Claude Code to confirm."

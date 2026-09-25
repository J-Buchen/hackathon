#!/usr/bin/env bash
# Make a git worktree runnable without a fresh npm install, while making sure
# @allowance/* resolves to THIS worktree's packages (not the main checkout's).
#
#   bash scripts/worktree-setup.sh [/path/to/main/checkout]
#
# Third-party packages are symlinked from the main checkout's node_modules;
# the workspace links are recreated locally.
set -euo pipefail
here="$(git rev-parse --show-toplevel)"
main="${1:-$(git -C "$here" worktree list --porcelain | awk '/^worktree /{print $2; exit}')}"
[ "$here" = "$main" ] && { echo "already the main checkout"; exit 0; }
[ -d "$main/node_modules" ] || { echo "no node_modules in $main — run npm install there first" >&2; exit 1; }
rm -rf "$here/node_modules"
mkdir -p "$here/node_modules/@allowance"
for entry in "$main"/node_modules/* "$main"/node_modules/.bin; do
  name="$(basename "$entry")"
  [ "$name" = "@allowance" ] && continue
  ln -s "$entry" "$here/node_modules/$name"
done
for scope in "$main"/node_modules/@*; do
  s="$(basename "$scope")"; [ "$s" = "@allowance" ] && continue
  ln -sfn "$scope" "$here/node_modules/$s"
done
for pkg in packages/core packages/adapters packages/swarm packages/lab services/orchestrator; do
  name="$(node -p "require('$here/$pkg/package.json').name" 2>/dev/null || true)"
  [ -n "$name" ] && ln -sfn "$here/$pkg" "$here/node_modules/$name"
done
echo "worktree $here wired to its own @allowance/* packages"

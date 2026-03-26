#!/bin/bash
# publish.sh — Sync Obsidian Research → Quartz and deploy to GitHub Pages
#
# Usage:
#   ./publish.sh           — sync + commit + push (deploys live)
#   ./publish.sh --preview — sync only, then start local preview server

set -e

VAULT="/Users/venkateshmurugadas/Library/Mobile Documents/iCloud~md~obsidian/Documents/Venkatesh Learning/Research"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTENT_DIR="$SCRIPT_DIR/content"

echo "→ Syncing from Obsidian..."
rsync -a --delete \
  --exclude='.DS_Store' \
  --exclude='*.canvas' \
  --exclude='.obsidian/' \
  "$VAULT/" "$CONTENT_DIR/"
echo "  Done."

if [[ "$1" == "--preview" ]]; then
  echo "→ Starting local preview at http://localhost:8080"
  cd "$SCRIPT_DIR"
  npx quartz build --serve
  exit 0
fi

cd "$SCRIPT_DIR"
git add content/

if git diff --staged --quiet; then
  echo "→ No changes since last publish."
  exit 0
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
git commit -m "sync: Obsidian → Quartz ($TIMESTAMP)"
git push origin HEAD:main

echo ""
echo "✓ Published! Live at https://venkateshdas.github.io/sdd-site in ~2 min"
echo "  Watch deploy: https://github.com/VenkateshDas/sdd-site/actions"

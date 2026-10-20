#!/bin/bash
# Deploy the site's admin Worker (super-frost-1dbb), refusing to ship from a
# stale local copy. Added 2026-10-18 (lessons-learned L50): this repo had
# sat 5 real commits behind GitHub, including the 9/20 gate capture beacon,
# and a plain `wrangler deploy` from it would have silently removed that
# lead-protection code from the live Worker.
#
# Usage: scripts/deploy-worker.sh
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch -q origin
behind=$(git rev-list --count HEAD..origin/main)
if [ "$behind" -gt 0 ]; then
  # Usually just the hourly "Auto-update listings data" commits. Fast-forward
  # (keeps uncommitted edits); if that can't apply cleanly, stop.
  git pull -q --ff-only origin main || { echo "REFUSING: $behind commit(s) behind origin/main and they don't fast-forward cleanly. Sort that out first." >&2; exit 1; }
fi
[ "$(git rev-list --count HEAD..origin/main)" -eq 0 ] || { echo "REFUSING: still behind origin/main." >&2; exit 1; }
python3 scripts/check_no_private_links.py
node --check admin/worker.js
npx wrangler deploy -c wrangler-admin.toml

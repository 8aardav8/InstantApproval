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
grep -A1 '^\[observability\]' wrangler-admin.toml | grep -q 'enabled = true' || { echo "REFUSING: wrangler-admin.toml must keep [observability] enabled = true (L152: logs went dark after a deploy)" >&2; exit 1; }
node tests/login-gate-test.mjs >/dev/null 2>&1 || { echo "REFUSING: sign-in gate tests failed. Run: node tests/login-gate-test.mjs" >&2; exit 1; }
node tests/browse-ids-test.mjs >/dev/null 2>&1 || { echo "REFUSING: browse-IDs tests failed. Run: node tests/browse-ids-test.mjs" >&2; exit 1; }
node tests/activity-stamp-test.mjs >/dev/null 2>&1 || { echo "REFUSING: activity-stamp test failed. Run: node tests/activity-stamp-test.mjs" >&2; exit 1; }
node tests/id-filename-test.mjs >/dev/null 2>&1 || { echo "REFUSING: ID filename test failed. Run: node tests/id-filename-test.mjs" >&2; exit 1; }
node tests/snippet-names-test.mjs >/dev/null 2>&1 || { echo "REFUSING: snippet-name test failed. Run: node tests/snippet-names-test.mjs" >&2; exit 1; }
node tests/first-login-test.mjs >/dev/null 2>&1 || { echo "REFUSING: First Login test failed. Run: node tests/first-login-test.mjs" >&2; exit 1; }
node tests/reserve-test.mjs >/dev/null 2>&1 || { echo "REFUSING: Reserve/deposit tests failed. Run: node tests/reserve-test.mjs" >&2; exit 1; }
node tests/layout-test.mjs >/dev/null 2>&1 || { echo "REFUSING: column-tag layout test failed (TASK-000844). Run: node tests/layout-test.mjs" >&2; exit 1; }
node tests/repeat-booking-test.mjs >/dev/null 2>&1 || { echo "REFUSING: repeat-booking test failed. Run: node tests/repeat-booking-test.mjs" >&2; exit 1; }
node tests/trello-shown-test.mjs >/dev/null 2>&1 || { echo "REFUSING: Trello shown write-back test failed. Run: node tests/trello-shown-test.mjs" >&2; exit 1; }
node tests/no-append-logins-test.mjs >/dev/null 2>&1 || { echo "REFUSING: App: Logins append guard failed (L127). Run: node tests/no-append-logins-test.mjs" >&2; exit 1; }
node tests/gate-capture-test.mjs >/dev/null 2>&1 || { echo "REFUSING: gate capture landing check failed (L127). Run: node tests/gate-capture-test.mjs" >&2; exit 1; }
node tests/quo-lookup-cap-test.mjs >/dev/null 2>&1 || { echo "REFUSING: Quo lookup cap test failed (lookups must reach every contact). Run: node tests/quo-lookup-cap-test.mjs" >&2; exit 1; }
node tests/favorites-sheet-first-test.mjs >/dev/null 2>&1 || { echo "REFUSING: favorites test failed (a buyer visit must never wipe a favorite). Run: node tests/favorites-sheet-first-test.mjs" >&2; exit 1; }
node tests/template-autosend-test.mjs >/dev/null 2>&1 || { echo "REFUSING: Templates On/Off switch test failed. Run: node tests/template-autosend-test.mjs" >&2; exit 1; }
node tests/appointment-texts-test.mjs >/dev/null 2>&1 || { echo "REFUSING: showing booked/canceled text test failed. Run: node tests/appointment-texts-test.mjs" >&2; exit 1; }
node tests/featured-test.mjs >/dev/null 2>&1 || { echo "REFUSING: Featured tick box test failed. Run: node tests/featured-test.mjs" >&2; exit 1; }
node tests/admin-search-test.mjs >/dev/null 2>&1 || { echo "REFUSING: admin search test failed. Run: node tests/admin-search-test.mjs" >&2; exit 1; }
node tests/view-as-test.mjs >/dev/null 2>&1 || { echo "REFUSING: See-site-as (view-only) test failed. Run: node tests/view-as-test.mjs" >&2; exit 1; }
node tests/quo-webhook-fast-ack-test.mjs >/dev/null 2>&1 || { echo "REFUSING: Quo webhook must answer at once (Quo disables it after 10s timeouts, 2026-11-26). Run: node tests/quo-webhook-fast-ack-test.mjs" >&2; exit 1; }
npx wrangler deploy -c wrangler-admin.toml

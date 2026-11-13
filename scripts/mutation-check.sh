#!/usr/bin/env bash
# Break one thing on purpose, run a test, put the file back exactly.
# Usage: scripts/mutation-check.sh <file> <test.mjs> <exact old text> <new text>
# Restores from a byte copy and checks the md5, never with git (lessons L102:
# `git checkout -- file` also throws away uncommitted work in that file).
set -euo pipefail
file=$1; test=$2; old=$3; new=$4
backup=$(mktemp); cp "$file" "$backup"; before=$(md5 -q "$file")
trap 'cp "$backup" "$file"; [ "$(md5 -q "$file")" = "$before" ] || echo "RESTORE FAILED: $file" >&2; rm -f "$backup"' EXIT
OLD="$old" NEW="$new" python3 - "$file" <<'PY'
import os, sys
p = sys.argv[1]; s = open(p).read(); a = os.environ["OLD"]
if s.count(a) != 1: sys.exit(f"text found {s.count(a)} times, need exactly 1")
open(p, "w").write(s.replace(a, os.environ["NEW"]))
PY
caught=$(node "$test" 2>/dev/null | grep -c '^FAIL' || true)
echo "caught=$caught"

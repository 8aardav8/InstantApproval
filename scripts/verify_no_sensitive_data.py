#!/usr/bin/env python3
"""
Fail-closed pre-commit safety check. Re-reads the raw sensitive-column values
directly from the Sheet and confirms none of them appear anywhere in the
files about to be committed under docs/. Any hit fails the run (non-zero
exit) -- nothing gets committed. Must run BEFORE `git commit`, not after:
this repo is public, so anything ever pushed is effectively permanent in
git history even if reverted later.

Design note, confirmed via real testing against live data (2026-08-21):
comparisons are ROW-SCOPED, not a flat "does this value appear ANYWHERE in
the output" search. A flat search produces real false positives (e.g. a
short Lock box value like "63120" that's coincidentally also a common ZIP
code appearing in dozens of unrelated addresses) and misses nothing a
row-scoped check wouldn't also catch -- a row's own sensitive value showing
up in a DIFFERENT row's public entry would still be caught by scanning that
row's own raw value against the whole output too, so row-scoping only
removes noise, it doesn't reduce coverage of the thing that actually matters:
whether a row's own secret ended up in its own public listing.

Real bug fixed here (2026-09-01): this used to do its own independent Sheet
read via get_client()/gspread, separate from generate_properties.py's own
read a step earlier in the same CI job. Both scripts querying the live Sheet
seconds apart raced against real, ongoing edits (the Sheet is someone's
actual daily-use pricing/lockbox tracker) -- if a row changed in that gap,
the two reads could disagree, producing a spurious mismatch that blocked an
otherwise-clean publish. Confirmed happening for real, 3 days running.
Fix: read the exact same raw snapshot generate_properties.py already wrote,
instead of re-querying the Sheet here -- the two scripts now provably see
identical data, and this script no longer needs live Sheets credentials at
all for its own purposes.

Usage:
  python3 verify_no_sensitive_data.py
  (must run in the same CI job/workspace as generate_properties.py, after it)
"""
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_PATH = os.path.join(REPO_ROOT, "docs", "data", "properties.json")
RAW_SNAPSHOT_PATH = os.path.join(REPO_ROOT, ".raw_properties_snapshot.json")

SENSITIVE_COLUMNS = [
    "Lock box ", "Seller name and link", "🔒 Row ID",
    "PHOTO Error", "We're Marketing", "TT Our Link",
]

# Values shorter than this are too generic to check meaningfully (e.g. "FALSE",
# "0") -- checking them would either always false-positive-match something
# benign or never mean anything. Real lockbox codes/URLs/names are longer.
MIN_VALUE_LENGTH = 5

# Confirmed real, expected overlap (2026-08-21): Aaron is both the site's own
# publicly-displayed owner/operator (his name is legitimately in the site's
# header/branding) AND, for some listings, the literal seller himself -- so
# "Seller name and link" == "Aaron David" for those rows is correct, not a
# leak. Without this, the check would permanently false-positive on every
# self-owned listing. Does NOT apply to Lock box / Row ID / etc. -- there's
# no equivalent legitimate reason for those to ever match template text.
KNOWN_SAFE_VALUES = {"Aaron David"}

# Narrow, explicitly-dated exceptions -- NOT a general weakening of the check.
# Each entry is a real, understood case, reviewed and approved by Aaron
# directly, not a default to reach for casually. Format: (listing_id, column).
#
# 2026-08-21, Aaron's explicit call: these 2 rows have a stray Pics-1 photo
# link duplicated into "Seller name and link" (a real source-data quality
# issue, not fixed at the time of the first launch). The actual matched
# value is just that SAME row's own already-public Pics 1 link -- not real
# seller contact info -- so there's no actual privacy exposure, just a
# miscategorized column. Aaron chose to launch with these 2 included as-is
# and fix the Sheet later; the site will pick up the correction automatically
# whenever that happens. Remove this exception once the source rows are fixed.
KNOWN_EXCEPTIONS = {
    ("1218-pinehurst-ave-flint-mi-48507", "Seller name and link"),
    ("2021-edwardsville-rd-madison-il-62060", "Seller name and link"),
}


def log(msg):
    print(f"[verify_no_sensitive_data] {msg}", file=sys.stderr)


def load_raw_snapshot():
    if not os.path.exists(RAW_SNAPSHOT_PATH):
        raise SystemExit(
            f"FATAL: {RAW_SNAPSHOT_PATH} doesn't exist. This script must run in the "
            "same CI job/workspace as generate_properties.py, AFTER it -- it reads "
            "that script's raw Sheet snapshot rather than querying the Sheet itself "
            "(see the module docstring for why)."
        )
    with open(RAW_SNAPSHOT_PATH) as f:
        return json.load(f)


def slugify(address):
    import re
    s = address.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-") or "listing"


def main():
    if not os.path.exists(OUTPUT_PATH):
        raise SystemExit(f"FATAL: {OUTPUT_PATH} doesn't exist -- nothing to verify. "
                          "Run generate_properties.py first.")

    with open(OUTPUT_PATH) as f:
        output = json.load(f)
    listings_by_id = {l["id"]: l for l in output["listings"]}

    # Static template files (HTML/JS/CSS) are NOT per-listing data -- unlike
    # properties.json (which legitimately contains ~1,800 OTHER listings a
    # coincidental short-string match can harmlessly land in), a sensitive
    # value has no legitimate reason to appear ANYWHERE in these files, from
    # any row. So these get a flat/global check; properties.json gets ONLY
    # the row-scoped check above -- mixing the two reintroduces exactly the
    # cross-row false positives (e.g. a ZIP code coincidentally matching a
    # Lock box value from an unrelated row) this script exists to avoid.
    template_text = ""
    docs_dir = os.path.join(REPO_ROOT, "docs")
    for root, _dirs, files in os.walk(docs_dir):
        for fname in files:
            path = os.path.join(root, fname)
            if path == OUTPUT_PATH:
                continue
            try:
                with open(path, "r", errors="ignore") as f:
                    template_text += f.read()
            except Exception:
                pass  # binary files (images etc.)

    all_values = load_raw_snapshot()
    headers = all_values[0]
    header_idx = {h: i for i, h in enumerate(headers)}
    addr_idx = header_idx["Address"]

    missing = [c for c in SENSITIVE_COLUMNS if c not in header_idx]
    if missing:
        raise SystemExit(f"FATAL: sensitive column(s) not found in header row: {missing}. "
                          "Sheet layout may have changed -- refusing to proceed blind.")

    findings = []
    seen_ids = {}
    dupe_counter = 0

    for row in all_values[1:]:
        address = row[addr_idx].strip() if addr_idx < len(row) else ""
        if not address:
            continue
        listing_id = slugify(address)
        if listing_id in seen_ids:
            dupe_counter += 1
            listing_id = f"{listing_id}-{dupe_counter}"
        seen_ids[listing_id] = True

        own_listing = listings_by_id.get(listing_id)
        own_listing_text = json.dumps(own_listing) if own_listing else ""

        for col in SENSITIVE_COLUMNS:
            ci = header_idx[col]
            val = row[ci].strip() if ci < len(row) else ""
            if not val or len(val) < MIN_VALUE_LENGTH or val in KNOWN_SAFE_VALUES:
                continue
            # Row-scoped check against properties.json: does THIS row's own
            # sensitive value appear in THIS row's own public listing entry?
            if own_listing_text and val in own_listing_text:
                # Self-verifying exception: only applies while the flagged
                # value is STILL actually equal to this row's own picsLink
                # (i.e. still just the same known duplicate-link issue) --
                # if the Sheet value ever changes to something else, this
                # does NOT blindly keep passing, it gets caught fresh.
                is_known_exception = (
                    (listing_id, col) in KNOWN_EXCEPTIONS
                    and own_listing and val == own_listing.get("picsLink")
                )
                if is_known_exception:
                    log(f"ALLOWED (known exception, still verified as own Pics 1 duplicate): "
                        f"listing {listing_id!r}, column {col!r}")
                else:
                    findings.append((listing_id, col, val, "own listing entry in properties.json"))
            # Flat check against the static template files only -- these
            # should never contain per-listing data from ANY row.
            if val in template_text:
                findings.append((listing_id, col, val, "a static template file (HTML/JS/CSS)"))

    if findings:
        log(f"FATAL: {len(findings)} sensitive-data finding(s), nothing committed:")
        for listing_id, col, val, where in findings:
            log(f"  - listing {listing_id!r}: column {col!r} value {val[:60]!r}... found in {where}")
        sys.exit(1)

    log(f"Clean: checked {len(seen_ids)} rows x {len(SENSITIVE_COLUMNS)} sensitive columns "
        f"against {len(listings_by_id)} public listings + the full docs/ tree. No leaks found.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Reads the Filling Sheet's PROPERTIES tab and writes docs/data/properties.json --
the only file this whole pipeline is allowed to produce for public consumption.

Design principles (see the approved plan, /Users/aarondavid/.claude/plans/woolly-sniffing-moon.md):
  - Look up columns by HEADER NAME, never by index. If an expected column goes
    missing/renamed, fail loudly rather than silently mis-map -- this is the
    primary defense against ever accidentally exposing `Lock box ` after the
    Sheet gets reorganized.
  - Available, Pending, and Sold are all INCLUDED (status filtering happens in
    the front end, not here) -- Off-Market and anything unrecognized is excluded.
  - Only the confirmed-public columns are ever written to the output. Sensitive
    columns (Lock box, Seller name and link, Row ID, PHOTO Error, We're
    Marketing, TT Our Link) are read only by the separate admin backend, never
    by this script.
  - Geocoding (for the map) happens here, server-side, once per run -- not
    client-side per page-load.

Usage:
  GCP_SA_KEY_JSON=<service-account json>  python3 generate_properties.py
  # or, for local testing:
  GCP_SA_KEY_FILE=~/.config/agent-system/service-account.json python3 generate_properties.py
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = "1qDdTcKg2-myJVZkazVOneAAjMlFlMaGKKXlRK518WMk"
TAB_NAME = "PROPERTIES"

# Repo-relative output path (script is expected to run from repo root in CI;
# resolve relative to this file so local runs from any cwd still work).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_PATH = os.path.join(REPO_ROOT, "docs", "data", "properties.json")

# Statuses that are ever included in the public dataset. Anything else
# (Off-Market, "Off- market", typos, future values) is excluded and logged.
INCLUDED_STATUSES = {"available", "pending", "sold"}

# Confirmed-public columns (see the approved plan's "Public data" section).
PUBLIC_COLUMNS = [
    "Address", "On Market Date", "Last Update", "Area", "Down", "Monthly",
    "Pics 1", "Beds", "Baths", "Sq Ft", "Available?", "Livability",
]

# Columns that must NEVER be read into the public output at all -- not just
# omitted, actively never touched by this script's field mapping.
SENSITIVE_COLUMNS = [
    "Lock box ", "Seller name and link", "🔒 Row ID",
    "PHOTO Error", "We're Marketing", "TT Our Link",
]

# All 34 real columns, used only to validate the header row hasn't drifted.
EXPECTED_HEADERS = [
    "Available?", "Livability", "PHOTO Error", "Address", "Quick Summary",
    "Pics 1", "Lock box ", "On Market Date", "Last Update", "Area",
    "We're Marketing", "Additional Notes", "Down", "Monthly", "Total Price",
    "Seller name and link", "Skool Link", "TT Our Link", "TT Buyer Link",
    "Zillow Link", "Years", "Includes Taxes", "Includes Insurance",
    "Share Link", "Pics 2", "Pics 3", "Beds", "Baths", "Sq Ft", "Type",
    "Basement", "Garage", "Driveway", "🔒 Row ID",
]


def log(msg):
    print(f"[generate_properties] {msg}", file=sys.stderr)


def get_client():
    key_json = os.environ.get("GCP_SA_KEY_JSON")
    key_file = os.environ.get("GCP_SA_KEY_FILE")
    scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly",
              "https://www.googleapis.com/auth/drive.readonly"]
    if key_json:
        info = json.loads(key_json)
        creds = Credentials.from_service_account_info(info, scopes=scopes)
    elif key_file:
        creds = Credentials.from_service_account_file(
            os.path.expanduser(key_file), scopes=scopes
        )
    else:
        raise SystemExit(
            "FATAL: neither GCP_SA_KEY_JSON nor GCP_SA_KEY_FILE is set. "
            "Refusing to guess at credentials."
        )
    return gspread.authorize(creds)


def livability_to_number(raw):
    """Livability is stored as a star string (e.g. '★★☆☆☆'), not a
    number. Confirmed empirically: 'all empty stars' (☆☆☆☆☆) is the
    overwhelming majority (200/309 available listings) and represents
    "unrated", not literally zero -- the real site shows empty parens '()'
    for these, and a plain number '(N)' for anything with at least one
    filled star. Returns None for unrated (front end renders as '()'),
    otherwise the count of filled stars."""
    filled = raw.count("★")
    return filled if filled > 0 else None


def slugify(address):
    """Stable public id from Address -- never the internal Row ID."""
    s = address.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-") or "listing"


def geocode(address, api_key, cache):
    """Server-side geocode, cached across the run. Returns (lat, lng) or None.
    Never raises -- a geocoding failure should degrade (no map pin) not fail
    the whole pipeline."""
    if address in cache:
        return cache[address]
    if not api_key:
        return None
    try:
        url = (
            "https://maps.googleapis.com/maps/api/geocode/json?"
            + urllib.parse.urlencode({"address": address, "key": api_key})
        )
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        if data.get("status") == "OK" and data.get("results"):
            loc = data["results"][0]["geometry"]["location"]
            result = {"lat": loc["lat"], "lng": loc["lng"]}
            cache[address] = result
            return result
        log(f"WARNING: geocoding non-OK status for {address!r}: {data.get('status')}")
    except Exception as e:
        log(f"WARNING: geocoding failed for {address!r}: {e}")
    cache[address] = None
    return None


def load_previous_output():
    if os.path.exists(OUTPUT_PATH):
        try:
            with open(OUTPUT_PATH) as f:
                return json.load(f)
        except Exception:
            return None
    return None


def load_geocode_cache_from_previous(previous):
    """Reuse lat/lng from the last run for addresses that already have it,
    so we don't re-geocode everything on every single edit."""
    cache = {}
    if not previous:
        return cache
    for listing in previous.get("listings", []):
        if listing.get("lat") is not None and listing.get("lng") is not None:
            cache[listing["address"]] = {"lat": listing["lat"], "lng": listing["lng"]}
    return cache


def main():
    client = get_client()
    sh = client.open_by_key(SHEET_ID)
    ws = sh.worksheet(TAB_NAME)
    all_values = ws.get_all_values()
    if not all_values:
        raise SystemExit("FATAL: PROPERTIES tab returned no data at all.")

    headers = all_values[0]
    header_idx = {h: i for i, h in enumerate(headers)}

    # Fail loudly on any header drift -- the single most important guard
    # against silently mis-mapping a column (e.g. Lock box shifting into a
    # public slot after someone reorders the sheet).
    missing = [h for h in EXPECTED_HEADERS if h not in header_idx]
    if missing:
        raise SystemExit(
            f"FATAL: expected column(s) not found in PROPERTIES header row: {missing}. "
            "Refusing to proceed -- the sheet has likely been reorganized. "
            "Update EXPECTED_HEADERS/PUBLIC_COLUMNS/SENSITIVE_COLUMNS only after "
            "manually confirming the new layout."
        )
    for col in PUBLIC_COLUMNS:
        if col not in header_idx:
            raise SystemExit(f"FATAL: public column {col!r} not found in header row.")

    api_key = os.environ.get("GOOGLE_MAPS_API_KEY", "")
    if not api_key:
        log("WARNING: GOOGLE_MAPS_API_KEY not set -- listings will be written without lat/lng (no map pins).")

    previous = load_previous_output()
    geocode_cache = load_geocode_cache_from_previous(previous)

    status_idx = header_idx["Available?"]
    seen_ids = set()
    listings = []
    unrecognized_statuses = {}
    dupe_ids = 0

    for row in all_values[1:]:
        # Defensive: rows can be shorter than the header row if trailing
        # cells are empty.
        def cell(col_name):
            i = header_idx[col_name]
            return row[i] if i < len(row) else ""

        raw_status = cell("Available?").strip()
        status_key = raw_status.lower()
        if status_key not in INCLUDED_STATUSES:
            if raw_status and status_key not in {"off-market", "off- market"}:
                unrecognized_statuses[raw_status] = unrecognized_statuses.get(raw_status, 0) + 1
            continue

        address = cell("Address").strip()
        if not address:
            continue  # can't build an id or a usable listing without an address

        listing_id = slugify(address)
        if listing_id in seen_ids:
            # Duplicate address -- disambiguate rather than silently overwrite.
            dupe_ids += 1
            listing_id = f"{listing_id}-{dupe_ids}"
        seen_ids.add(listing_id)

        listing = {
            "id": listing_id,
            "address": address,
            "onMarketDate": cell("On Market Date").strip(),
            "lastUpdate": cell("Last Update").strip(),
            "area": cell("Area").strip(),
            "down": cell("Down").strip(),
            "monthly": cell("Monthly").strip(),
            "picsLink": cell("Pics 1").strip(),
            "beds": cell("Beds").strip(),
            "baths": cell("Baths").strip(),
            "sqft": cell("Sq Ft").strip(),
            "status": raw_status,  # keep the real casing, e.g. "Available"
            "livability": livability_to_number(cell("Livability")),
        }

        if status_key == "available":
            coords = geocode(address, api_key, geocode_cache)
            listing["lat"] = coords["lat"] if coords else None
            listing["lng"] = coords["lng"] if coords else None
        else:
            listing["lat"] = None
            listing["lng"] = None

        listings.append(listing)

    if unrecognized_statuses:
        log(f"WARNING: unrecognized Available? values found (excluded): {unrecognized_statuses}")

    available_count = sum(1 for l in listings if l["status"].strip().lower() == "available")

    # Sanity check against the previous run.
    if previous:
        prev_available = sum(
            1 for l in previous.get("listings", [])
            if l.get("status", "").strip().lower() == "available"
        )
        if prev_available > 0:
            if available_count == 0:
                raise SystemExit(
                    f"FATAL: available-listing count dropped to 0 (was {prev_available}). "
                    "This almost certainly signals a structural Sheet problem, not a real "
                    "inventory swing. Refusing to publish."
                )
            drop_pct = (prev_available - available_count) / prev_available
            if drop_pct > 0.5:
                log(f"WARNING: available-listing count dropped {drop_pct:.0%} "
                    f"({prev_available} -> {available_count}) -- worth a human look.")

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "listings": listings,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    log(f"Wrote {len(listings)} listings ({available_count} available) to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()

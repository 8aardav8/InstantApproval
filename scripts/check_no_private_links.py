#!/usr/bin/env python3
"""
Fail-closed check: no Dropbox link or credential may appear in any tracked
file except the listing-photo links the site publishes on purpose.

Added 2026-10-19 (lessons-learned L51). This repo is PUBLIC. On 2026-08-29 a
Claude Code change hard-coded a public share link to the whole Buyer IDs
folder (~113 driver's licenses) into admin/worker.js, and it sat in public
git history for seven weeks. verify_no_sensitive_data.py only ever scanned
the generated listing data under docs/, never code, so nothing caught it.

Runs three places: the publish workflow, the git pre-commit hook (see
scripts/install-hooks.sh), and scripts/deploy-worker.sh.

Allowed: Dropbox links inside docs/data/properties.json -- the listing
photo folders Aaron publishes deliberately, generated from the PROPERTIES
tab. Anywhere else, any Dropbox link fails. Editable links ("rlkey" with
an edit share, or any /scl/ link Dropbox marks editable) can't be told
apart from the URL alone, so the allowlist is by file, not by link.

Usage: python3 scripts/check_no_private_links.py [--staged]
"""
import re
import subprocess
import sys

ALLOWED_LINK_FILES = {"docs/data/properties.json"}
DROPBOX = re.compile(r"dropbox\.com/(scl/f[io]|s|sh)/[A-Za-z0-9]+", re.I)
# Code that would create a public Dropbox link (lessons L51/L53). IDs are
# stored as private file ids and served through the Worker; nothing here may
# mint "anyone with the link" access again.
FORBIDDEN_CODE = re.compile(r"sharing/create_shared_link")
SELF = "scripts/check_no_private_links.py"
SECRETS = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]{40,}"  # an actual key body, not code that strips the header
    r"|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}"
    r"|sk-[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{20,}|GOCSPX-[A-Za-z0-9_-]{20,}"
    r"|\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}"  # Telegram bot token
    r"|\bsl\.[A-Za-z0-9_-]{60,}|AKIA[0-9A-Z]{16}"
)


def files_to_check(staged):
    if staged:
        out = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"], capture_output=True, text=True, check=True).stdout
    else:
        out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    return [f for f in out.splitlines() if f]


def read(path, staged):
    if staged:
        res = subprocess.run(["git", "show", f":{path}"], capture_output=True)
        return res.stdout.decode("utf-8", "ignore")
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            return fh.read()
    except (IsADirectoryError, FileNotFoundError):
        return ""


def main():
    staged = "--staged" in sys.argv
    problems = []
    for path in files_to_check(staged):
        text = read(path, staged)
        if path not in ALLOWED_LINK_FILES:
            for m in DROPBOX.finditer(text):
                problems.append(f"{path}: Dropbox link {m.group(0)[:40]}...")
        if path != SELF and FORBIDDEN_CODE.search(text):
            problems.append(f"{path}: creates a public Dropbox share link (sharing/create_shared_link)")
        for m in SECRETS.finditer(text):
            problems.append(f"{path}: looks like a credential ({m.group(0)[:12]}...)")
    if problems:
        print("BLOCKED: private links or credentials in a PUBLIC repo:")
        for p in problems:
            print("  " + p)
        print("Remove them (keep links/secrets in Worker secrets or the Sheet, never in code).")
        sys.exit(1)
    print("check_no_private_links: clean")


if __name__ == "__main__":
    main()

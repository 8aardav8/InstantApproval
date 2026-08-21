# Instant-Approval Home Financing -- listings site

Replaces the $45/month Glide app. Reads from the Filling Sheet's `PROPERTIES`
tab and republishes automatically shortly after the VA or Nathan edits it.
Full design context: `/Users/aarondavid/.claude/plans/woolly-sniffing-moon.md`.

## One-time setup (kickoff)

1. **GitHub repo**: create it (public -- required for free Pages/Actions),
   enable Pages from the `docs/` folder on `main` (Settings > Pages).
2. **Secrets** (Settings > Secrets and variables > Actions):
   - `GCP_SA_KEY_JSON` -- the existing `agent-system-sheets-editor` service
     account's key JSON. Confirm its access is scoped to just the Filling
     Sheet before adding it here (a public repo's secrets have a larger
     exposure surface than a key on the Mac/droplet alone).
   - `GOOGLE_MAPS_API_KEY` -- Aaron's existing Google Cloud Maps key, with
     Street View Static API, Maps JavaScript API, and Geocoding API enabled,
     and this site's domain added to its HTTP referrer restrictions.
3. **`docs/js/app.js`**: fill in the same `GOOGLE_MAPS_API_KEY` constant at
   the top (it's a publishable/referrer-restricted browser key by design,
   not a secret -- same as any site embedding Google Maps).
4. **Google Apps Script** (bound to the Sheet, NOT this repo): follow the
   setup steps documented at the top of `appsscript/dispatch.gs`. This
   includes a one-time interactive OAuth consent click that only Aaron can
   do -- it cannot be scripted.
5. **Custom domain** (optional): if keeping `instantapprovalhomes.com`,
   add a CNAME/A record at the domain registrar pointing at GitHub Pages,
   and set it in Settings > Pages > Custom domain.
6. **Small serverless backend** (admin API + Buyer Info form handler): see
   `admin/` -- platform choice and deployment still open, confirm at kickoff.

## Local development

```
cd scripts
pip install -r requirements.txt
GCP_SA_KEY_FILE=~/.config/agent-system/service-account.json python3 generate_properties.py
GCP_SA_KEY_FILE=~/.config/agent-system/service-account.json python3 verify_no_sensitive_data.py
cd ../docs && python3 -m http.server 8000   # then open http://localhost:8000
```

## Rollback

A bad publish is just a bot commit to one file (`docs/data/properties.json`).
`git revert` the offending commit and push -- Pages redeploys automatically.

## Safety design, worth remembering

- `verify_no_sensitive_data.py` runs in CI **before** every commit, not
  after -- this repo is public, so anything ever pushed is effectively
  permanent in git history even if reverted later.
- It's **row-scoped**: it checks whether *a given row's own* sensitive value
  (Lock box, Seller name and link, etc.) appears in *that same row's own*
  public listing entry. A flat "does this value appear ANYWHERE in the
  output" search produces real false positives (confirmed empirically against
  live data -- e.g. a short Lock box value that's coincidentally also a
  common ZIP code appearing in dozens of unrelated addresses) without adding
  real coverage.
- Two genuine same-row data-quality issues were found during testing against
  live data (not a script bug): rows `1218 Pinehurst Ave, Flint MI` and
  `2021 Edwardsville Rd, Madison IL` both have a stray photo-folder link
  sitting in their `Seller name and link` column instead of actual seller
  info. Worth fixing at the source (the Sheet itself) -- until fixed, the
  safety check will correctly refuse to publish while these rows exist as-is.

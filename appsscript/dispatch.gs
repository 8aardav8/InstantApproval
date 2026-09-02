// Reference copy of the Apps Script source -- the ACTUAL script must live
// bound to the Filling Sheet itself (Extensions > Apps Script in the Sheet's
// own UI). This file is here for version control/review only; copy-paste it
// into the bound script editor during kickoff.
//
// REAL CONSTRAINT, confirmed in the approved plan: this must be installed as
// an INSTALLABLE trigger, not a simple onEdit(e)/onChange(e) function. Simple
// triggers cannot call UrlFetchApp (no external network access) -- only an
// installable trigger, set up via the Triggers UI (or createTrigger() run
// once interactively), can. This requires a one-time human OAuth consent
// click -- it cannot be automated/scripted by Claude Code on Aaron's behalf.
//
// onChange (not onEdit) is used deliberately -- it also catches row
// insert/delete/reorder, not just cell edits, which onEdit alone would miss.
//
// One-time setup steps (do these in the Sheet's Apps Script editor):
//   1. Extensions > Apps Script, paste this file's contents in as Code.gs.
//   2. Project Settings > Script Properties, add:
//        GH_OWNER        = <github username/org>
//        GH_REPO         = <repo name>
//        GITHUB_PAT      = <fine-grained PAT, repo-scoped, Contents: write>
//        GH_EVENT_TYPE   = sheet-updated
//   3. Triggers (clock icon) > Add Trigger:
//        Function: onChangeInstallable
//        Event source: From spreadsheet
//        Event type: On change
//      Save, and grant the OAuth consent when prompted -- this step needs a
//      live human click, it's the one part of this whole build that can't
//      be done by Claude Code.
//   4. Test: make a real edit to the Sheet, then check Executions (the
//      clock-with-list icon) to confirm it fired and returned a 2xx from
//      GitHub.

// Real fix, 2026-09-02: onChange fired 7 times within 26 seconds for what
// was apparently one edit action -- a paste/sort/bulk-edit can register as
// several internal change events, not one. Each dispatch spins up a real
// GitHub Actions run, and a burst of near-simultaneous runs raced to push,
// with the loser failing outright and emailing Aaron a failure notice for
// something that wasn't actually a data problem. Fix: throttle dispatches
// to at most one per MIN_DISPATCH_INTERVAL_SECONDS. This is safe (not
// stale) because generate_properties.py always reads the live Sheet fresh
// at the time the GitHub Actions job actually runs, not at dispatch time --
// so whichever single dispatch survives the throttle window still picks up
// the sheet's current (i.e. final, post-burst) state, not a stale snapshot
// from whichever onChange event happened to fire first.
const MIN_DISPATCH_INTERVAL_SECONDS = 30;

function onChangeInstallable(e) {
  dispatchToGitHub();
}

function dispatchToGitHub() {
  const props = PropertiesService.getScriptProperties();

  const lastDispatch = props.getProperty('LAST_DISPATCH_TIME');
  const now = Date.now();
  if (lastDispatch && (now - Number(lastDispatch)) / 1000 < MIN_DISPATCH_INTERVAL_SECONDS) {
    console.log(`Throttled: last dispatch was ${Math.round((now - Number(lastDispatch)) / 1000)}s ago, minimum interval is ${MIN_DISPATCH_INTERVAL_SECONDS}s. Skipping -- a nearby dispatch already covers this change.`);
    return;
  }

  const owner = props.getProperty('GH_OWNER');
  const repo = props.getProperty('GH_REPO');
  const pat = props.getProperty('GITHUB_PAT');
  const eventType = props.getProperty('GH_EVENT_TYPE') || 'sheet-updated';

  if (!owner || !repo || !pat) {
    console.error('Missing required Script Properties (GH_OWNER, GH_REPO, GITHUB_PAT) -- dispatch skipped.');
    return;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
    },
    payload: JSON.stringify({
      event_type: eventType,
      client_payload: { timestamp: new Date().toISOString() },
    }),
    muteHttpExceptions: true, // so a bad response doesn't throw and get swallowed silently
  };

  try {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      console.log(`Dispatch succeeded (${code})`);
      // Only record success as "last dispatch" -- a failed call shouldn't
      // count against the throttle window, so a real follow-up attempt
      // isn't blocked by a call that never actually reached GitHub.
      props.setProperty('LAST_DISPATCH_TIME', String(now));
    } else {
      console.error(`Dispatch failed (${code}): ${resp.getContentText()}`);
    }
  } catch (err) {
    // Real, known risk: a failure here surfaces only as an easy-to-miss
    // notification email to the script's owner. The daily scheduled
    // GitHub Actions workflow (scheduled.yml) is the real backstop for
    // this, not this try/catch alone.
    console.error('dispatch threw: ' + err);
  }
}

// Manual test helper -- run this once from the Apps Script editor (Run menu)
// to confirm credentials/permissions are correct before relying on the
// trigger to fire it automatically. Note: this is throttled by the same
// window as real dispatches, so if you just triggered a real change, this
// may report "Throttled" rather than actually calling out -- that's
// expected, not a bug; wait out the window or check Script Properties'
// LAST_DISPATCH_TIME if you need to force a fresh test.
function testDispatch() {
  dispatchToGitHub();
}

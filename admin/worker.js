// Instant-Approval Home Financing -- Admin API + Login-Gate Lead Capture
// (Cloudflare Worker)
//
// Cross-reference, added 2026-09-16 per Aaron's direct request: real
// automations this file implements are catalogued in the Agent System
// Database Sheet's "Automations" tab (ID column, "AUTO-000001" style,
// same convention as TASK-000001/RULE-000001). This file is responsible
// for: AUTO-000001 (booking write), AUTO-000005 (hide/sentiment/stage/DNC
// -> Sheet write + immediate cache patch), AUTO-000006 (the /internal/
// auto-link-id half -- the actual Dropbox-rename + Sheet-write; the OCR/
// fuzzy-match half lives in nanoclaw's id-photo-watch.ts, not here),
// AUTO-000009 (missed-call/unreplied-text webhook -> Pending Follow-ups),
// AUTO-000010 (phone/email-change confirmation flow). If a new automation
// gets added here, add a row to that tab too -- see
// instant-approval-homes/SESSION_LOG.md for how it was built.
//
// Two independent jobs on one Worker (kept together since they already
// share the same service-account Sheets credential -- no reason to stand up
// a second backend for one more small job):
//
// 1. GET /?id=<listingId> -- returns EVERY column's value (as a raw
//    header-name -> value map) for one listing's Sheet row, ONLY after
//    verifying the caller is Aaron himself via a Google Sign-In ID token.
//    Never bundled into the public properties.json, never cached, read live
//    from the Sheet on every request.
//
// 2. POST /gate-login -- the site's full-site login gate (added 2026-08-27,
//    replicates the existing Glide app's own email-first gate, now with a
//    phone field added). No auth required -- this is a public lead-capture
//    endpoint, protected only by a honeypot field checked client-side (see
//    app.js) plus basic field validation here.
//
//    REARCHITECTED 2026-08-28/29 per Aaron's direct instruction ("instead
//    of asking permission to write to the sheet, let it happen
//    automatically on every new visitor... whenever there's a new visitor,
//    I would like the quo contact updated, the sheet row added, and a
//    quick ping on telegram with their name and info"). This SUPERSEDES
//    the original check-in-and-approve design (an Approval Request Task in
//    the Agent System Database, Nathan checking in on Telegram before
//    writing) -- that flow is fully removed, not just bypassed. On every
//    submission this Worker now, directly, with no approval gate:
//      1. Writes (or, for a returning visitor by email, updates) a row in
//         the Filling Sheet's "App: Logins" tab itself.
//      2. Looks up/creates/updates the visitor's Quo contact on the
//         Filling number, same logic as tools/quo.mjs's upsert-contact-email
//         (ported here directly since Cloudflare Workers can't invoke the
//         droplet's Node scripts).
//      3. Sends Aaron ONE informational Telegram ping -- name/email/phone,
//         no "reply to approve" language, nothing waits on a reply.
//    Nathan is no longer involved in this flow at all. Nathan's own
//    standing instructions have been updated to match (see instructions.
//    prepend.md) -- the "App: Logins only, with Telegram check-in" rule
//    that used to live there is retired along with this code path.
//
// SETUP (fill these in / set as Worker secrets before this works):
//   1. AARON_EMAIL below -- already filled in.
//   2. OAUTH_CLIENT_ID below -- paste in once created (Google Cloud Console
//      -> Credentials -> OAuth client ID -> Web application).
//   3. Two Worker secrets (Settings -> Variables -> "Add secret", NOT plain
//      environment variables -- these must stay encrypted):
//        GCP_SA_EMAIL          = the service account's "client_email"
//        GCP_SA_PRIVATE_KEY    = the service account's "private_key"
//                                 (paste the FULL value including the
//                                 -----BEGIN/END PRIVATE KEY----- lines)
//      Both values are in the same JSON key file already used elsewhere in
//      this project (~/.config/agent-system/service-account.json).
//   4. The Filling Sheet must share Editor access (not just Viewer) with
//      the service account's email -- job 1 only ever needed
//      spreadsheets.readonly, but writing App: Logins rows needs write.
//      Granted 2026-08-28 -- if this were ever revoked, /gate-login would
//      fail cleanly with a caught error (visitor sees "something went
//      wrong, call/text us instead"), not a silent failure.
//   5. IMMEDIATE check-in, added 2026-08-28 per Aaron's direct ask ("I'd
//      like the check-in to be immediate"). One more Worker secret:
//        TELEGRAM_BOT_TOKEN    = the same bot token Nathan's own Telegram
//                                 connection already uses (found in
//                                 /root/nanoclaw/.env on the droplet as
//                                 TELEGRAM_BOT_TOKEN). This Worker only
//                                 ever calls Telegram's one-way sendMessage
//                                 API with it -- it never registers or
//                                 touches the bot's webhook, so this can't
//                                 conflict with or break Nathan's own
//                                 Telegram wiring. This is now a pure,
//                                 one-way informational ping -- no reply is
//                                 ever expected or interpreted by this
//                                 Worker (it has no incoming-message wiring
//                                 at all); Aaron's reply, if any, just lands
//                                 in the same chat like any other message.
//   6. QUO_API_KEY -- the same Quo (OpenPhone) API key already used by the
//      droplet's tools/quo.mjs, given to this Worker so it can look up/
//      create/update contacts directly (Cloudflare Workers can't invoke
//      the droplet's Node scripts, so the relevant logic is ported here).

const AARON_EMAIL = "Ate7010@gmail.com";
const OAUTH_CLIENT_ID = "74546128016-r0b13a553shc79gae1hf8r42nkd47t3i.apps.googleusercontent.com";

// Aaron's own Telegram chat ID (the bot's one paired/owner chat) -- not a
// secret in the same sense as the bot token, just a "send to" address, so
// it's a plain constant here rather than a Worker secret.
const AARON_TELEGRAM_CHAT_ID = "5752904645";
// Nathan/NanoClaw's "Triage" hat channel -- same id used by
// watch-scripts/lib.ts's TELEGRAM_CHANNELS.triage on the NanoClaw side.
// Used only by handleQuoTriageWebhook below.
const TRIAGE_TELEGRAM_CHAT_ID = "-5379307292";

// 4. POST /upload-id -- the Get Started page (added 2026-08-29, replaces the
//    old never-connected "Buyer Info" tab). Uploads a visitor's ID photo
//    straight to Dropbox's IDs folder and notifies Aaron on Telegram --
//    deliberately NOT the same check-in-and-approve flow as gate-login.
//    Aaron's own call: an ID upload is a routine intake event for someone
//    already approved via the gate, not a new identity being created, so
//    it auto-files with a notification rather than waiting on a reply.
//    New Worker secrets needed: DROPBOX_APP_KEY, DROPBOX_APP_SECRET,
//    DROPBOX_REFRESH_TOKEN (same Dropbox app already used by the droplet's
//    tools/dropbox.mjs -- same credentials, just also given to this Worker).
// Corrected 2026-08-29 -- Aaron sent the real folder's share link directly;
// resolved via sharing/get_shared_link_metadata rather than trusted from
// memory. Real name is "Buyer IDs", not "IDs" (that was from older, paused
// notes elsewhere in this project that turned out to be stale).
const DROPBOX_IDS_FOLDER = "/**WORK BOX/**REAL ESTATE/*SLOW FLIPS/FILLING/Buyer IDs";
// The folder's own share link, given directly by Aaron when this folder
// was first set up -- included in the ID-upload Telegram ping so he can
// jump straight there. NOT a link to the exact uploaded file: creating a
// real per-file shared link requires Dropbox's `sharing.write` scope,
// which the current refresh token doesn't have (confirmed live, 2026-08-29
// -- the app itself needs that scope enabled in the Dropbox App Console,
// then a full OAuth re-authorization, same process as the earlier
// files.content.write upgrade). Aaron chose the folder-link now, exact-
// file-link-later tradeoff explicitly rather than waiting on that.
const DROPBOX_BUYER_IDS_FOLDER_LINK = "https://www.dropbox.com/scl/fo/jj1egrthqv88f7btqaofq/AFonsjf0bIQ08B9f9nS80PA?rlkey=kit7qc346vzpdk6gv0wn9n60c&st=1wef8h8q&dl=0";

const SHEET_ID = "1qDdTcKg2-myJVZkazVOneAAjMlFlMaGKKXlRK518WMk";
const SHEET_TAB = "PROPERTIES";
const LOGINS_TAB = "App: Logins";
// The Agent System Database (Nathan's own Sheet, a different one from the
// Filling Sheet above) -- same shared GCP service account, confirmed
// working against both. Used only by handleQuoTriageWebhook's "Pending
// Follow-ups" tab.
const DB_SHEET_ID = "1iFhl222SMp9S2tBuFzroLJWK7z5KU21kpjKbtjU3RJo";
const PENDING_PHONE_TAB = "Pending Phone Changes";

// Added 2026-09-02, Aaron's direct request, closing a real gap: there was no
// way for a visitor to ever correct their own phone number (writeLoginsRow's
// finalPhone rule always keeps whatever's already on file, deliberately, to
// stop a bad-faith resubmission from silently overwriting a real value -- see
// that function's own comment). This adds a real, gated path for a
// DELIBERATE, verified correction: a visitor requests a change, the NEW
// number gets texted asking for a reply, and only a real "YES" reply from
// that same number actually triggers the overwrite. The general gate-login/
// booking paths are completely untouched -- they still can never overwrite
// an existing phone, by design; this is a separate, narrower, verified path.
const PHONE_CHANGE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour, Aaron's explicit choice

// Email-change confirmation, added 2026-09-02 -- same shape as the phone
// flow above, but confirmed via a text to the EXISTING (unchanged) phone
// number rather than needing real email-sending infrastructure this
// project doesn't have. Email is also, unlike phone, the actual identity/
// lookup key for a visitor's row -- once a change is confirmed, that
// visitor's device-local `iah_gate_email` no longer resolves via /my-info
// (a 404), which the frontend treats as "re-pass the gate," self-healing
// without any cross-device state sync.
const PENDING_EMAIL_TAB = "Pending Email Changes";
const EMAIL_CHANGE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour, same window as phone changes

// Quo (OpenPhone) -- same base URL/auth shape as tools/quo.mjs on the
// droplet ("Authorization: <key>", no Bearer prefix -- confirmed against
// Quo's own docs, which explicitly say they don't use Bearer tokens).
// PN6pbOQwqH is the "Filling" number (618-418-4180), the one this whole
// site's Call/Text buttons point at -- new-visitor contacts get checked/
// created against conversations on this specific number, not "any number."
const QUO_BASE = "https://api.quo.com/v1";
const FILLING_PHONE_NUMBER_ID = "PN6pbOQwqH";

const ALLOWED_ORIGINS = [
  "https://8aardav8.github.io",
  "https://instantapprovalhomes.com",
  "https://www.instantapprovalhomes.com",
];
// Kept for the few call sites that build a response inline (OPTIONS,
// jsonResponse's default) before the real Origin is known -- the actual
// per-request origin gets applied afterward by the fetch() wrapper below,
// which overwrites this default when the request's Origin is on the
// allowlist. Anything not on the allowlist (or no Origin header at all,
// e.g. a direct curl/server call) just keeps this default, unchanged from
// the original single-origin behavior.
const ALLOWED_ORIGIN = ALLOWED_ORIGINS[0];

// Same slug logic as scripts/generate_properties.py's slugify() -- MUST
// stay in sync, since this is how an incoming public listing id gets
// matched back to its real Sheet row.
function slugify(address) {
  let s = (address || "").trim().toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  return s || "listing";
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ---------- verify the caller is really Aaron (job 1 only) ----------
async function verifyIdToken(idToken) {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) return { ok: false, reason: "token-invalid" };
    const info = await res.json();
    if (info.aud !== OAUTH_CLIENT_ID) return { ok: false, reason: "wrong-audience" };
    if (info.email_verified !== "true" && info.email_verified !== true) return { ok: false, reason: "email-not-verified" };
    if ((info.email || "").toLowerCase() !== AARON_EMAIL.toLowerCase()) return { ok: false, reason: "wrong-email" };
    return { ok: true };
  } catch (e) {
    // Network hiccup calling Google's own verification endpoint -- fail
    // closed (treat as unverified) rather than let this throw uncaught and
    // surface a raw Cloudflare error page instead of a clean JSON response.
    return { ok: false, reason: "verification-request-failed" };
  }
}

// ---------- service-account auth for the Sheets API ----------
// Scope broadened from spreadsheets.readonly to full spreadsheets (2026-08-27)
// so the same token function covers both jobs -- job 1's read stays exactly
// as safe as before (a broader-scoped token can still only do what the
// underlying Drive-level share permission actually allows; read-only code
// paths here never call an append/write endpoint regardless of scope).
function base64UrlFromBytes(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlFromString(str) {
  return base64UrlFromBytes(new TextEncoder().encode(str));
}
function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getSheetsAccessToken(env) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: env.GCP_SA_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(claims))}`;

  const keyData = pemToArrayBuffer(env.GCP_SA_PRIVATE_KEY);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64UrlFromBytes(new Uint8Array(signature))}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`);
  const tokenJson = await tokenRes.json();
  return tokenJson.access_token;
}

async function fetchSheetRows(accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(SHEET_TAB)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`sheets read failed: ${await res.text()}`);
  const data = await res.json();
  return data.values || [];
}

// ---------- job 2: direct App: Logins write + Quo upsert (rearchitected 2026-08-28/29) ----------
// Reads column A:B fresh on every call rather than trusting a cache, same
// standing "always read the live sheet's current state before writing"
// rule this project applies everywhere else. Dedup by email, same as the
// original App: Logins cleanup -- a returning visitor (cleared localStorage,
// new device) updates their EXISTING row's Last Login rather than getting
// a second row. Named distinctly from /sync-visitor's own
// findLoginsRowByEmail (further below) since that one has a different
// contract (returns a bare row number or null, never creates) -- this one
// always returns a row to write to, existing or the next free one.
// Reads A:F (not just A:B) so a returning-visitor write can see the
// existing Phone/Name/ID Link values -- added 2026-08-29 alongside the
// backfill fix below, real reported bug: a legacy row from before the gate
// collected Name/Phone (or one where a prior submission simply never
// captured them) never got backfilled on a later visit that DID provide
// real values, since writeLoginsRow's returning-visitor branch only ever
// touched Last Login.
// Real gap found and fixed 2026-09-14, per Aaron's direct question ("if
// anyone signs in for the first time using a phone number that's already
// in the sheet... their name and email... will just be added to that
// row?"): traced through and confirmed the answer was NO -- this matched
// EMAIL only, so a visitor's first-ever gate sign-in with a phone that
// already had a row (from a Quo conversation, tonight's Sheet backfill, or
// anything else phone-first) would create a genuine DUPLICATE row instead
// of reusing the existing one, since their (new) email never matched
// anything.
//
// Priority flipped the same day, per Aaron's direct follow-up ("base
// everything off phone numbers now since we're not using Glide -- Glide
// was missing phone numbers, but Quo and the current site always take a
// phone number"): PHONE is now the primary match, email only a fallback
// for matching a legacy Glide-era row (email + name, no phone at all --
// exactly the shape email-matching existed for in the first place). Every
// row created by anything BUT old Glide already guarantees a real phone
// (isPlausiblePhone is a hard requirement at both call sites below), so
// phone is now the more reliable identity signal, not email.
// Also returns existingEmail/existingAgreed so writeLoginsRow below can
// fill those in too, same non-destructive "only fill a gap" stance already
// applied to phone/name.
async function findOrNextLoginsRow(accessToken, email, phone) {
  const range = encodeURIComponent(`${LOGINS_TAB}!A:F`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`logins read failed: ${await res.text()}`);
  const data = await res.json();
  const col = data.values || [];
  const targetEmail = email.trim().toLowerCase();
  const targetPhone = phone ? toE164(phone) : "";
  let emailMatchIndex = -1;
  let phoneMatchIndex = -1;
  for (let i = 1; i < col.length; i++) {
    const existing = col[i] || [];
    if (emailMatchIndex === -1 && (existing[1] || "").trim().toLowerCase() === targetEmail) {
      emailMatchIndex = i;
    }
    if (targetPhone && phoneMatchIndex === -1 && toE164((existing[3] || "").trim()) === targetPhone) {
      phoneMatchIndex = i;
    }
    // Stop early once both are found (or phone doesn't apply) -- no point
    // scanning the rest of a 700+ row sheet once nothing left to learn.
    if (phoneMatchIndex !== -1 && (emailMatchIndex !== -1 || !targetEmail)) break;
  }
  // Phone wins if found anywhere -- email is the fallback, used only when
  // phone matches nothing (the legacy-Glide case, or a phone typo).
  const matchIndex = phoneMatchIndex !== -1 ? phoneMatchIndex : emailMatchIndex;
  if (matchIndex !== -1) {
    const existing = col[matchIndex] || [];
    return {
      row: matchIndex + 1, // 1-indexed sheet row
      isNew: false,
      existingEmail: (existing[1] || "").trim(),
      existingAgreed: (existing[2] || "").trim(),
      existingPhone: (existing[3] || "").trim(),
      existingName: (existing[4] || "").trim(),
      existingIdLink: (existing[5] || "").trim(),
    };
  }
  return { row: col.length + 1, isNew: true };
}

// Writes the full A:G span for a gate-login event. For a brand-new visitor
// this fills First Login through Last Login (columns A-G). For a returning
// visitor (isNew: false) this writes Email/Agreed/Phone/Name/Last Login
// (B, C, D, E, G) -- NOT a blind overwrite: each of Email/Agreed/Phone/Name
// keeps its EXISTING value if one is already on file, and only takes the
// newly-submitted value to fill in a gap that was previously blank (see
// findOrNextLoginsRow above, which supplies existingEmail/existingAgreed/
// existingPhone/existingName/existingIdLink for exactly this).
// Email/Agreed added 2026-09-14, alongside findOrNextLoginsRow's new
// phone-fallback match -- without this, reusing a phone-matched row (one
// found via that fallback, not by email) would fill in Phone/Name but
// leave Email permanently blank, since this branch never touched B/C at
// all before. Real reported bug, fixed 2026-08-29: this used to only ever
// touch Last Login for a returning visitor, so a legacy blank-Name row
// (e.g. from before the gate collected a name at all) could never be
// filled in later, even by a visitor who then typed their real name on a
// subsequent visit. ID Link (F) is always echoed back untouched either
// way -- the gate never collects it, so there's nothing to backfill or
// protect there, just don't let it get wiped by the batch write.
// Explicit-row values.update, not :append -- see the real auto-detection
// bug this avoided, documented in git history for this file (values:append
// landed a real submission's data starting at column O instead of A, on a
// row far past the real last row).
async function writeLoginsRow(accessToken, target, { name, email, phone, agreed }) {
  const { row, isNew } = target;
  const nowIso = new Date().toISOString();
  if (isNew) {
    const values = [[nowIso, email, agreed ? "TRUE" : "FALSE", phone, name, "", nowIso]];
    const range = encodeURIComponent(`${LOGINS_TAB}!A${row}:G${row}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!A${row}:G${row}`, values }),
    });
    if (!res.ok) throw new Error(`logins row create failed: ${await res.text()}`);
  } else {
    const finalEmail = target.existingEmail || email || "";
    const finalAgreed = target.existingAgreed || (agreed ? "TRUE" : "");
    const finalPhone = target.existingPhone || phone || "";
    const finalName = target.existingName || name || "";
    const finalIdLink = target.existingIdLink || "";
    const values = [[finalEmail, finalAgreed, finalPhone, finalName, finalIdLink, nowIso]];
    const range = encodeURIComponent(`${LOGINS_TAB}!B${row}:G${row}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!B${row}:G${row}`, values }),
    });
    if (!res.ok) throw new Error(`logins row update failed: ${await res.text()}`);
  }
}

// Writes just the Quo Link column (N) once a contact id is known -- kept
// separate from writeLoginsRow so a Quo hiccup (see handleGateLogin's try/
// catch below) never blocks the core Sheet write that already succeeded.
async function writeQuoLink(accessToken, row, quoLink) {
  const range = encodeURIComponent(`${LOGINS_TAB}!N${row}:N${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${LOGINS_TAB}!N${row}:N${row}`, values: [[quoLink]] }),
  });
  if (!res.ok) throw new Error(`quo-link write failed: ${await res.text()}`);
}

// Writes just the ID Link column (F) once a real Dropbox shared link is
// known -- same isolated-single-column pattern as writeQuoLink above.
// Deliberately NOT folded into writeLoginsRow's own idLink handling (which
// only ever PRESERVES an existing value, never accepts a new one) -- a
// fresh upload should always win over whatever was there before.
async function writeIdLink(accessToken, row, idLink) {
  const range = encodeURIComponent(`${LOGINS_TAB}!F${row}:F${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${LOGINS_TAB}!F${row}:F${row}`, values: [[idLink]] }),
  });
  if (!res.ok) throw new Error(`id-link write failed: ${await res.text()}`);
}

// ID Name (OCR) -- column AG, added 2026-09-12. See handleInternalAutoLinkId's
// own comment for why this is kept separate from the Name column (E,
// which is the IAH login name) and the Quo contact's own name.
async function writeIdName(accessToken, row, idName) {
  const range = encodeURIComponent(`${LOGINS_TAB}!AG${row}:AG${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${LOGINS_TAB}!AG${row}:AG${row}`, values: [[idName]] }),
  });
  if (!res.ok) throw new Error(`id-name write failed: ${await res.text()}`);
}

// "Manual Area Override" -- column AD, added 2026-09-12 per Aaron's direct
// request to set a buyer's area WITHOUT necessarily also renaming their
// Quo contact (see handleAdminSetAreas below). admin-buyers-worker.js's
// own area-merge pass already reads this same tab's "Filter: Area(s)"
// column (self-reported search filter) and unions it into b.areas -- this
// is a DIFFERENT column on purpose, so Aaron's manual override never
// overwrites/loses whatever a buyer actually typed into the site's own
// area search. iah-buyers' buyer-list builder needs one added line to
// also read+merge THIS column -- see that Worker's own comment.
async function writeManualAreaOverride(accessToken, row, areasCsv) {
  const range = encodeURIComponent(`${LOGINS_TAB}!AD${row}:AD${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${LOGINS_TAB}!AD${row}:AD${row}`, values: [[areasCsv]] }),
  });
  if (!res.ok) throw new Error(`area-override write failed: ${await res.text()}`);
}

// Sentiment (AE) and Stage (AF), added 2026-09-12 per Aaron's direct
// request -- a personal-impression emoji and a pipeline stage per buyer,
// both purely his own manual notes. Single-column writes, same pattern as
// writeManualAreaOverride above.
const SENTIMENT_VALUES = new Set(["smile", "neutral", "frown"]);
// "Full Down Received" added 2026-09-15 per Aaron's direct request, right
// after "Deposit Received" (stage 6) and before "Buyer" -- keep in sync
// with BUYER_STAGES in docs/js/app.js if this list ever changes again.
const STAGE_VALUES = [
  "First Contact", "ID Verified", "Showing Scheduled", "First Showing Done",
  "Multiple Showings", "Deposit Received", "Full Down Received", "Buyer", "Multiple Buyer",
];
async function writeSentiment(accessToken, row, sentiment) {
  const range = encodeURIComponent(`${LOGINS_TAB}!AE${row}:AE${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${LOGINS_TAB}!AE${row}:AE${row}`, values: [[sentiment]] }),
  });
  if (!res.ok) throw new Error(`sentiment write failed: ${await res.text()}`);
}
async function writeStage(accessToken, row, stage) {
  const range = encodeURIComponent(`${LOGINS_TAB}!AF${row}:AF${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${LOGINS_TAB}!AF${row}:AF${row}`, values: [[stage]] }),
  });
  if (!res.ok) throw new Error(`stage write failed: ${await res.text()}`);
}

// "Hidden" -- column AH, added 2026-09-15 per Aaron's direct request:
// swipe-to-hide a buyer card off the default list, with a "show hidden"
// toggle and a Hidden/Not-hidden filter. Stored as the literal string
// "TRUE"/"" (not a real boolean -- Sheets values are always strings over
// the API either way), same pattern as every other single-column writer
// above. Column AG (ID Name/OCR) is the last one currently in use, so
// this is the very next column -- see handleAdminSetHidden below for the
// row-lookup/auto-create wrapper.
async function writeHidden(accessToken, row, hidden) {
  const range = encodeURIComponent(`${LOGINS_TAB}!AH${row}:AH${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${LOGINS_TAB}!AH${row}:AH${row}`, values: [[hidden ? "TRUE" : ""]] }),
  });
  if (!res.ok) throw new Error(`hidden write failed: ${await res.text()}`);
}

// "DNC" (Do Not Contact/Call) -- column AI, added 2026-09-16 per Aaron's
// direct request: label a buyer DNC to remove them from every automated
// Quo text this system sends (appointment-notifier-worker.js checks this
// same column before texting). Same "TRUE"/"" string convention as
// Hidden -- AH is the last column in use, this is the next one.
//
// Every reader of this column (admin-buyers-worker.js, appointment-
// notifier-worker.js) finds it by literal header text via
// headers.indexOf('DNC') -- NOT a hardcoded column letter. Since this is
// a brand-new column nobody has ever typed a header into, every write
// here also stamps AI1 = "DNC" first (idempotent, negligible extra cost
// given how rarely this endpoint is actually called) -- otherwise this
// would repeat the EXACT bug just fixed for Hidden/Sentiment/Stage
// (loadLoginsByPhone's own comment above), just from day one instead of
// growing into it later: the write would silently succeed while every
// reader kept seeing -1/"" forever, since the header cell they search
// for would never actually exist.
async function ensureDncHeader(accessToken) {
  const range = encodeURIComponent(`${LOGINS_TAB}!AI1:AI1`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${LOGINS_TAB}!AI1:AI1`, values: [["DNC"]] }),
  });
  // Best-effort -- if this one fails, the actual value write below still
  // throws its own clear error, and a missing header is easy to spot/fix
  // by hand in the Sheet directly.
}
async function writeDnc(accessToken, row, dnc) {
  await ensureDncHeader(accessToken);
  const range = encodeURIComponent(`${LOGINS_TAB}!AI${row}:AI${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${LOGINS_TAB}!AI${row}:AI${row}`, values: [[dnc ? "TRUE" : ""]] }),
  });
  if (!res.ok) throw new Error(`dnc write failed: ${await res.text()}`);
}

// ---------- Quo (OpenPhone) contact upsert -- ported from tools/quo.mjs ----------
// Same auth/base URL, same "PATCH replaces defaultFields wholesale, always
// fetch-then-merge" gotcha, same firstName-required-on-create gotcha, same
// targeted-pagination approach -- all confirmed live already by the
// droplet script this is ported from. Kept here as a straight port rather
// than re-derived, since Cloudflare Workers can't shell out to that script.
//
// Retry-on-429 added 2026-08-29, found by real live testing, not
// theoretical: Quo's rate limit is a real, tight 10 requests/SECOND
// (confirmed via the response's own `ratelimit` header). A single
// brand-new visitor whose phone doesn't match any existing contact can
// alone rack up to 10 sequential pagination calls (quoFindContactByPhone's
// own page cap) plus 1 create call -- 11 calls, over the limit on its own,
// with no external traffic involved at all. One retry after a touch over
// 1 second (the window's own reset period) is enough since the limit is
// per-second, not a longer cooldown -- confirmed live, a request that 429s
// succeeds cleanly on retry once the next second's quota opens up.
async function quoCall(env, path, params) {
  const url = new URL(QUO_BASE + path);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: env.QUO_API_KEY } });
    if (res.status === 429 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(`quo ${path} failed (${res.status}): ${JSON.stringify(data)}`);
    return data;
  }
}

// Visitors type phone numbers in all sorts of shapes ("(618) 555-1234",
// "6185551234", etc.) -- Quo's own numbers are always E.164. Normalizes
// assuming US/+1 when no country code is present, since that's the real
// population this site serves; a number that's already E.164-shaped
// (leading "+") passes through untouched.
function toE164(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  if ((phone || "").trim().startsWith("+")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return digits ? `+${digits}` : "";
}

// Real bug found and fixed 2026-09-13/14: the old 10-page cap (500
// contacts) against a ~2800+-contact workspace meant this function's
// success was essentially a coin flip for anyone not near the front of
// Quo's own list ordering -- confirmed live and reproduced directly: the
// exact same phone (+13142953192, "jasmine jelks") resolved via
// /internal/resync-buyer, then came back NOT FOUND moments later via
// /internal/raw-contact and via syncBuyerToSheet, with nothing else
// changing between calls. Quo's own contact-list ordering isn't stable
// call-to-call, so a contact sitting past position ~500 at one moment can
// sit before it the next -- this was the real, larger root cause behind
// tonight's whole "names aren't populating" incident, bigger than the
// ensureBuyerInCache freeze bug found earlier. Raised to 40 pages (2000
// contacts) -- matches the cap already proven safe in
// handleInternalFindQuoContact, and leaves enough of the Workers free
// plan's 50-subrequest-per-invocation budget for whatever else the calling
// handler does in the same request (checked every caller: none does more
// than a handful of other subrequests). Not a full guarantee for a contact
// sitting past 2000, but a real, large improvement over 500.
async function quoFindContactByPhone(env, e164Phone) {
  let pageToken;
  for (let page = 0; page < 40; page++) {
    const resp = await quoCall(env, "/contacts", { maxResults: "50", pageToken });
    const found = (resp.data || []).find((c) => (c.defaultFields.phoneNumbers || []).some((p) => p.value === e164Phone));
    if (found) return found;
    if (!resp.nextPageToken) break;
    pageToken = resp.nextPageToken;
  }
  return null;
}

// Writes a buyer's checked areas directly onto their Quo contact's own
// `role` field, added 2026-09-13 per Aaron's direct request. A Quo
// multi-select CUSTOM FIELD was investigated and ruled out first: Quo's
// own docs confirm custom field DEFINITIONS -- including adding one new
// option to an already-existing multi-select -- can only ever be created
// or modified in Quo's own UI, never via the API. That would have meant
// Aaron manually re-syncing Quo every time the Filling Sheet's Area
// column changes -- exactly the "forgetting to do this could cause
// problems" risk he flagged directly. `role` sidesteps that completely:
// it's a plain free-text field, no predefined option list, no Quo-side
// setup ever required. Chose `role` over `company` specifically -- some
// real buyers genuinely are LLCs who might legitimately want a real
// company name recorded there someday, so `role` is the safer field to
// repurpose (confirmed both are always null across every real contact
// sampled live before this decision). Stores the EXACT canonical area
// label strings, comma-joined -- not invented short codes -- so there's
// no regex/substring-collision risk like the original TB-tag system had
// (a real bug there already cost a day: \bWM\b could never match its own
// fused "WMTB" form). Works for any number of areas with zero code
// changes when the Filling Sheet's own Area column changes -- the
// buyers-page checkbox list already reads that live (allBuyersFilterAreas
// in app.js); this function just serializes whatever's currently checked.
async function writeContactAreas(env, phone, areas) {
  const contact = await quoFindContactByPhone(env, toE164(phone));
  if (!contact) return; // no Quo contact for this phone yet -- nothing to write onto
  // Fetch-then-merge the FULL existing defaultFields before writing back --
  // same gotcha already documented elsewhere (tools/quo.mjs's own
  // upsert-contact-email): Quo's PATCH replaces defaultFields wholesale,
  // so writing { role } alone would silently wipe name/phone/email too.
  await quoWrite(env, `/contacts/${contact.id}`, "PATCH", {
    // "TB" ("Term Buyer" -- Aaron's own convention, confirmed 2026-09-13)
    // for zero areas checked, not "" or null -- real, confirmed API
    // limitation: Quo's contact PATCH silently ignores a falsy `role`
    // value rather than clearing it (tested live: 17 areas -> "AL" wrote
    // and read back correctly instantly; either "" or null -> stayed
    // stuck on the previous real value every time). Writing "TB" sidesteps
    // this entirely since it's always non-empty, and reads naturally as
    // "a buyer, no specific area yet" rather than a confusing leftover
    // value from whatever was checked before.
    //
    // Real bug found and fixed 2026-09-13 during the first live backfill
    // across 429 existing buyers: 63 (~15%) failed with Quo rejecting the
    // PATCH outright -- "Item with ID ... does not match," always citing
    // the phoneNumbers[] entry's OWN id. First theory (an empty phone-
    // number `name` on the failures) was wrong -- fixing just the name
    // while keeping the existing id still failed identically. Real root
    // cause, confirmed by testing: the id Quo's GET returns for a phone
    // number entry doesn't always match what Quo's own PATCH validation
    // expects internally (every failure was an older contact, last
    // touched months ago -- looks like a real backend data-integrity
    // inconsistency on Quo's side, not anything about the data itself).
    // Fix: never echo phoneNumbers[].id back at all -- send only
    // {name, value}, which lets Quo assign a fresh internal id on write
    // instead of validating a possibly-stale one. Also normalizes any
    // blank name to "Mobile" as a side effect (harmless data-quality
    // improvement). Confirmed this resolves every one of the 63 failures
    // with zero regressions on contacts that already worked.
    defaultFields: {
      ...contact.defaultFields,
      phoneNumbers: (contact.defaultFields.phoneNumbers || []).map((p) => ({ name: p.name || "Mobile", value: p.value })),
      // Same stale-id issue, same fix -- found on a second batch of
      // failures after the phoneNumbers-only fix above: the rejected id
      // matched emails[].id instead, on a contact with a real email on
      // file. Any array-of-objects-with-an-id field on defaultFields
      // apparently carries this same risk; strip ids on emails too.
      emails: (contact.defaultFields.emails || []).map((e) => ({ name: e.name || "", value: e.value })),
      role: areas.length ? areas.join(", ") : "TB",
    },
  });
}

async function quoFindConversation(env, e164Phone) {
  let pageToken;
  for (let page = 0; page < 5; page++) {
    const resp = await quoCall(env, "/conversations", { phoneNumbers: FILLING_PHONE_NUMBER_ID, maxResults: "100", pageToken });
    const found = (resp.data || []).find((c) => (c.participants || []).includes(e164Phone));
    if (found) return found;
    if (!resp.nextPageToken) break;
    pageToken = resp.nextPageToken;
  }
  return null;
}

// Returns { action: "created"|"updated"|"none", contact }. Never throws for
// an ordinary "no email needed to add" case -- only throws on a real HTTP
// failure, which handleGateLogin's own try/catch treats as best-effort.
// Same retry-on-429 as quoCall (see its comment) -- for the write side.
// This matters even more here in practice: the PATCH/POST below runs
// immediately after quoFindContactByPhone's own up-to-10-call pagination
// sweep, so it's the single most likely call to land in the same
// rate-limit window that sweep just used up.
async function quoWrite(env, path, method, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${QUO_BASE}${path}`, {
      method,
      headers: { Authorization: env.QUO_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(`quo ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
    return data;
  }
}

async function quoUpsertContact(env, e164Phone, email, fullName) {
  const existing = await quoFindContactByPhone(env, e164Phone);
  if (existing) {
    const hasEmail = (existing.defaultFields.emails || []).some((e) => e.value);
    if (hasEmail) return { action: "none", contact: existing };
    const body = {
      defaultFields: {
        ...existing.defaultFields,
        emails: [...(existing.defaultFields.emails || []), { name: "Site login", value: email }],
      },
    };
    const data = await quoWrite(env, `/contacts/${existing.id}`, "PATCH", body);
    return { action: "updated", contact: data.data || data };
  }

  // firstName must be present (string or explicit null) on create -- Quo
  // 400s if the key is omitted entirely (confirmed live). The gate only
  // collects one "Full Name" field, so split on the first space.
  let firstName = null, lastName = null;
  if (fullName && fullName.trim()) {
    const parts = fullName.trim().split(/\s+/);
    firstName = parts[0];
    lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
  }
  const body = {
    source: "public-api",
    defaultFields: {
      firstName,
      lastName,
      phoneNumbers: [{ name: "Site login", value: e164Phone }],
      emails: [{ name: "Site login", value: email }],
    },
  };
  const data = await quoWrite(env, "/contacts", "POST", body);
  return { action: "created", contact: data.data || data };
}

// Very simple, deliberately non-strict validation -- this is a lead-capture
// gate, not a KYC form. Just enough to reject obvious garbage/empty submits.
function isPlausibleEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function isPlausiblePhone(v) { return (v || "").replace(/\D/g, "").length >= 10; }

// Informational-only ping (rearchitected 2026-08-28/29) -- a plain, one-way
// push via Telegram's own sendMessage API, independent of Nathan/NanoClaw
// entirely. No "reply to approve" language anymore -- the Sheet row and
// Quo contact are already written by the time this fires, so there is
// nothing left pending on a reply. Best-effort: if this fails (bad token,
// Telegram hiccup), the visitor is already fully processed regardless --
// this is purely a nicety notification, never load-bearing, so it never
// throws back to the caller.
// Called for a genuinely NEW visitor, or (added 2026-09-02, see
// handleGateLogin's call site below) for an EXISTING visitor whose phone
// was blank and just got filled in for the first time -- the real case
// this covers is someone migrating from the old Glide app, whose row
// predates the Phone/Name columns entirely. Deliberately NOT fired for an
// actual phone/email CHANGE -- that can't happen today by design (see
// writeLoginsRow's own comment: an existing non-blank value always wins),
// so there's no "updated" case to notify on yet.
async function pushTelegramPing(env, name, email, phone, quoResult, kind = "new") {
  if (!env.TELEGRAM_BOT_TOKEN) return; // secret not set yet -- just skip
  const headline =
    kind === "phone-backfilled"
      ? `Phone number added (first time on file) — ${name}, ${email}, ${phone}.`
      : kind === "email-backfilled"
      ? `Email added (first time on file, via gate sign-in) — ${name}, ${email}, ${phone}.`
      : `New site visitor — ${name}, ${email}, ${phone}.`;
  const lines = [headline];
  if (quoResult) {
    if (quoResult.action === "created") lines.push("New Quo contact created.");
    else if (quoResult.action === "updated") lines.push("Existing Quo contact updated with this email.");
    if (quoResult.contact && quoResult.contact.id) {
      lines.push(`Quo: https://my.quo.com/contacts/${quoResult.contact.id}`);
    }
  } else {
    lines.push("(Quo lookup/update failed -- check the Worker logs.)");
  }
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: AARON_TELEGRAM_CHAT_ID, text: lines.join("\n") }),
    });
  } catch (e) {
    // Swallowed deliberately -- see comment above.
  }
}

async function handleGateLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  const name = (body.name || "").trim();
  const email = (body.email || "").trim();
  const phone = (body.phone || "").trim();
  const agreed = !!body.agreed;

  if (!name) return jsonResponse({ error: "invalid name" }, 400);
  if (!isPlausibleEmail(email)) return jsonResponse({ error: "invalid email" }, 400);
  if (!isPlausiblePhone(phone)) return jsonResponse({ error: "invalid phone" }, 400);

  let accessToken, target;
  try {
    accessToken = await getSheetsAccessToken(env);
    // phone now passed through -- see findOrNextLoginsRow's own comment on
    // the phone-fallback match added 2026-09-14 (a first-ever gate sign-in
    // with a new email but a phone that already has a row used to create a
    // genuine duplicate row instead of reusing the existing one).
    target = await findOrNextLoginsRow(accessToken, email, phone);
    // Captured BEFORE writeLoginsRow, which is what actually fills the gap --
    // this reflects the row's state as it stood coming into this request.
    const phoneWasBlank = !target.isNew && !target.existingPhone;
    const emailWasBlank = !target.isNew && !target.existingEmail;
    await writeLoginsRow(accessToken, target, { name, email, phone, agreed });
    target.phoneJustBackfilled = phoneWasBlank && !!phone;
    // Mirrors phoneJustBackfilled -- the new real case this covers: a
    // buyer found only via the phone-fallback match above (a Quo
    // conversation, or tonight's Sheet backfill) signing into the gate for
    // the first time and having their email attached to that same row.
    target.emailJustBackfilled = emailWasBlank && !!email;
  } catch (e) {
    // The Sheet row is the one thing this endpoint can't silently skip --
    // if writing it fails, report the real error (app.js shows its own
    // generic "something went wrong" message to the visitor) rather than
    // claim success and quietly lose the lead.
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }

  // Everything below is best-effort enrichment (Quo contact, Telegram
  // ping) -- the core promise (a Sheet row now exists) is already
  // fulfilled above. A Quo hiccup or a bad Telegram token should never
  // turn into a visitor-facing error for something they already
  // successfully completed.
  let quoResult = null;
  try {
    const e164 = toE164(phone);
    if (e164) {
      quoResult = await quoUpsertContact(env, e164, email, name);
      if (quoResult && quoResult.contact && quoResult.contact.id) {
        await writeQuoLink(accessToken, target.row, `https://my.quo.com/contacts/${quoResult.contact.id}`);
      }
    }
  } catch (e) {
    quoResult = null; // pushTelegramPing reports this as a failure below, never throws
  }

  // Only ping for a GENUINELY new visitor -- fixed 2026-08-29, real
  // reported noise: a returning visitor re-passing the gate (trivially
  // easy to trigger just by testing in a fresh incognito window, which
  // wipes the "already passed" localStorage flag every time) was pinging
  // Telegram on every single re-submission, literally saying "New site
  // visitor" about someone who very much wasn't new. The Sheet row and Quo
  // upsert above still run unconditionally either way (both are correct,
  // idempotent housekeeping regardless of whether this is a first visit)
  // -- only the notification itself is gated on isNew now.
  //
  // Second case added 2026-09-02, Aaron's direct request: also ping when an
  // EXISTING row's phone was blank and just got filled in for the first
  // time (the real case: someone migrating from the old Glide app, whose
  // row predates the Phone/Name columns). Mutually exclusive with isNew by
  // construction -- phoneJustBackfilled can only be true when isNew is
  // false, see the capture above.
  if (target.isNew) {
    await pushTelegramPing(env, name, email, phone, quoResult);
  } else if (target.phoneJustBackfilled) {
    await pushTelegramPing(env, name, email, phone, quoResult, "phone-backfilled");
  } else if (target.emailJustBackfilled) {
    await pushTelegramPing(env, name, email, phone, quoResult, "email-backfilled");
  }

  return jsonResponse({ ok: true });
}

// ---------- job 1: admin listing lookup ----------
async function handleAdminLookup(request, env, listingId) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);

  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  try {
    const accessToken = await getSheetsAccessToken(env);
    const rows = await fetchSheetRows(accessToken);
    const headers = rows[0] || [];
    const addressCol = headers.indexOf("Address");

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const address = row[addressCol] || "";
      if (!address || slugify(address) !== listingId) continue;

      // Fixed 2026-08-22: dropped the "link to this row" idea entirely
      // (a docs.google.com link reliably opens the Sheets app on iOS
      // instead of the browser, with no code-side fix -- confirmed via
      // two different attempts). Per Aaron's direct request: just return
      // EVERY column's value for this row, generically, rather than a
      // hardcoded list of named fields. The frontend decides which of
      // these are already shown elsewhere on the public page and skips
      // those, showing everything else that has a value. This is also
      // more forward-compatible than the old 4-named-field response --
      // a new Sheet column just shows up automatically, no Worker
      // redeploy needed.
      const fields = {};
      headers.forEach((h, idx) => { fields[h] = row[idx] || ""; });
      return jsonResponse({ fields });
    }
    return jsonResponse({ error: "listing not found" }, 404);
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// ---------- job 6: admin bulk activity lookup (2026-08-29) ----------
// Aaron's request, admin-only: a small badge on every card showing how many
// people have an appointment scheduled AND a separate badge for how many
// have favorited it, plus who/when/contact-info (appointments) and who
// (favorites, with contact info too) on the detail page. Same admin auth
// as job 1 (verifyIdToken against AARON_EMAIL) -- this returns real names/
// emails/phones across ALL visitors, not just the caller's own, so it must
// never be reachable without a verified admin token.
//
// Deliberately ONE bulk read of the whole App: Logins tab (columns B-Y:
// Email, Phone, Name, the 10 appointment slots, and Favorites), not one
// read per listing -- with ~145+ rows and potentially hundreds of
// listings, a per-listing query would mean a query explosion for something
// cheap to compute from one full-tab read. The front end groups both flat
// results by address itself (for badge counts and per-listing detail
// lists) and decides what counts as "still upcoming" for appointments --
// this endpoint returns everything it finds, past or future, same
// "return raw, let the client filter" split already used elsewhere here.
// Favorites have no date at all (an unfavorite just removes it from the
// list entirely, nothing to filter by recency), so those are returned as-is.
async function handleAdminActivity(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);

  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  try {
    const accessToken = await getSheetsAccessToken(env);
    const range = encodeURIComponent(`${LOGINS_TAB}!B:Y`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`admin activity read failed: ${await res.text()}`);
    const data = await res.json();
    const rows = data.values || [];

    // Range starts at column B, so index 0 here = column B.
    // B=0(Email) C=1 D=2(Phone) E=3(Name) F=4 G=5 H=6 I=7 J=8 K=9 L=10 M=11
    // N=12 -- Appointment slots (O-X) at indices 13-22, Favorites (Y) at 23.
    const appointments = [];
    const favorites = [];
    for (let i = 1; i < rows.length; i++) { // row 0 is the header
      const row = rows[i];
      const email = (row[0] || "").trim();
      // Real bug found and fixed 2026-09-12: this used to be the RAW Sheet
      // cell, un-normalized -- most rows already have a leading "+1", but
      // at least one real row on file doesn't (a plain "3143498711"). The
      // client matches this appointment's phone against BUYERS_CACHE
      // (always E.164) to find the buyer's row and render the "Mark as
      // shown" checkbox -- a raw, non-E.164 phone here silently failed
      // that match for that one buyer, and the checkbox just never
      // rendered for her, with no error anywhere to notice. toE164() is
      // the same normalizer every other phone comparison in this file
      // already uses.
      const phone = toE164((row[2] || "").trim());
      const name = (row[3] || "").trim();
      const idLink = (row[4] || "").trim(); // added 2026-09-12, for the Appointments-tab card thumbnail
      for (let slot = 0; slot < 10; slot++) {
        const raw = (row[13 + slot] || "").trim();
        if (!raw) continue;
        // parseAppointmentCell (defined below, near
        // readAppointmentRawCells) now also returns a third field,
        // status, added 2026-09-15 per Aaron's direct request ("click to
        // reschedule or cancel existing appointments... marked as
        // no-show unless canceled or completed"). row/slot (1-indexed,
        // matching the real Sheet row and "Appointment N" column) exposed
        // too, so the client can target the exact cell for
        // /admin/update-appointment.
        const parsed = parseAppointmentCell(raw, slot + 1);
        if (parsed) appointments.push({ address: parsed.address, date: parsed.date, status: parsed.status, name, email, phone, idLink, row: i + 1, slot: slot + 1 });
      }
      const favRaw = (row[23] || "").trim();
      if (favRaw) {
        for (const address of favRaw.split(" | ")) {
          const trimmed = address.trim();
          if (trimmed) favorites.push({ address: trimmed, name, email, phone });
        }
      }
    }
    return jsonResponse({ appointments, favorites });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Public "most popular" sort support, added 2026-08-29 per Aaron's direct
// request. Deliberately a SEPARATE endpoint from /admin-activity above,
// not a public flag on that one -- /admin-activity returns real visitor
// names/emails/phones alongside favorites and is correctly auth-gated;
// this one reads the exact same Favorites column but only ever aggregates
// it down to a bare per-address COUNT, which carries no visitor identity
// at all, so it's safe to expose with no auth, same privacy line this
// project already draws everywhere else (counts are fine, identities are
// gated). Reads only column Y (not the full B:Y admin-activity needs),
// since a count doesn't need name/phone/email at all.
async function handleFavoriteCounts(request, env) {
  try {
    const accessToken = await getSheetsAccessToken(env);
    const range = encodeURIComponent(`${LOGINS_TAB}!Y2:Y`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`favorite counts read failed: ${await res.text()}`);
    const data = await res.json();
    const rows = data.values || [];
    const counts = {};
    for (const row of rows) {
      const favRaw = (row[0] || "").trim();
      if (!favRaw) continue;
      for (const address of favRaw.split(" | ")) {
        const trimmed = address.trim();
        if (!trimmed) continue;
        counts[trimmed] = (counts[trimmed] || 0) + 1;
      }
    }
    return jsonResponse({ counts });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// ---------- My Info lookup + name update, added 2026-09-02 ----------
// The read side of what lets "My Info" and Showings show genuinely synced
// data -- both fetch fresh from here rather than trusting a stale
// localStorage copy (the same class of staleness bug already found and
// fixed once this build in the appointment-prefill timing issue).
// Co-buyer slots stored as "<name> | <email> | <phone> | <idLink>" in
// columns Z (slot 1) / AA (slot 2) -- same flat, human-readable
// pipe-delimited convention already used for Favorites (column Y), chosen
// over JSON so Aaron/Nathan can read a slot directly as a plain cell.
function parseCoBuyerCell(raw) {
  if (!raw) return null;
  const parts = raw.split("|").map((s) => s.trim());
  const [name, email, phone, idLink] = parts;
  if (!name && !email && !phone) return null;
  return { name: name || "", email: email || "", phone: phone || "", idOnFile: !!idLink };
}

function buildCoBuyerCell(name, email, phone, idLink) {
  return [name || "", email || "", phone || "", idLink || ""].join(" | ");
}

// Pulls just the raw idLink field (4th pipe segment) out of a co-buyer
// cell, without the "is this cell populated at all" gating parseCoBuyerCell
// does -- used when preserving an existing link across an unrelated
// name/email/phone edit.
function extractCoBuyerIdLink(raw) {
  if (!raw) return "";
  const parts = raw.split("|").map((s) => s.trim());
  return parts[3] || "";
}

async function handleMyInfo(request, env) {
  // Changed from GET ?email= to POST body 2026-09-06 (gate-check finding,
  // confirmed real): a plain URL query string lands in Cloudflare's own
  // access logs on every request, so a visitor's email was being logged
  // just by them opening the My Info tab. No behavior change otherwise --
  // same lookup, same response shape.
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  // identityPhone added 2026-09-14, now the PRIMARY identity (see
  // findLoginsRowByIdentity's own comment) -- email kept as a fallback.
  // Named distinctly from the ON-FILE phone read from the row below (the
  // two can legitimately differ -- e.g. looking this up by email alone).
  const email = (body.email || "").trim();
  const identityPhone = (body.phone || "").trim();
  if (!isPlausiblePhone(identityPhone) && !isPlausibleEmail(email)) return jsonResponse({ error: "invalid identity" }, 400);

  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByIdentity(accessToken, identityPhone, email);
    if (!row) return jsonResponse({ error: "not found" }, 404);

    // Widened from D:F to B:F 2026-09-14 -- the response used to just
    // echo back whatever email the REQUEST carried, which silently went
    // wrong the moment phone became a valid way to look this up alone (no
    // email in the request at all): a phone-only request would report
    // email: "" even when the row genuinely has one on file. Now reads the
    // real on-file email (B) same as everything else here.
    const range = encodeURIComponent(`${LOGINS_TAB}!B${row}:F${row}`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`my-info read failed: ${await res.text()}`);
    const data = await res.json();
    const [onFileEmail, , phone, name, idLink] = (data.values || [[]])[0] || [];

    // Separate read for the Co-Buyer columns (Z:AA) -- kept isolated from
    // the D:F read above rather than widening it across 20+ intervening
    // columns (appointments, filters, favorites) that have nothing to do
    // with this response.
    const coRange = encodeURIComponent(`${LOGINS_TAB}!Z${row}:AA${row}`);
    const coRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${coRange}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!coRes.ok) throw new Error(`co-buyer read failed: ${await coRes.text()}`);
    const coData = await coRes.json();
    const [coBuyer1Raw, coBuyer2Raw] = (coData.values || [[]])[0] || [];
    const coBuyers = [parseCoBuyerCell(coBuyer1Raw), parseCoBuyerCell(coBuyer2Raw)];

    return jsonResponse({ name: name || "", phone: phone || "", email: onFileEmail || email || "", idOnFile: !!idLink, coBuyers });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Name has no real risk tied to it (unlike phone/email, it's not used as a
// lookup key or an identity-verification channel anywhere), so it writes
// directly -- no confirm-flow needed, matching the same reasoning already
// applied when this was scoped with Aaron.
// Telegram ping added 2026-09-13, per Aaron's direct request -- unlike
// Change Phone Number/Change Email (both disabled inputs gated behind a
// texted/emailed confirmation code before anything writes), this Save Name
// button overwrites the login name INSTANTLY with zero verification. Not
// changed to require a code (a name is low-stakes compared to phone/email,
// which are also identity-matching keys elsewhere in this file) -- just
// made visible, so a change at least surfaces old/new rather than silently
// overwriting with no trace. Deliberately does NOT touch the Quo contact's
// own name (see quoUpsertContact/handleAdminUpdateContactName for that,
// separate opt-in flow on the admin Buyer page) -- this is the LOGIN name
// only (Sheet column E), same field the gate itself protects via
// existingName || name in writeLoginsRow.
async function handleUpdateName(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  // phone added 2026-09-14, now the PRIMARY identity -- see
  // findLoginsRowByIdentity's own comment.
  const email = (body.email || "").trim();
  const phone = (body.phone || "").trim();
  const name = (body.name || "").trim();
  if (!isPlausiblePhone(phone) && !isPlausibleEmail(email)) return jsonResponse({ error: "invalid identity" }, 400);
  if (!name) return jsonResponse({ error: "invalid name" }, 400);

  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByIdentity(accessToken, phone, email);
    if (!row) return jsonResponse({ error: "not found" }, 404);

    const range = encodeURIComponent(`${LOGINS_TAB}!E${row}:E${row}`);
    const oldRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!oldRes.ok) throw new Error(`name read failed: ${await oldRes.text()}`);
    const oldData = await oldRes.json();
    const oldName = ((oldData.values || [[]])[0] || [])[0] || "";

    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!E${row}:E${row}`, values: [[name]] }),
    });
    if (!res.ok) throw new Error(`name update failed: ${await res.text()}`);

    // Awaited, not fire-and-forget -- see the real bug this avoids
    // documented on the phone/email-change Telegram notifies further down
    // this file (an unawaited promise can be killed the moment the
    // response returns in Workers).
    if (env.TELEGRAM_BOT_TOKEN && oldName !== name) {
      const text = `Login name CHANGED (My Info) — ${phone || email}.\nOld: ${oldName || "(blank)"}\nNew: ${name}`;
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: AARON_TELEGRAM_CHAT_ID, text }),
      }).catch(() => {});
    }

    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// ---------- Additional Buyers (co-buyers), added 2026-09-02 ----------
// Up to 2 co-buyer slots per visitor, per Aaron's explicit choice. Name/
// email/phone save independently of the ID upload (a visitor may fill in
// contact info before ever getting to the ID) -- this handler always
// PRESERVES whatever idLink is already in the slot's cell, same non-
// destructive stance as writeLoginsRow's own Phone/Name handling.
async function handleUpdateCoBuyer(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  // phone added 2026-09-14, now the PRIMARY identity -- see
  // findLoginsRowByIdentity's own comment. Distinct from coPhone below,
  // which is the CO-BUYER's own phone being saved, not visitor identity.
  const email = (body.email || "").trim();
  const phone = (body.phone || "").trim();
  const slot = Number(body.slot);
  const coName = (body.name || "").trim();
  const coEmail = (body.coBuyerEmail || "").trim();
  const coPhone = (body.coBuyerPhone || "").trim();
  if (!isPlausiblePhone(phone) && !isPlausibleEmail(email)) return jsonResponse({ error: "invalid identity" }, 400);
  if (slot !== 1 && slot !== 2) return jsonResponse({ error: "invalid slot" }, 400);
  if (!coName) return jsonResponse({ error: "invalid co-buyer name" }, 400);

  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByIdentity(accessToken, phone, email);
    if (!row) return jsonResponse({ error: "not found" }, 404);

    const col = slot === 1 ? "Z" : "AA";
    const range = encodeURIComponent(`${LOGINS_TAB}!${col}${row}:${col}${row}`);
    const existingRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!existingRes.ok) throw new Error(`co-buyer existing-cell read failed: ${await existingRes.text()}`);
    const existingData = await existingRes.json();
    const idLink = extractCoBuyerIdLink(((existingData.values || [[]])[0] || [])[0] || "");

    const cell = buildCoBuyerCell(coName, coEmail, coPhone, idLink);
    const writeRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!${col}${row}:${col}${row}`, values: [[cell]] }),
    });
    if (!writeRes.ok) throw new Error(`co-buyer write failed: ${await writeRes.text()}`);

    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Co-buyer ID upload -- mirrors handleUploadId's Dropbox mechanics (same
// folder, same overwrite-on-resubmit convention, same real shared-link
// creation) but simpler: no appointment/property/date involved, just a
// file attached to an already-saved co-buyer slot. Requires the slot's
// Name/Phone to already be saved (via /update-co-buyer first) since the
// filename convention needs both -- returns a clear error rather than
// inventing a placeholder name if they're missing.
async function handleUploadCoBuyerId(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return jsonResponse({ error: "invalid form data" }, 400);
  }
  // phone added 2026-09-14, now the PRIMARY identity -- see
  // findLoginsRowByIdentity's own comment.
  const email = (form.get("email") || "").toString().trim();
  const phone = (form.get("phone") || "").toString().trim();
  const slot = Number((form.get("slot") || "").toString());
  const idPhoto = form.get("idPhoto");

  if (!isPlausiblePhone(phone) && !isPlausibleEmail(email)) return jsonResponse({ error: "invalid identity" }, 400);
  if (slot !== 1 && slot !== 2) return jsonResponse({ error: "invalid slot" }, 400);
  if (!idPhoto || typeof idPhoto === "string") return jsonResponse({ error: "missing ID photo" }, 400);

  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByIdentity(accessToken, phone, email);
    if (!row) return jsonResponse({ error: "not found" }, 404);

    const col = slot === 1 ? "Z" : "AA";
    const range = encodeURIComponent(`${LOGINS_TAB}!${col}${row}:${col}${row}`);
    const cellRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!cellRes.ok) throw new Error(`co-buyer cell read failed: ${await cellRes.text()}`);
    const cellData = await cellRes.json();
    const rawCell = ((cellData.values || [[]])[0] || [])[0] || "";
    const [coName, coEmail, coPhone] = rawCell.split("|").map((s) => (s || "").trim());
    if (!coName || !coPhone) {
      return jsonResponse({ error: "co-buyer info missing", message: "Please save this co-buyer's name and phone first." }, 400);
    }

    const primaryRange = encodeURIComponent(`${LOGINS_TAB}!E${row}:E${row}`);
    const primaryRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${primaryRange}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!primaryRes.ok) throw new Error(`primary-name read failed: ${await primaryRes.text()}`);
    const primaryData = await primaryRes.json();
    const primaryName = ((primaryData.values || [[]])[0] || [])[0] || "";

    const dropboxToken = await getDropboxAccessToken(env);
    const filename = buildCoBuyerIdFilename(coName, coPhone, primaryName, idPhoto.name);
    const destPath = `${DROPBOX_IDS_FOLDER}/${filename}`;
    const fileBytes = await idPhoto.arrayBuffer();
    await archivePreviousIdPhoto(dropboxToken, destPath);

    const uploadRes = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dropboxToken}`,
        "Dropbox-API-Arg": JSON.stringify({ path: destPath, mode: "overwrite", mute: false }),
        "Content-Type": "application/octet-stream",
      },
      body: fileBytes,
    });
    if (!uploadRes.ok) throw new Error(`dropbox upload failed: ${await uploadRes.text()}`);

    const idLink = await createOrReuseSharedLink(dropboxToken, destPath);

    // Re-read the cell immediately before writing back (not the copy read
    // above) so a concurrent name/phone edit isn't clobbered by this
    // slower Dropbox round trip.
    const freshRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!freshRes.ok) throw new Error(`co-buyer fresh-cell read failed: ${await freshRes.text()}`);
    const freshData = await freshRes.json();
    const freshRaw = ((freshData.values || [[]])[0] || [])[0] || "";
    const [freshName, freshEmail, freshPhone] = freshRaw.split("|").map((s) => (s || "").trim());

    const cell = buildCoBuyerCell(freshName || coName, freshEmail || coEmail, freshPhone || coPhone, idLink);
    const writeRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!${col}${row}:${col}${row}`, values: [[cell]] }),
    });
    if (!writeRes.ok) throw new Error(`co-buyer id-link write failed: ${await writeRes.text()}`);

    if (env.TELEGRAM_BOT_TOKEN) {
      const text = `Co-buyer ID uploaded — ${coName} (co-buyer of ${primaryName}), ${coPhone}.\nFiled as: ${filename}\n${idLink}`;
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: AARON_TELEGRAM_CHAT_ID, text }),
      }).catch(() => {});
    }

    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// ---------- ID photo proxy, added 2026-09-02 ----------
// Real privacy concern this exists to solve: the ID Link column holds a
// PERMANENT, PUBLIC Dropbox shared link (fine for Aaron's own Sheet/
// Telegram use, since only he sees those) -- embedding that link directly
// in the site's own HTML to show a thumbnail would put a real, permanent,
// unauthenticated link to someone's government ID in the page source for
// anyone to find. Instead: never send the Dropbox URL to the browser at
// all. This endpoint downloads the actual file bytes server-side (using
// Quo -- no, Dropbox's own authenticated API, not the public link) and
// streams them back through this Worker's own domain. Access is gated the
// same way every other endpoint on this site already is -- knowing the
// visitor's own email -- deliberately not a stronger bar than the rest of
// the site, just not a weaker one either.
//
// Cached via Cloudflare's Cache API (no new binding/provisioning needed,
// built into every Worker) so a repeat view doesn't re-download the full
// file from Dropbox every single time -- real, deliberate tradeoff
// discussed with Aaron: a true per-request proxy alone would be slower on
// every view and burn more Dropbox API calls than a temporary-link
// redirect would; caching for an hour gets the full security benefit
// (Dropbox URL never reaches the browser) without paying that cost on
// every repeat view.
async function handleIdPhoto(request, env) {
  // Changed from GET ?email=/&coBuyerSlot= to POST body 2026-09-06, same
  // gate-check finding as handleMyInfo/handleMyAppointments. Browsers can't
  // POST from a plain <img src>, so the frontend now fetches this via
  // fetch()+POST and assigns the returned image as a blob object URL
  // instead of pointing <img> straight at the endpoint -- see app.js's
  // loadIdPhotoThumbnail. The cache key below is built as an explicit GET
  // request regardless of the real request's method, since Cache API only
  // matches/stores GET -- passing the real (now POST) request as init here
  // would have silently broken this cache and re-hit Dropbox on every view.
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  // phone added 2026-09-14, now the PRIMARY identity -- see
  // findLoginsRowByIdentity's own comment.
  const email = (body.email || "").trim();
  const phone = (body.phone || "").trim();
  // Optional -- added 2026-09-02 for co-buyer ID thumbnails. Absent/blank
  // means the primary buyer's own ID (column F), same as before.
  const coBuyerSlot = (body.coBuyerSlot || "").trim();
  if (!isPlausiblePhone(phone) && !isPlausibleEmail(email)) return jsonResponse({ error: "invalid identity" }, 400);
  if (coBuyerSlot && coBuyerSlot !== "1" && coBuyerSlot !== "2") {
    return jsonResponse({ error: "invalid coBuyerSlot" }, 400);
  }

  const cache = caches.default;
  const cacheSuffix = coBuyerSlot ? `-cobuyer${coBuyerSlot}` : "";
  // Cache key now keyed on whichever identity was actually sent, phone
  // preferred -- a phone-only request used to build a key from an empty
  // email string (every phone-only visitor colliding on the same cache
  // entry) before phone existed as valid identity here.
  const cacheKey = new Request(`https://id-photo-cache.internal/${encodeURIComponent((phone || email).toLowerCase())}${cacheSuffix}`, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByIdentity(accessToken, phone, email);
    if (!row) return jsonResponse({ error: "not found" }, 404);

    let sharedLink;
    if (coBuyerSlot) {
      const col = coBuyerSlot === "1" ? "Z" : "AA";
      const coRange = encodeURIComponent(`${LOGINS_TAB}!${col}${row}:${col}${row}`);
      const coRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${coRange}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!coRes.ok) throw new Error(`co-buyer ID link read failed: ${await coRes.text()}`);
      const coData = await coRes.json();
      sharedLink = extractCoBuyerIdLink(((coData.values || [[]])[0] || [])[0] || "");
    } else {
      const linkRange = encodeURIComponent(`${LOGINS_TAB}!F${row}:F${row}`);
      const linkRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${linkRange}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!linkRes.ok) throw new Error(`ID link read failed: ${await linkRes.text()}`);
      const linkData = await linkRes.json();
      sharedLink = ((linkData.values || [[]])[0] || [])[0] || "";
    }
    if (!sharedLink) return jsonResponse({ error: "no ID on file" }, 404);

    const dropboxToken = await getDropboxAccessToken(env);
    // sharing/get_shared_link_file -- downloads the actual file content
    // directly from an already-known shared link, no need to separately
    // track/derive the raw internal Dropbox path.
    const fileRes = await fetch("https://content.dropboxapi.com/2/sharing/get_shared_link_file", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dropboxToken}`,
        "Dropbox-API-Arg": JSON.stringify({ url: sharedLink }),
      },
    });
    if (!fileRes.ok) throw new Error(`dropbox file fetch failed: ${await fileRes.text()}`);

    // Real Dropbox behavior, confirmed live: this endpoint always returns
    // content-type: application/octet-stream regardless of the actual file
    // type -- not something fixable by reading a different header. The
    // real filename (with extension) IS available in the dropbox-api-
    // result header's JSON, though, so infer the correct image type from
    // that extension instead of trusting Dropbox's own content-type.
    let contentType = "image/jpeg"; // reasonable default -- ID_photo uploads only ever accept="image/*"
    const apiResultHeader = fileRes.headers.get("dropbox-api-result");
    if (apiResultHeader) {
      try {
        const meta = JSON.parse(apiResultHeader);
        const ext = (meta.name || "").split(".").pop().toLowerCase();
        const extMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic" };
        if (extMap[ext]) contentType = extMap[ext];
      } catch (e) {
        // fall through to the default above
      }
    }
    const bytes = await fileRes.arrayBuffer();
    const response = new Response(bytes, {
      status: 200,
      headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=3600", ...corsHeaders() },
    });

    await cache.put(cacheKey, response.clone());
    return response;
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// ---------- job 3: visitor filter-sync (2026-08-29) ----------
// Deliberately NOT an Approval Request / Telegram check-in like gate-login
// -- this only ever refreshes preference columns on a person who's already
// been through that flow and approved. It never creates a row and never
// touches First Login/Email/Agreed/Phone/Name/ID Link -- hard-scoped by
// which cells this function is even capable of writing to, not just an
// instruction. If the email isn't found (shouldn't normally happen, since
// the gate always runs first), this silently no-ops -- creating a row is
// exclusively the gate-login/approval path's job, never this one's.
async function findLoginsRowByEmail(accessToken, email) {
  const range = encodeURIComponent(`${LOGINS_TAB}!A:B`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`logins read failed: ${await res.text()}`);
  const data = await res.json();
  const col = data.values || [];
  const target = email.trim().toLowerCase();
  for (let i = 1; i < col.length; i++) {
    if ((col[i][1] || "").trim().toLowerCase() === target) return i + 1; // 1-indexed sheet row
  }
  return null;
}

// Added 2026-09-11 alongside the suggested-ID-matches fix -- most buyers
// with no App: Logins row at all can still need an ID filed against them
// (see computeSuggestedIdMatches' own comment). Reads D (Phone) directly
// rather than A:B like findLoginsRowByEmail above.
async function findLoginsRowByPhone(accessToken, phone) {
  const range = encodeURIComponent(`${LOGINS_TAB}!D:D`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`logins phone read failed: ${await res.text()}`);
  const col = (await res.json()).values || [];
  const target = toE164(phone);
  for (let i = 1; i < col.length; i++) {
    if (toE164((col[i][0] || "").trim()) === target) return i + 1; // 1-indexed sheet row
  }
  return null;
}

// Shared identity lookup, added 2026-09-14 -- phone is now the PRIMARY key
// across the whole visitor-facing self-service surface (My Info, My
// Showings, appointments, co-buyers), per Aaron's direct request: "base
// everything off phone numbers now since we're not using Glide -- Glide
// was missing phone numbers, but Quo and the current site always take a
// phone number." Email kept as a fallback, not removed -- covers a
// genuinely phone-less legacy Glide row, and a visitor's browser that
// still has an old cached page open at the exact moment of this rollout
// (self-healing on next reload, no hard cutover needed).
async function findLoginsRowByIdentity(accessToken, phone, email) {
  if (phone) {
    const row = await findLoginsRowByPhone(accessToken, phone);
    if (row) return row;
  }
  if (email) return await findLoginsRowByEmail(accessToken, email);
  return null;
}

// Appends a brand-new App: Logins row for a buyer who has none at all
// (the common case now that suggested-ID-matches is scoped to the full
// buyer list, not just existing Sheet rows) -- only Phone (D), Name (E),
// and ID Link (F) populated, everything else left blank since this
// wasn't a real site login. INSERT_ROWS via :append, not values.update
// with a guessed row number -- avoids a race against a concurrent append.
async function appendLoginsRow(accessToken, phone, name, idLink) {
  const range = encodeURIComponent(`${LOGINS_TAB}!A:F`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${LOGINS_TAB}!A:F`, values: [["", "", "", phone, name, idLink]] }),
  });
  if (!res.ok) throw new Error(`logins row append failed: ${await res.text()}`);
}

async function handleSyncVisitor(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  // phone added 2026-09-14, now the PRIMARY identity -- see
  // findLoginsRowByIdentity's own comment.
  const email = (body.email || "").trim();
  const phone = (body.phone || "").trim();
  if (!email && !phone) return jsonResponse({ error: "missing identity" }, 400);
  const filters = body.filters || {};
  const search = (body.search || "").trim();

  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByIdentity(accessToken, phone, email);
    if (!row) return jsonResponse({ ok: true, action: "skipped", reason: "no matching row -- sync never creates one" });

    // G:M only -- Last Login, Filter: Sort, Filter: Max Down, Filter: Max
    // Monthly, Filter: Min Beds, Filter: Area(s), Last Search. Explicit
    // range + values.update (not :append) -- same deliberate choice as
    // the gate-login Task write, for the same reason: no auto-detection
    // ambiguity, writes land exactly where specified, every time.
    const values = [[
      new Date().toISOString(),
      filters.sort ?? "",
      filters.down ?? "",
      filters.monthly ?? "",
      filters.beds ?? "",
      Array.isArray(filters.area) ? filters.area.join(", ") : "",
      search,
    ]];
    const range = encodeURIComponent(`${LOGINS_TAB}!G${row}:M${row}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!G${row}:M${row}`, values }),
    });
    if (!res.ok) throw new Error(`sync write failed: ${await res.text()}`);

    // Favorites, added 2026-08-29 per Aaron's direct request (admin
    // visibility into who's favorited a property) -- column Y, not
    // adjacent to G:M (N through X sit in between, untouched), so this is
    // a separate write. Guarded on Array.isArray so older cached
    // front-end code that doesn't send `favorites` at all can't
    // accidentally wipe this column with an unconditional empty write.
    if (Array.isArray(body.favorites)) {
      const favRange = encodeURIComponent(`${LOGINS_TAB}!Y${row}:Y${row}`);
      const favUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${favRange}?valueInputOption=RAW`;
      const favRes = await fetch(favUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ range: `${LOGINS_TAB}!Y${row}:Y${row}`, values: [[body.favorites.join(" | ")]] }),
      });
      if (!favRes.ok) throw new Error(`favorites sync write failed: ${await favRes.text()}`);
    }

    // Viewed Properties (column AC), added 2026-09-11 per Aaron's direct
    // request -- "houses they have viewed," distinct from Favorites (an
    // explicit heart-tap) and from Shown Properties (column AB, Aaron's
    // own admin-side record of what he's shown them -- see
    // handleMarkShown below). Same guarded/full-list-every-time pattern
    // as favorites above.
    if (Array.isArray(body.viewed)) {
      const viewedRange = encodeURIComponent(`${LOGINS_TAB}!AC${row}:AC${row}`);
      const viewedUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${viewedRange}?valueInputOption=RAW`;
      const viewedRes = await fetch(viewedUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ range: `${LOGINS_TAB}!AC${row}:AC${row}`, values: [[body.viewed.join(" | ")]] }),
      });
      if (!viewedRes.ok) throw new Error(`viewed sync write failed: ${await viewedRes.text()}`);
    }

    return jsonResponse({ ok: true, action: "updated", row });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// ---------- job 4: ID upload (2026-08-29) ----------
async function getDropboxAccessToken(env) {
  // Matches the droplet's own working tools/dropbox.mjs exactly -- client
  // credentials as body params, NOT HTTP Basic Auth. Confirmed live: Basic
  // Auth (the other technically-valid OAuth2 method) was tried first and
  // rejected outright ("Invalid client_id or client_secret") by this app's
  // registration, caught by testing rather than assumed to work either way.
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.DROPBOX_REFRESH_TOKEN,
      client_id: env.DROPBOX_APP_KEY,
      client_secret: env.DROPBOX_APP_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`dropbox token refresh failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// "<Last>, <First>" per Aaron's own stated convention -- splits on the
// LAST whitespace-separated word as the last name (handles a middle name
// reasonably; still an imperfect heuristic for suffixes/single names, same
// honest caveat as the Quo name-split). A last-4-of-phone suffix is always
// appended too -- Aaron's original ask flagged duplicate names as a real,
// unresolved collision risk ("recommend a date or short suffix, needs
// Aaron's call"); phone is already being collected here and guarantees
// uniqueness per person without needing a separate decision.
// "<Last>, <First> - <last4 of phone>" -- reverted back to this 2026-08-29
// after briefly trying "just their name" per Aaron's momentary correction,
// then his own follow-up: "I like your convention better." The phone
// suffix guarantees uniqueness per person without inventing a taxonomy --
// phone is already being collected on this same form. A real, deliberate
// side effect: if the SAME person re-submits later (a clearer photo, an
// updated ID), the filename comes out identical -- handled as an intentional
// overwrite (see mode: "overwrite" below), not an error, since same-name
// plus same-phone is a strong signal it's genuinely the same person.
function buildIdFilename(fullName, phone, originalFilename) {
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  const last = parts.length > 1 ? parts[parts.length - 1] : (parts[0] || "Unknown");
  const first = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
  const digits = (phone || "").replace(/\D/g, "");
  const last4 = digits.slice(-4) || "0000";
  const extMatch = /\.([a-zA-Z0-9]+)$/.exec(originalFilename || "");
  const ext = extMatch ? extMatch[1] : "jpg";
  const namePart = first ? `${last}, ${first}` : last;
  return `${namePart} - ${last4}.${ext}`;
}

// Same convention as buildIdFilename, extended with a co-buyer tag and the
// primary buyer's own last name -- Aaron's explicit choice (same Dropbox
// folder as the primary buyer's ID, not a separate one, distinguished by
// filename alone). "<CoBuyerLast>, <CoBuyerFirst> (Co-buyer of
// <PrimaryLast>) - <last4 of co-buyer phone>.<ext>".
function buildCoBuyerIdFilename(coBuyerName, coBuyerPhone, primaryName, originalFilename) {
  const base = buildIdFilename(coBuyerName, coBuyerPhone, originalFilename);
  const primaryParts = (primaryName || "").trim().split(/\s+/).filter(Boolean);
  const primaryLast = primaryParts.length ? primaryParts[primaryParts.length - 1] : "Unknown";
  const dot = base.lastIndexOf(".");
  const namePart = dot >= 0 ? base.slice(0, dot) : base;
  const extPart = dot >= 0 ? base.slice(dot) : "";
  return `${namePart} (Co-buyer of ${primaryLast})${extPart}`;
}

// Real regression found and fixed 2026-09-02: CLAUDE.md documented this as
// already built ("handleUploadId updated to create/reuse a real shared
// link, write it to ID Link") but the actual deployed code never had it --
// most likely an earlier direct-Cloudflare deploy this session was built
// from a stale local worker.js snapshot that predated the feature, silently
// dropping it on a later redeploy. Found by checking the real code before
// building co-buyer ID upload on top of it, not assumed from the docs.
// mode: "overwrite" already guarantees a re-upload reuses the same path, so
// the 409 fallback (list_shared_links) is the normal, expected path on any
// second-or-later upload for the same person, not a rare edge case.
async function createOrReuseSharedLink(dropboxToken, path) {
  const createRes = await fetch("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings", {
    method: "POST",
    headers: { Authorization: `Bearer ${dropboxToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (createRes.ok) {
    const data = await createRes.json();
    return data.url;
  }
  const errText = await createRes.text();
  if (!errText.includes("shared_link_already_exists")) {
    throw new Error(`dropbox create_shared_link failed: ${errText}`);
  }
  const listRes = await fetch("https://api.dropboxapi.com/2/sharing/list_shared_links", {
    method: "POST",
    headers: { Authorization: `Bearer ${dropboxToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, direct_only: true }),
  });
  if (!listRes.ok) throw new Error(`dropbox list_shared_links failed: ${await listRes.text()}`);
  const listData = await listRes.json();
  const link = (listData.links || [])[0];
  if (!link) throw new Error("dropbox: link reported existing but list_shared_links returned none");
  return link.url;
}

// ---------- ID photo preservation, added 2026-09-13 ----------
// Every upload path below uses mode: "overwrite" onto a path keyed off
// name+phone (buildIdFilename/buildCoBuyerIdFilename), not the original
// filename or a timestamp -- so a re-upload for the same person used to
// silently replace the old file's bytes in place, with nothing left to
// fall back on but Dropbox's own version history. Aaron asked to keep the
// old one instead ("dupe and rename before overwrite"). This copies
// whatever's currently at destPath into a dated "_previous_versions"
// subfolder BEFORE the new upload lands, so nothing is ever actually lost,
// while the live folder -- and everything that lists it non-recursively
// (handleInternalListIdFiles, handleAdminBrowseIdPhotos) -- still only ever
// shows the current photo. Best-effort and silent: a missing destPath
// (first-ever upload for this person) is the normal, expected case here,
// not an error, and any other hiccup shouldn't block the new upload, which
// is the actually-required part of the request.
async function archivePreviousIdPhoto(dropboxToken, destPath) {
  try {
    const slash = destPath.lastIndexOf("/");
    const dir = destPath.slice(0, slash);
    const name = destPath.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    const base = dot === -1 ? name : name.slice(0, dot);
    const ext = dot === -1 ? "" : name.slice(dot);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = `${dir}/_previous_versions/${base}-${stamp}${ext}`;
    const res = await fetch("https://api.dropboxapi.com/2/files/copy_v2", {
      method: "POST",
      headers: { Authorization: `Bearer ${dropboxToken}`, "Content-Type": "application/json" },
      // autorename guards the same-millisecond edge case; not expected in
      // practice but free insurance against ever losing the old copy.
      body: JSON.stringify({ from_path: destPath, to_path: archivePath, autorename: true }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (!errText.includes("from_lookup/not_found")) {
        console.error(`archivePreviousIdPhoto: copy failed for ${destPath}: ${errText}`);
      }
    }
  } catch (e) {
    console.error(`archivePreviousIdPhoto: unexpected error for ${destPath}: ${e}`);
  }
}

// ---------- Suggested ID matches, added 2026-09-11 ----------
// Aaron's own workflow: he drops ID photos he's collected some other way
// (in person, via text, wherever) straight into the Buyer IDs Dropbox
// folder, by hand, named however he named them -- not through the site's
// own upload form (which already names files via buildIdFilename above and
// writes ID Link itself). handleInternalListIdFiles and
// handleAdminBrowseIdPhotos (both below) use this to list that folder for
// Aaron's own manual browse/link flows.
async function listDropboxFolder(dropboxToken, path) {
  const entries = [];
  let res = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
    method: "POST",
    headers: { Authorization: `Bearer ${dropboxToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, recursive: false }),
  });
  if (!res.ok) throw new Error(`dropbox list_folder failed: ${await res.text()}`);
  let data = await res.json();
  entries.push(...(data.entries || []));
  while (data.has_more) {
    res = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
      method: "POST",
      headers: { Authorization: `Bearer ${dropboxToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ cursor: data.cursor }),
    });
    if (!res.ok) throw new Error(`dropbox list_folder/continue failed: ${await res.text()}`);
    data = await res.json();
    entries.push(...(data.entries || []));
  }
  return entries.filter((e) => e[".tag"] === "file");
}

// ---------- Buyer-page editing (admin UI), added 2026-09-12 ----------
// Per Aaron's direct request: "I'd like to be able to update the contacts
// from their page on the buyer site, eg associate them with areas, upload
// id which would go to Dropbox and be renamed with ocr, update Quo contact
// name, etc." Two endpoints below. Both OAuth-gated (same admin sign-in as
// everything else here, not the shared-secret internal tier) since these
// are real writes triggered by Aaron directly clicking something on the
// page, same trust level as the existing message-send feature.
//
// "Renamed with OCR" doesn't apply to THIS upload path specifically --
// when Aaron uploads a photo from a buyer's own page, the buyer is already
// known (that's literally which page he's on), so there's no name to read
// off the image at all; buildIdFilename runs directly off the known
// buyer's name and phone, same as the public site's own upload-my-id flow.
// OCR only matters for the OTHER path -- a file dropped straight into the
// Dropbox folder with no buyer context at all (id-photo-watch.ts).
async function handleAdminUploadId(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let form;
  try { form = await request.formData(); } catch { return jsonResponse({ error: "invalid form data" }, 400); }
  const phone = (form.get("phone") || "").toString().trim();
  const fullName = (form.get("fullName") || "").toString().trim();
  const idPhoto = form.get("idPhoto");
  const hasIdPhoto = !!idPhoto && typeof idPhoto !== "string" && idPhoto.size > 0;
  if (!phone || !hasIdPhoto) return jsonResponse({ error: "missing phone or idPhoto" }, 400);

  try {
    const [dropboxToken, accessToken] = await Promise.all([getDropboxAccessToken(env), getSheetsAccessToken(env)]);
    const filename = buildIdFilename(fullName, phone, idPhoto.name);
    const destPath = `${DROPBOX_IDS_FOLDER}/${filename}`;
    const fileBytes = await idPhoto.arrayBuffer();
    await archivePreviousIdPhoto(dropboxToken, destPath);
    const uploadRes = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dropboxToken}`,
        "Dropbox-API-Arg": JSON.stringify({ path: destPath, mode: "overwrite", mute: false }),
        "Content-Type": "application/octet-stream",
      },
      body: fileBytes,
    });
    if (!uploadRes.ok) return jsonResponse({ error: "dropbox upload failed", detail: await uploadRes.text() }, 500);

    const idLink = await createOrReuseSharedLink(dropboxToken, destPath);
    const row = await findLoginsRowByPhone(accessToken, phone);
    if (row) await writeIdLink(accessToken, row, idLink);
    else await appendLoginsRow(accessToken, toE164(phone), fullName, idLink);

    return jsonResponse({ ok: true, idLink, filename });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Sets a buyer's area(s) via the Manual Area Override column (AD) --
// independent of Quo entirely. Split out from the Quo-rename endpoint
// below 2026-09-12 per Aaron's direct request: "I'd like to update the
// areas associated but have a checkbox to opt in or out of updating the
// quo name" -- so the buyers-tab UI always calls this one on Save, and
// calls handleAdminUpdateContactName too only when that checkbox (default
// ON) is checked. Areas were originally ONLY derivable from a TB-tagged
// Quo name (see parseAreasFromName/CANONICAL_AREAS in
// admin-buyers-worker.js) -- this column gives Aaron a way to set them
// without touching Quo at all, merged additively into b.areas alongside
// the TB-tag signal (see that Worker's own area-merge comment).
async function handleAdminSetAreas(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const phone = (body.phone || "").trim();
  const fullName = (body.fullName || "").trim(); // used only if a brand-new row needs creating
  const areas = Array.isArray(body.areas) ? body.areas.filter((a) => typeof a === "string" && a.trim()) : [];
  if (!phone) return jsonResponse({ error: "missing phone" }, 400);

  try {
    // Real bug found and fixed 2026-09-13: every cache-patch call below
    // (and the ones like it in every other Set*/ID-link handler) only
    // ever finds-and-updates an EXISTING buyers_cache entry -- if this is
    // someone's very first interaction with the system (e.g. Aaron sets a
    // stage/area/ID before they've ever texted in), the patch silently
    // finds nothing and does nothing. The Sheet write below still
    // succeeds either way, but nothing shows on the site until the next
    // full crawl -- now up to 24h away since that interval was relaxed
    // the same day (see FULL_SYNC_INTERVAL_MS in admin-buyers-worker.js).
    // Real incident that surfaced this: Aaron set stage/area/ID for a
    // brand-new contact ("Mouton") and none of it appeared, even though
    // the Sheet had all three correctly. Calling ensureBuyerInCache first
    // guarantees a cache entry exists (creating a minimal one via a real
    // Quo lookup if needed) before any patch call below ever runs.
    await syncBuyerToSheet(env, toE164(phone));
    const accessToken = await getSheetsAccessToken(env);
    const areasCsv = areas.join(", ");
    const row = await findLoginsRowByPhone(accessToken, phone);
    if (row) await writeManualAreaOverride(accessToken, row, areasCsv);
    else await appendLoginsRow(accessToken, toE164(phone), fullName, ""); // create the row first (no ID Link yet), then set areas on it
    if (!row) {
      const newRow = await findLoginsRowByPhone(accessToken, phone);
      if (newRow) await writeManualAreaOverride(accessToken, newRow, areasCsv);
    }
    // Also written straight onto the Quo contact's own `role` field, added
    // 2026-09-13 -- see writeContactAreas' own comment for the full
    // reasoning (a Quo custom field was ruled out: definitions can only
    // ever be edited in Quo's UI, never via API). Best-effort/non-blocking
    // -- a Quo hiccup (rate limit, no contact yet) should never turn an
    // already-successful Sheet write into a failed response.
    try { await writeContactAreas(env, phone, areas); } catch (e) {}
    return jsonResponse({ ok: true, areas });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Lets Aaron schedule a showing for a buyer directly from their own
// buyers-tab page, added 2026-09-12 per his direct request ("set an
// appointment for a buyer for a property from their Buyer page... show on
// the house thumbnails and all of their appointments would show as cards
// on the Buyer page too"). Reuses addAppointment (see "job 5: appointment
// scheduling" below) -- the SAME Sheet write the public Get Started
// booking flow already makes, into the SAME Appointment 1-10 columns --
// so nothing else needs to change: the property-card admin-appointment
// badge (ADMIN_APPOINTMENTS_BY_ADDRESS, populated from this same data)
// and the buyer detail page's own Scheduled Showings section both already
// read from here and pick this up automatically once the buyers-cache
// background sync re-reads the Sheet.
async function handleAdminAddAppointment(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const phone = (body.phone || "").trim();
  const fullName = (body.fullName || "").trim();
  const address = (body.address || "").trim();
  const date = (body.date || "").trim(); // "YYYY-MM-DD", same shape addAppointment/parseAppointmentCell already expect
  if (!phone || !address || !date) return jsonResponse({ error: "missing phone, address, or date" }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: "date must be YYYY-MM-DD" }, 400);

  try {
    // See handleAdminSetAreas' own comment for why this runs first.
    await syncBuyerToSheet(env, toE164(phone));
    const accessToken = await getSheetsAccessToken(env);
    let row = await findLoginsRowByPhone(accessToken, phone);
    if (!row) {
      await appendLoginsRow(accessToken, toE164(phone), fullName, "");
      row = await findLoginsRowByPhone(accessToken, phone);
      if (!row) throw new Error("could not find or create a row for this buyer");
    }
    await addAppointment(accessToken, row, address, date);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Reschedule (new date, status reset to Scheduled), Cancel (status
// "Canceled"), or set an outcome (status "Completed"/""/"Canceled") on
// ONE existing appointment slot -- added 2026-09-15 per Aaron's direct
// request ("click to reschedule or cancel existing appointments" on both
// the Appointments-tab cards and the buyer's own page). One endpoint for
// all three actions -- they're really the same write (overwrite one
// slot's cell with a new address/date/status combo), just different
// fields changed by the caller. row/slot come from handleAdminActivity's
// own response (added there the same day) -- re-verified against a fresh
// phone lookup before writing, same "never trust a stale row number"
// caution writeIdLink's own callers already use elsewhere in this file,
// in case the Sheet's rows shifted since the client last loaded.
async function handleAdminUpdateAppointment(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const phone = (body.phone || "").trim();
  const slot = Number(body.slot);
  const address = (body.address || "").trim();
  const date = (body.date || "").trim();
  const status = (body.status || "").trim();
  if (!phone || !address || !date) return jsonResponse({ error: "missing phone, address, or date" }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: "date must be YYYY-MM-DD" }, 400);
  if (!Number.isInteger(slot) || slot < 1 || slot > APPOINTMENT_SLOT_COUNT) return jsonResponse({ error: "invalid slot" }, 400);
  if (status && status !== "Canceled" && status !== "Completed") return jsonResponse({ error: "invalid status" }, 400);

  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByPhone(accessToken, phone);
    if (!row) return jsonResponse({ error: "buyer not found" }, 404);
    const col = APPOINTMENT_COLS[slot - 1];
    const range = encodeURIComponent(`${LOGINS_TAB}!${col}${row}:${col}${row}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
    const cellValue = buildAppointmentCell(address, date, status);
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!${col}${row}:${col}${row}`, values: [[cellValue]] }),
    });
    if (!res.ok) return jsonResponse({ error: "appointment write failed", detail: await res.text() }, 500);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Sets (or clears, with sentiment: "") a buyer's personal-impression
// sentiment. Added 2026-09-12 per Aaron's direct request -- purely his own
// note, no confirmation dialog needed client-side (unlike areas/name,
// this never touches Quo or anything a third party would see).
async function handleAdminSetSentiment(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const phone = (body.phone || "").trim();
  const fullName = (body.fullName || "").trim();
  const sentiment = (body.sentiment || "").trim();
  if (!phone) return jsonResponse({ error: "missing phone" }, 400);
  if (sentiment && !SENTIMENT_VALUES.has(sentiment)) return jsonResponse({ error: "invalid sentiment" }, 400);

  try {
    // See handleAdminSetAreas' own comment for why this runs first.
    await syncBuyerToSheet(env, toE164(phone));
    const accessToken = await getSheetsAccessToken(env);
    let row = await findLoginsRowByPhone(accessToken, phone);
    if (!row) {
      await appendLoginsRow(accessToken, toE164(phone), fullName, "");
      row = await findLoginsRowByPhone(accessToken, phone);
      if (!row) throw new Error("could not find or create a row for this buyer");
    }
    await writeSentiment(accessToken, row, sentiment);
    return jsonResponse({ ok: true, sentiment });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Sets (or clears, with stage: "") a buyer's pipeline stage. Same
// no-confirmation-needed reasoning as sentiment above -- Aaron's own
// tracking note, not a third-party-visible write.
async function handleAdminSetStage(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const phone = (body.phone || "").trim();
  const fullName = (body.fullName || "").trim();
  const stage = (body.stage || "").trim();
  if (!phone) return jsonResponse({ error: "missing phone" }, 400);
  if (stage && !STAGE_VALUES.includes(stage)) return jsonResponse({ error: "invalid stage" }, 400);

  try {
    // See handleAdminSetAreas' own comment for why this runs first.
    await syncBuyerToSheet(env, toE164(phone));
    const accessToken = await getSheetsAccessToken(env);
    let row = await findLoginsRowByPhone(accessToken, phone);
    if (!row) {
      await appendLoginsRow(accessToken, toE164(phone), fullName, "");
      row = await findLoginsRowByPhone(accessToken, phone);
      if (!row) throw new Error("could not find or create a row for this buyer");
    }
    await writeStage(accessToken, row, stage);
    return jsonResponse({ ok: true, stage });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// One-time bulk backfill, added 2026-09-16 per Aaron's direct request
// ("make the first contact stage selected on every contact that
// currently has no stage selected") -- sets Stage to STAGE_VALUES[0]
// ("First Contact") for every real buyer row (has a phone) whose Stage
// cell is currently blank. Deliberately a single manually-triggered
// pass over CURRENT data, not a standing rule -- it does not touch a
// buyer who already has some stage set, and does nothing at all for a
// buyer added after this runs (they'll just show "No stage set" like
// any other new contact always has). Uses batchGet/batchUpdate (2 Sheets
// API calls total, regardless of row count) rather than one HTTP
// request per row -- ~150 individual PUTs in one Worker invocation risks
// the free plan's subrequest cap for no benefit.
// Extracted into its own function 2026-09-14 so the same logic can be
// triggered two ways: the OAuth-gated admin route below (its own UI button
// was removed 2026-09-15, see that commit), and a secret-gated /internal
// wrapper for the same kind of one-off manual trigger every other tonight
// backfill uses.
async function backfillBlankStages(env) {
  try {
    const accessToken = await getSheetsAccessToken(env);
    const phoneRange = encodeURIComponent(`${LOGINS_TAB}!D:D`);
    const stageRange = encodeURIComponent(`${LOGINS_TAB}!AF:AF`);
    const batchGetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?ranges=${phoneRange}&ranges=${stageRange}`;
    const getRes = await fetch(batchGetUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!getRes.ok) throw new Error(`backfill-stage read failed: ${await getRes.text()}`);
    const getData = await getRes.json();
    const phoneCol = (getData.valueRanges[0] && getData.valueRanges[0].values) || [];
    const stageCol = (getData.valueRanges[1] && getData.valueRanges[1].values) || [];
    const firstStage = STAGE_VALUES[0];
    const updates = [];
    const affectedPhones = [];
    const maxLen = Math.max(phoneCol.length, stageCol.length);
    for (let i = 1; i < maxLen; i++) { // i=0 is the header row
      const phone = ((phoneCol[i] && phoneCol[i][0]) || "").trim();
      const stage = ((stageCol[i] && stageCol[i][0]) || "").trim();
      if (!phone || stage) continue; // not a real row, or already has a stage
      const row = i + 1; // 1-indexed sheet row
      updates.push({ range: `${LOGINS_TAB}!AF${row}:AF${row}`, values: [[firstStage]] });
      affectedPhones.push(phone);
    }
    if (updates.length > 0) {
      const batchUpdateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`;
      const putRes = await fetch(batchUpdateUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ valueInputOption: "RAW", data: updates }),
      });
      if (!putRes.ok) throw new Error(`backfill-stage write failed: ${await putRes.text()}`);
    }
    return { updated: updates.length, stage: firstStage };
  } catch (e) {
    // Rethrown, not swallowed -- both callers below wrap this in their own
    // try/catch and turn it into the appropriate error response for their
    // own auth style (OAuth vs. shared-secret).
    throw e;
  }
}

async function handleAdminBackfillStage(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);
  try {
    const result = await backfillBlankStages(env);
    return jsonResponse({ ok: true, ...result });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Secret-gated wrapper, added 2026-09-14 per Aaron's direct request ("set
// all blank stages to first contact") -- the admin-UI button for this was
// removed the same night as a dead-toolbar cleanup; this lets the same
// logic still be triggered directly, same tier as every other one-off
// /internal backfill tool tonight.
async function handleInternalBackfillStage(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  try {
    const result = await backfillBlankStages(env);
    return jsonResponse({ ok: true, ...result });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Sets (or clears) whether a buyer is hidden from the default buyers-list
// view -- added 2026-09-15 per Aaron's direct request ("swipe left on a
// card and hide it from the list"). Same no-confirmation-needed
// reasoning as sentiment/stage above -- Aaron's own personal
// organization, not a third-party-visible write.
async function handleAdminSetHidden(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const phone = (body.phone || "").trim();
  const fullName = (body.fullName || "").trim();
  const hidden = !!body.hidden;
  if (!phone) return jsonResponse({ error: "missing phone" }, 400);

  try {
    // See handleAdminSetAreas' own comment for why this runs first.
    await syncBuyerToSheet(env, toE164(phone));
    const accessToken = await getSheetsAccessToken(env);
    let row = await findLoginsRowByPhone(accessToken, phone);
    if (!row) {
      await appendLoginsRow(accessToken, toE164(phone), fullName, "");
      row = await findLoginsRowByPhone(accessToken, phone);
      if (!row) throw new Error("could not find or create a row for this buyer");
    }
    await writeHidden(accessToken, row, hidden);
    return jsonResponse({ ok: true, hidden });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Sets (or clears) a buyer's DNC (Do Not Contact/Call) flag, added
// 2026-09-16 per Aaron's direct request. Same shape/reasoning as
// handleAdminSetHidden above. Blocking the automated texts themselves
// happens in appointment-notifier-worker.js, which reads this same Sheet
// column directly -- this endpoint's only job is the write + immediate
// cache patch.
async function handleAdminSetDnc(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const phone = (body.phone || "").trim();
  const fullName = (body.fullName || "").trim();
  const dnc = !!body.dnc;
  if (!phone) return jsonResponse({ error: "missing phone" }, 400);

  try {
    // See handleAdminSetAreas' own comment for why this runs first.
    await syncBuyerToSheet(env, toE164(phone));
    const accessToken = await getSheetsAccessToken(env);
    let row = await findLoginsRowByPhone(accessToken, phone);
    if (!row) {
      await appendLoginsRow(accessToken, toE164(phone), fullName, "");
      row = await findLoginsRowByPhone(accessToken, phone);
      if (!row) throw new Error("could not find or create a row for this buyer");
    }
    await writeDnc(accessToken, row, dnc);
    return jsonResponse({ ok: true, dnc });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Admin-side "associate a co-buyer," added 2026-09-15 per Aaron's direct
// request ("I can click to associate and link co-buyers, which will then
// be displayed in their UI"). Writes the SAME Z/AA "Co-Buyer 1"/"Co-Buyer
// 2" columns handleUpdateCoBuyer (the buyer's own My Info tab) already
// reads and writes -- same buildCoBuyerCell format -- so a co-buyer Aaron
// links here shows up pre-filled the next time this buyer opens their own
// My Info tab, exactly like one they'd entered themselves. Unlike
// handleUpdateCoBuyer (which takes a co-buyer's name/email/phone typed by
// hand, since a visitor's co-buyer might not be an existing site user at
// all), this looks the co-buyer's info up from the LIVE buyers_cache by
// phone -- Aaron is linking an EXISTING tracked buyer, not typing a new
// person's details blind. coBuyerPhone: "" clears the slot.
async function writeCoBuyerCell(accessToken, row, slot, cellValue) {
  const col = slot === 1 ? "Z" : "AA";
  const range = encodeURIComponent(`${LOGINS_TAB}!${col}${row}:${col}${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${LOGINS_TAB}!${col}${row}:${col}${row}`, values: [[cellValue]] }),
  });
  if (!res.ok) throw new Error(`co-buyer write failed: ${await res.text()}`);
}
async function handleAdminSetCoBuyer(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const phone = (body.phone || "").trim();
  const fullName = (body.fullName || "").trim();
  const slot = Number(body.slot);
  const coBuyerPhone = (body.coBuyerPhone || "").trim();
  if (!phone) return jsonResponse({ error: "missing phone" }, 400);
  if (slot !== 1 && slot !== 2) return jsonResponse({ error: "invalid slot" }, 400);

  try {
    // See handleAdminSetAreas' own comment for why this runs first.
    await syncBuyerToSheet(env, toE164(phone));
    const accessToken = await getSheetsAccessToken(env);
    // Find-or-create, same convention as writeSentiment/writeStage/
    // writeHidden's own handlers -- a BUYERS-tab-only lead has no App:
    // Logins row at all until something writes one.
    let row = await findLoginsRowByPhone(accessToken, phone);
    if (!row) {
      await appendLoginsRow(accessToken, toE164(phone), fullName, "");
      row = await findLoginsRowByPhone(accessToken, phone);
      if (!row) throw new Error("could not find or create a row for this buyer");
    }

    if (!coBuyerPhone) {
      await writeCoBuyerCell(accessToken, row, slot, "");
      return jsonResponse({ ok: true, cleared: true });
    }

    // Sheet-direct lookup, added 2026-09-14 -- this used to read the
    // co-buyer's identity out of buyers_cache; now that the buyers list
    // itself reads live from the Sheet (not that KV cache) this needs to
    // match, or it'd be looking at an increasingly stale, unwritten copy.
    const normalizedCoPhone = toE164(coBuyerPhone);
    const coRow = await findLoginsRowByPhone(accessToken, normalizedCoPhone);
    if (!coRow) return jsonResponse({ error: "co-buyer not found in the current buyer list" }, 404);
    const coGetUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet`);
    coGetUrl.searchParams.append("ranges", `'${LOGINS_TAB}'!B${coRow}:B${coRow}`);
    coGetUrl.searchParams.append("ranges", `'${LOGINS_TAB}'!E${coRow}:E${coRow}`);
    coGetUrl.searchParams.append("ranges", `'${LOGINS_TAB}'!F${coRow}:F${coRow}`);
    coGetUrl.searchParams.append("ranges", `'${LOGINS_TAB}'!AJ${coRow}:AJ${coRow}`);
    const coGetRes = await fetch(coGetUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!coGetRes.ok) throw new Error(`co-buyer identity read failed: ${await coGetRes.text()}`);
    const coGetData = await coGetRes.json();
    const val = (i) => (((coGetData.valueRanges || [])[i] || {}).values || [[]])[0]?.[0] || "";
    const coEmail = val(0);
    const coIdLink = val(2);
    const coName = val(1) || val(3); // login Name (E), falling back to Quo Name (AJ)
    const cellValue = buildCoBuyerCell(coName, coEmail, normalizedCoPhone, coIdLink);
    await writeCoBuyerCell(accessToken, row, slot, cellValue);
    return jsonResponse({ ok: true, coBuyer: { name: coName, email: coEmail, phone: normalizedCoPhone, idLink: coIdLink } });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Renames a buyer's Quo contact -- a separate, OPT-IN action (see the
// checkbox in the buyers-tab UI, default checked) from setting areas
// above. The buyers-tab UI composes personal-name + area-tag-suffix into
// the one `fullName` string this takes, for the cases where Aaron DOES
// want the Quo contact's own display name kept in sync with the area
// he just set; this endpoint only knows how to set a Quo contact's
// display name, nothing area-specific.
async function handleAdminUpdateContactName(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const phone = (body.phone || "").trim();
  const fullName = (body.fullName || "").trim();
  if (!phone || !fullName) return jsonResponse({ error: "missing phone or fullName" }, 400);

  try {
    const e164Phone = toE164(phone);
    const existing = await quoFindContactByPhone(env, e164Phone);
    if (!existing) return jsonResponse({ error: "no Quo contact found for this phone" }, 404);

    const parts = fullName.split(/\s+/).filter(Boolean);
    const firstName = parts[0] || null;
    const lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
    const data = await quoWrite(env, `/contacts/${existing.id}`, "PATCH", {
      defaultFields: { ...existing.defaultFields, firstName, lastName },
    });
    return jsonResponse({ ok: true, contact: data.data || data });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// ---------- Internal ID-photo OCR tooling, added 2026-09-11, extended 2026-09-12 ----------
// Supports a standing local watch-script (id-photo-watch.ts in nanoclaw,
// run on Aaron's own Mac -- local macOS Vision OCR can't run inside a
// Cloudflare Worker) that reads the actual name printed on each ID photo
// dropped into the Buyer IDs Dropbox folder and cross-references it
// against Quo contacts, per Aaron's direct request: "Can we name the id
// files in db based on the name on the id itself, and then fuzzy match to
// quo contacts?" -- then, per his follow-up request 2026-09-12 ("can we
// have this done automatically"), actually link a confident match without
// waiting for a click. Gated by a shared secret (INTERNAL_TOOLS_SECRET),
// not Google OAuth -- this tier is for the internal script, not the admin
// UI, same ?key= pattern already used by appointment-notifier-worker.js's
// own manual-trigger endpoint. Read-only except for
// handleInternalAutoLinkId below, which the local script calls ONLY once
// its own OCR + name-matching has already decided a match is confident
// (see id-photo-watch.ts's own matching threshold) -- an ambiguous file is
// never sent here, it gets a Telegram flag instead. The original
// OAuth-gated /confirm-id-match / /rename-id-files endpoints still exist
// unchanged, for anything Aaron wants to review by hand from the admin UI.
function checkInternalToolsSecret(request, env) {
  const url = new URL(request.url);
  return url.searchParams.get("key") === env.INTERNAL_TOOLS_SECRET && !!env.INTERNAL_TOOLS_SECRET;
}

// Full manual resync for ONE buyer -- added 2026-09-13 during the same
// incident as ensureBuyerInCache/patchLoginsMatchField, for a case those
// two didn't fully cover: Aaron's real request was general ("I need to be
// able to update buyers if they have a phone number, but no name") --
// this rebuilds one buyer's ENTIRE cache entry (name via a fresh Quo
// lookup, plus every Sheet-sourced field: ID Link, Manual Area Override,
// Stage, Hidden, DNC, Sentiment, ID Name) directly from the two real
// sources of truth (Quo + the Sheet), rather than relying on whichever
// individual patch call happened to run. Secret-gated like every other
// /internal endpoint -- lets a stuck buyer be fixed by hand immediately,
// without waiting on the next full crawl or guessing which single field
// patch didn't take.
// One-time backfill helper, added 2026-09-13 -- writes areas onto Quo's
// role field for a buyer already classified in buyers_cache (from a past
// crawl's TB-name-tag/address/search-derived areas), which never had a
// chance to write role since that mechanism is brand new. First attempt
// looked the contact up directly BY ID (one GET, since buyers_cache
// already has quoContactId) instead of writeContactAreas' own phone-
// search, to avoid needlessly hammering Quo's rate limit across hundreds
// of buyers -- found a real bug live: the single-contact GET endpoint's
// phoneNumbers[].id doesn't round-trip cleanly through a PATCH ("Item
// with ID ... does not match"), while the exact same contact fetched via
// the LIST endpoint (what writeContactAreas/quoFindContactByPhone already
// use) patches back fine. Simplest safe fix: just delegate to the
// already-proven writeContactAreas rather than a separate, more fragile
// path -- slower (a phone search instead of a direct ID GET) but reliable.
// Manual trigger for syncBuyerToSheet (defined near ensureBuyerInCache
// below), added 2026-09-13 -- lets one buyer's Quo Name/Link/Last-Activity
// be backfilled onto the Sheet by hand, and doubles as the per-buyer call
// a bulk backfill script loops over for the existing buyer population.
// Optional `areas` (array of canonical labels) backfills Manual Area
// Override too, only if it's still blank -- see syncBuyerToSheet's own
// comment on the 429-buyer Quo-tag-only area migration this exists for.
async function handleInternalSyncBuyerToSheet(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const phone = (body.phone || "").trim();
  const areas = Array.isArray(body.areas) ? body.areas : null;
  if (!phone) return jsonResponse({ error: "missing phone" }, 400);
  try {
    // touchActivity: false -- this is a manual/backfill trigger, not real
    // activity. See syncBuyerToSheet's own comment on the real bug this
    // fixes (a bulk backfill run was stamping Last Activity to "now" for
    // hundreds of buyers with no real activity at all).
    await syncBuyerToSheet(env, toE164(phone), areas && areas.length ? areas.join(", ") : undefined, false);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleInternalBackfillRole(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const phone = (body.phone || "").trim();
  const areas = Array.isArray(body.areas) ? body.areas : [];
  if (!phone) return jsonResponse({ error: "missing phone" }, 400);
  try {
    await writeContactAreas(env, phone, areas);
    return jsonResponse({ ok: true, phone, role: areas.length ? areas.join(", ") : "TB" });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Rewritten 2026-09-14 to drop the buyers_cache dependency entirely --
// this used to repair a stuck cache entry, which can't happen anymore
// since nothing reads that cache. Kept (not deleted) as a genuinely useful
// diagnostic: syncs Quo Name/Link onto the Sheet for one phone, then
// returns the row's full current state in one call -- used repeatedly
// tonight to verify a buyer end-to-end after a fix.
async function handleInternalResyncBuyer(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const phone = (body.phone || "").trim();
  if (!phone) return jsonResponse({ error: "missing phone" }, 400);
  const e164Phone = toE164(phone);

  try {
    await syncBuyerToSheet(env, e164Phone);
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByPhone(accessToken, e164Phone);
    if (!row) return jsonResponse({ error: "no Sheet row for this phone even after syncBuyerToSheet -- real bug, not a timing issue" }, 500);

    const range = encodeURIComponent(`'${LOGINS_TAB}'!A1:AK1`);
    const headerRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const headerData = await headerRes.json();
    const headers = (headerData.values && headerData.values[0]) || [];
    const idx = (name) => headers.indexOf(name);
    const rowRange = encodeURIComponent(`'${LOGINS_TAB}'!A${row}:AK${row}`);
    const rowRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${rowRange}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const rowJson = await rowRes.json();
    const values = (rowJson.values && rowJson.values[0]) || [];
    const get = (name) => { const i = idx(name); return i >= 0 ? (values[i] || "") : ""; };
    const buyer = {
      row, phone: e164Phone,
      name: get("Name"),
      email: get("Email"),
      idLink: get("ID Link"),
      quoLink: get("Quo Link"),
      quoName: get("Quo Name"),
      lastActivity: get("Last Activity (Quo)"),
      manualAreaOverride: get("Manual Area Override"),
      sentiment: get("Sentiment"),
      stage: get("Stage"),
      idName: get("ID Name (OCR)"),
      hidden: get("Hidden") === "TRUE",
      dnc: get("DNC") === "TRUE",
    };
    return jsonResponse({ ok: true, buyer });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleInternalListIdFiles(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  try {
    const dropboxToken = await getDropboxAccessToken(env);
    const files = await listDropboxFolder(dropboxToken, DROPBOX_IDS_FOLDER);
    return jsonResponse({ files: files.map((f) => ({ path: f.path_display, name: f.name, size: f.size })) });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Streams raw bytes for one file BY PATH (files/download, not
// sharing/get_shared_link_file -- most of these files have no shared
// link yet, that's the whole point of this tool).
async function handleInternalIdFileBytes(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path) return jsonResponse({ error: "missing path" }, 400);
  try {
    const dropboxToken = await getDropboxAccessToken(env);
    const fileRes = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: { Authorization: `Bearer ${dropboxToken}`, "Dropbox-API-Arg": JSON.stringify({ path }) },
    });
    if (!fileRes.ok) throw new Error(`dropbox download failed: ${await fileRes.text()}`);
    const bytes = await fileRes.arrayBuffer();
    return new Response(bytes, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Full Quo contact list (name + phone), for the local script's own
// fuzzy-match against an OCR-extracted name -- not scoped to "no ID yet"
// like computeSuggestedIdMatches, since OCR-based matching is meant to
// catch cases filename-matching misses too.
// Temporary debug endpoint, added 2026-09-13 -- one-off read of a raw Quo
// contact object (unfiltered, straight from Quo's own API, past just
// defaultFields) to answer a real open question: does Quo's contact
// schema support custom fields/tags at all, distinct from defaultFields?
// Read-only, no KV writes -- safe to use even while the daily KV write
// cap is exhausted. Remove once the tags question is settled either way.
// Temporary diagnostic, added 2026-09-14 -- lists the account's real,
// currently-configured Quo webhook subscriptions (event types, target
// URL, status), to answer "does Last Quo Activity include outgoing
// messages and calls" with real data instead of guessing from docs.
async function handleInternalListWebhooks(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  try {
    const res = await fetch(`${QUO_BASE}/webhooks`, {
      headers: { Authorization: env.QUO_API_KEY, "Quo-Api-Version": "2026-03-30" },
    });
    const data = await res.json();
    if (!res.ok) return jsonResponse({ error: "quo error", status: res.status, detail: data }, 500);
    return jsonResponse(data);
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Temporary tool, added 2026-09-14 alongside handleInternalListWebhooks --
// PATCH /webhooks/{id}, used once to add message.delivered (outgoing
// messages) to the existing instant-approval-phone-confirm subscription so
// Last Quo Activity can include outbound texts, not just inbound.
async function handleInternalUpdateWebhook(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const webhookId = (body.webhookId || "").trim();
  if (!webhookId) return jsonResponse({ error: "missing webhookId" }, 400);
  try {
    // Real quirk found live: PATCH /v1/webhooks/{id} 404s ("Cannot PATCH
    // /v1/webhooks/...") even though GET /v1/webhooks (the list) works
    // fine -- the newer dated-versioned webhooks API apparently doesn't
    // live under /v1 for this route. Base URL built without QUO_BASE's
    // own /v1 suffix here specifically.
    const res = await fetch(`https://api.quo.com/webhooks/${webhookId}`, {
      method: "PATCH",
      headers: { Authorization: env.QUO_API_KEY, "Quo-Api-Version": "2026-03-30", "Content-Type": "application/json" },
      body: JSON.stringify(body.update || {}),
    });
    const rawText = await res.text();
    let data;
    try { data = JSON.parse(rawText); } catch { data = null; }
    if (!res.ok || !data) return jsonResponse({ error: "quo error", status: res.status, rawText: rawText.slice(0, 500) }, 500);
    return jsonResponse(data);
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleInternalRawContact(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  const url = new URL(request.url);
  const phone = (url.searchParams.get("phone") || "").trim();
  if (!phone) return jsonResponse({ error: "missing phone query param" }, 400);
  try {
    const contact = await quoFindContactByPhone(env, toE164(phone));
    return jsonResponse({ contact });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Temporary diagnostic endpoint, added 2026-09-13 -- sweeps LIVE Quo
// contacts (not buyers_cache, not the Sheet) for a name substring. Ground
// truth on the Quo side specifically, since both of the other two are
// exactly what's suspected of being stuck for a given buyer.
//
// Capped at 40 pages (2000 contacts) per CALL, not per sweep -- real limit
// hit live: Cloudflare Workers' free-plan hard cap of 50 subrequests per
// invocation, no daily-quota workaround like KV has. At ~2800+ real
// contacts / 50 per page that's ~56 requests, over the cap in one shot.
// Accepts `pageToken` so the caller can resume a truncated sweep across
// multiple calls -- `truncated: true` + `nextPageToken` in the response
// means keep going, not "no match."
// Glide-era email-only row -> Quo-name fuzzy match, added 2026-09-13 per
// Aaron's direct request: "go through the quo contact names and look for
// obvious parallels with the glide email addresses to merge the two
// contacts if no login has occurred yet in the new site." Reuses the exact
// email-localPart/first+last-name substring heuristic already proven live
// in admin-buyers-worker.js's matchEmailToContact -- not a new, untested
// guess -- but tightened here to require EXACTLY ONE candidate (0 or 2+ is
// ambiguous, flagged not guessed), same conservative bar as id-photo-
// watch.ts's OCR matching.
//
// "Merge" does NOT mean writing the matched phone onto the Glide row --
// there are two real, separate Sheet rows for the same person (the old
// Glide row: email+name, no phone; the phone-keyed row: phone+Quo Name,
// often no email, either pre-existing or created by tonight's
// syncBuyerToSheet backfill) -- doing that would create a genuine
// DUPLICATE-phone row, not a merge. The phone-keyed row is the one the
// whole system actually indexes on (loadLoginsByPhone is phone-keyed), so
// this enriches THAT row's Email/Name/First Login/Last Login wherever
// they're still blank, and leaves
// the old Glide row completely untouched -- an inert historical record,
// never deleted, same as everywhere else in this codebase only ever adds.
// "No login has occurred yet" is exactly the Glide row's own blank-Phone
// condition -- a real login/backfill would already have filled it (see
// writeLoginsRow's existingPhone-wins logic).
//
// Dry-run by default (GET, no writes) -- returns matches/ambiguous/noMatch
// for review. Pass apply=true to actually write the accepted matches.
// Diagnostic, added 2026-09-13 to actually answer "why are no contact
// names being added to the sheet with the quo phone numbers?" rather than
// guess -- counts phone-having rows by whether they have a Quo Link, and of
// those, whether Quo Name actually got filled in.
// Diagnostic, added 2026-09-14 -- finds rows whose Phone (D) normalizes
// (via toE164) to the same value as another row, even when the RAW text
// differs (formatting, stray characters) -- a plain substring search
// (find-logins-row) can miss these, same class of gap as the "3143229 139"
// stray-space phone found earlier. Real trigger: "Jasmine ESTLTB" showing
// as two separate buyer cards with the same phone link but different
// stage/last-activity.
// Diagnostic, added 2026-09-14 alongside handleInternalFindDuplicatePhones
// -- raw text search across the separate "BUYERS" lead tab (the other
// source handleBuyers merges in, admin-buyers-worker.js's own
// loadBuyersTabLeads) for a substring, same shape as find-logins-row but
// for that tab instead of App: Logins.
async function handleInternalSearchBuyersTab(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  if (!query) return jsonResponse({ error: "missing q" }, 400);
  try {
    const accessToken = await getSheetsAccessToken(env);
    const range = encodeURIComponent(`BUYERS!A1:O118`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`buyers-tab read failed: ${await res.text()}`);
    const rows = (await res.json()).values || [];
    const headerRowIdx = rows.findIndex((r) => r.includes("Phone Number"));
    const matches = [];
    for (let i = 0; i < rows.length; i++) {
      if (i === headerRowIdx) continue;
      const r = rows[i];
      if (r.some((cell) => (cell || "").toString().toLowerCase().includes(query))) {
        matches.push({ row: i + 1, values: r });
      }
    }
    return jsonResponse({ headerRow: headerRowIdx + 1, matches });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleInternalFindDuplicatePhones(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  try {
    const accessToken = await getSheetsAccessToken(env);
    const range = encodeURIComponent(`${LOGINS_TAB}!A:AK`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`logins read failed: ${await res.text()}`);
    const rows = (await res.json()).values || [];
    const byNormalized = new Map();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const rawPhone = (r[3] || "").trim();
      if (!rawPhone) continue;
      const normalized = toE164(rawPhone);
      if (!normalized) continue;
      const entry = { row: i + 1, rawPhone, name: (r[4] || "").trim(), quoName: (r[35] || "").trim() };
      if (!byNormalized.has(normalized)) byNormalized.set(normalized, []);
      byNormalized.get(normalized).push(entry);
    }
    const duplicates = [...byNormalized.entries()].filter(([, rows]) => rows.length > 1).map(([phone, rows]) => ({ phone, rows }));
    return jsonResponse({ duplicateCount: duplicates.length, duplicates });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleInternalQuoNameStats(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  try {
    const accessToken = await getSheetsAccessToken(env);
    const range = encodeURIComponent(`${LOGINS_TAB}!A:AK`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`logins read failed: ${await res.text()}`);
    const rows = (await res.json()).values || [];
    let hasPhone = 0, hasPhoneAndQuoLink = 0, hasPhoneAndQuoName = 0, hasPhoneNoQuoLink = 0;
    const sampleNoName = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const phone = (r[3] || "").trim();
      const quoLink = (r[13] || "").trim();
      const quoName = (r[35] || "").trim();
      if (!phone) continue;
      hasPhone++;
      if (quoLink) {
        hasPhoneAndQuoLink++;
        if (quoName) hasPhoneAndQuoName++;
        else if (sampleNoName.length < 10) sampleNoName.push({ row: i + 1, phone, quoLink });
      } else {
        hasPhoneNoQuoLink++;
      }
    }
    return jsonResponse({ hasPhone, hasPhoneAndQuoLink, hasPhoneAndQuoName, hasPhoneNoQuoLink, sampleNoName });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Server-side port of app.js's own stripAreaTagsFromName, added 2026-09-14
// for the Name backfill below -- KEEP THIS IN SYNC with that copy if the
// canonical area-tag list ever changes (same warning that copy's own
// comment already carries). Quo Name often carries a trailing area tag
// ("Alexis Langston WMTB") or a parenthetical aside ("LaMonica Henderson
// (2504A Denver Buyer)") -- the LOGIN name column shown throughout the
// site (My Info, Buyer page) should read as a clean, plain name, not carry
// either of those through.
const SERVER_AREA_TAG_TOKENS = new Set(["estltb", "stltb", "lrtb", "wmtb", "springfieldtb", "tb"]);
function stripAreaTagsFromName(name) {
  const noParens = (name || "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  const parts = noParens.split(/\s+/).filter(Boolean);
  while (parts.length > 1 && SERVER_AREA_TAG_TOKENS.has(parts[parts.length - 1].toLowerCase())) {
    parts.pop();
  }
  return parts.join(" ");
}

// Bulk Name (E) backfill from Quo Name (AJ), added 2026-09-14 per Aaron's
// direct request: "fill the names in column E based on the phone numbers
// in column D." Every row's own Quo Name was already resolved BY that
// exact phone (see syncBuyerToSheet) -- this just uses it to fill the
// LOGIN name wherever it's still blank, same-row, no new cross-referencing
// needed. Non-destructive: only ever fills E when it's genuinely blank,
// never overwrites a real name already there. Pure Sheet-to-Sheet -- one
// read, one batchUpdate, no Quo API calls at all, so no rate-limit
// throttling needed (unlike tonight's earlier per-buyer Quo backfills).
// Dry-run by default; apply=true to actually write.
// One-time repair, added 2026-09-14, for the real damage
// touchActivity: false (syncBuyerToSheet's own comment) fixes going
// forward: the bulk Quo Name/Link backfill ran across all 741 buyers
// TWICE that evening, stamping Last Activity (AK) to "now" on every one
// regardless of whether they'd had any real activity at all -- Aaron
// caught it live ("Column AK says 14 September for like almost all of the
// contacts"). Restores AK from a caller-supplied {phone, lastActivityAt}
// list -- the real, pre-backfill values, recovered from a buyers_cache
// snapshot taken before any of tonight's backfill runs. Bulk, one Sheet
// read (phone column) + one batchUpdate, matched by phone.
async function handleInternalRestoreActivity(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) return jsonResponse({ error: "missing entries" }, 400);
  try {
    const accessToken = await getSheetsAccessToken(env);
    const range = encodeURIComponent(`${LOGINS_TAB}!D:D`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`phone column read failed: ${await res.text()}`);
    const phoneCol = (await res.json()).values || [];
    const rowByPhone = new Map();
    for (let i = 1; i < phoneCol.length; i++) {
      const p = toE164((phoneCol[i][0] || "").trim());
      if (p) rowByPhone.set(p, i + 1);
    }

    const data = [];
    let restored = 0;
    const notFound = [];
    for (const entry of entries) {
      const p = toE164(entry.phone || "");
      const row = rowByPhone.get(p);
      if (!row) { notFound.push(entry.phone); continue; }
      // Empty string clears the cell -- used for the handful with no
      // recoverable real value, rather than leaving today's fabricated one.
      data.push({ range: `${LOGINS_TAB}!AK${row}:AK${row}`, values: [[entry.lastActivityAt || ""]] });
      restored++;
    }
    if (data.length > 0) {
      const putRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ valueInputOption: "RAW", data }),
      });
      if (!putRes.ok) throw new Error(`activity restore write failed: ${await putRes.text()}`);
    }
    return jsonResponse({ restored, notFound: notFound.length, notFoundPhones: notFound });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleInternalBackfillNamesFromQuo(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  const url = new URL(request.url);
  const apply = url.searchParams.get("apply") === "true";
  try {
    const accessToken = await getSheetsAccessToken(env);
    const range = encodeURIComponent(`${LOGINS_TAB}!A:AK`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`logins read failed: ${await res.text()}`);
    const rows = (await res.json()).values || [];

    const candidates = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const phone = (r[3] || "").trim();
      const name = (r[4] || "").trim();
      const quoName = (r[35] || "").trim();
      if (!phone || name || !quoName) continue;
      const cleaned = stripAreaTagsFromName(quoName);
      if (!cleaned) continue;
      candidates.push({ row: i + 1, phone, quoName, cleanedName: cleaned });
    }

    if (!apply) {
      return jsonResponse({ dryRun: true, candidateCount: candidates.length, candidates });
    }

    if (candidates.length === 0) return jsonResponse({ applied: 0 });
    const data = candidates.map((c) => ({ range: `${LOGINS_TAB}!E${c.row}:E${c.row}`, values: [[c.cleanedName]] }));
    const putRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "RAW", data }),
    });
    if (!putRes.ok) throw new Error(`name backfill write failed: ${await putRes.text()}`);
    return jsonResponse({ applied: candidates.length, detail: candidates });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleInternalGlideMatch(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  const url = new URL(request.url);
  const apply = url.searchParams.get("apply") === "true";
  try {
    const accessToken = await getSheetsAccessToken(env);
    const range = encodeURIComponent(`${LOGINS_TAB}!A:AK`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`logins read failed: ${await res.text()}`);
    const rows = (await res.json()).values || [];

    const glideOnly = []; // { row, email, name, firstLogin, lastLogin }
    const namedPhoneRows = []; // { row, phone, email, name, quoName, firstLogin, lastLogin }
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const firstLogin = (r[0] || "").trim();
      const email = (r[1] || "").trim();
      const phone = (r[3] || "").trim();
      const name = (r[4] || "").trim();
      const lastLogin = (r[6] || "").trim();
      const quoName = (r[35] || "").trim();
      if (!phone && email && firstLogin) {
        glideOnly.push({ row: i + 1, email, name, firstLogin, lastLogin });
      } else if (phone && quoName) {
        namedPhoneRows.push({ row: i + 1, phone, email, name, quoName, firstLogin, lastLogin });
      }
    }

    const matches = [];
    const ambiguous = [];
    const noMatch = [];
    for (const g of glideOnly) {
      const localPart = g.email.split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
      if (localPart.length < 4) { noMatch.push({ ...g, reason: "email local part too short to judge safely" }); continue; }
      // Exact email match first (the phone-row already has this exact
      // email on file somehow -- trivially confident, no fuzzy needed).
      const exact = namedPhoneRows.filter((n) => n.email && n.email.toLowerCase() === g.email.toLowerCase());
      if (exact.length === 1) { matches.push({ glide: g, candidate: exact[0], via: "exact email" }); continue; }

      const fuzzy = namedPhoneRows.filter((n) => {
        const parts = n.quoName.split(/\s+/).filter(Boolean);
        if (parts.length < 2) return false;
        const first = parts[0].toLowerCase();
        const last = parts[parts.length - 1].toLowerCase();
        return first.length >= 3 && last.length >= 3 && localPart.includes(first) && localPart.includes(last);
      });
      if (fuzzy.length === 1) matches.push({ glide: g, candidate: fuzzy[0], via: "name fuzzy-match" });
      else if (fuzzy.length === 0) noMatch.push({ ...g, reason: "no candidate's Quo Name appears in the email" });
      else ambiguous.push({ glide: g, candidates: fuzzy.map((c) => ({ row: c.row, phone: c.phone, quoName: c.quoName })) });
    }

    if (!apply) {
      return jsonResponse({
        dryRun: true,
        matchCount: matches.length, ambiguousCount: ambiguous.length, noMatchCount: noMatch.length,
        matches: matches.map((m) => ({ glideRow: m.glide.row, glideEmail: m.glide.email, glideName: m.glide.name, glideFirstLogin: m.glide.firstLogin, glideLastLogin: m.glide.lastLogin, matchedRow: m.candidate.row, matchedPhone: m.candidate.phone, matchedQuoName: m.candidate.quoName, matchedExistingEmail: m.candidate.email, matchedExistingName: m.candidate.name, matchedExistingFirstLogin: m.candidate.firstLogin, matchedExistingLastLogin: m.candidate.lastLogin, via: m.via })),
        ambiguous, noMatch,
      });
    }

    // Apply: enrich the phone-keyed row's Email/Name/First Login/Last
    // Login, only where blank -- never overwrite anything already there
    // (per Aaron's direct request, First/Last Login carry over from the
    // Glide row same as Email/Name do). One batchUpdate for everything,
    // regardless of match count.
    const data = [];
    const applied = [];
    for (const m of matches) {
      // m.glide.name guarded too, added 2026-09-13 -- Aaron confirmed the
      // Glide rows themselves carry no Name at all (confirmed in the dry
      // run: every one of the 139 came back with name: ""), so without
      // this a "match" would write an empty string over an already-blank
      // Name cell -- harmless but pointless, and wroteName below would
      // wrongly claim a write happened when nothing real was brought over.
      if (!m.candidate.email && m.glide.email) data.push({ range: `${LOGINS_TAB}!B${m.candidate.row}:B${m.candidate.row}`, values: [[m.glide.email]] });
      if (!m.candidate.name && m.glide.name) data.push({ range: `${LOGINS_TAB}!E${m.candidate.row}:E${m.candidate.row}`, values: [[m.glide.name]] });
      if (!m.candidate.firstLogin && m.glide.firstLogin) data.push({ range: `${LOGINS_TAB}!A${m.candidate.row}:A${m.candidate.row}`, values: [[m.glide.firstLogin]] });
      if (!m.candidate.lastLogin && m.glide.lastLogin) data.push({ range: `${LOGINS_TAB}!G${m.candidate.row}:G${m.candidate.row}`, values: [[m.glide.lastLogin]] });
      applied.push({
        glideRow: m.glide.row, matchedRow: m.candidate.row,
        wroteEmail: !m.candidate.email && !!m.glide.email,
        wroteName: !m.candidate.name && !!m.glide.name,
        wroteFirstLogin: !m.candidate.firstLogin && !!m.glide.firstLogin,
        wroteLastLogin: !m.candidate.lastLogin && !!m.glide.lastLogin,
      });
    }
    if (data.length > 0) {
      const putRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ valueInputOption: "RAW", data }),
      });
      if (!putRes.ok) throw new Error(`glide-match write failed: ${await putRes.text()}`);
    }
    return jsonResponse({ applied: applied.length, detail: applied, ambiguousCount: ambiguous.length, noMatchCount: noMatch.length });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleInternalFindQuoContact(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  const url = new URL(request.url);
  const nameQuery = (url.searchParams.get("name") || "").trim().toLowerCase();
  if (!nameQuery) return jsonResponse({ error: "missing name query param" }, 400);
  try {
    const matches = [];
    let pageToken = url.searchParams.get("pageToken") || undefined;
    let pages = 0;
    const MAX_PAGES_PER_CALL = 40;
    do {
      const resp = await quoCall(env, "/contacts", { maxResults: "50", pageToken });
      for (const c of resp.data || []) {
        const d = c.defaultFields || {};
        const fullName = [d.firstName, d.lastName].filter(Boolean).join(" ");
        if (fullName.toLowerCase().includes(nameQuery)) {
          matches.push({
            id: c.id,
            name: fullName,
            phones: (d.phoneNumbers || []).map((p) => p.value),
            emails: (d.emails || []).map((e) => e.value),
            role: d.role || "",
            quoUrl: `https://my.quo.com/contacts/${c.id}`,
          });
        }
      }
      pageToken = resp.nextPageToken;
      pages++;
    } while (pageToken && pages < MAX_PAGES_PER_CALL);
    return jsonResponse({ matches, pagesScanned: pages, truncated: !!pageToken, nextPageToken: pageToken || null });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Rewritten 2026-09-14 to read live from the Sheet instead of buyers_cache
// -- id-photo-watch.ts calls this for its OCR-matching candidate list
// (buyers still needing an ID), so it's a genuine dependency, not just a
// redundant cache write like most of tonight's cleanup. Scoped to App:
// Logins only now (Name/Quo Name/ID Link columns) -- a BUYERS-tab-only
// lead with no App: Logins row at all is a much smaller population than
// it used to be, since tonight's Sheet backfill created a row for every
// known phone; a real but small gap, not silently pretended away.
async function handleInternalContacts(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  try {
    const accessToken = await getSheetsAccessToken(env);
    const range = encodeURIComponent(`${LOGINS_TAB}!A:AK`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`logins read failed: ${await res.text()}`);
    const rows = (await res.json()).values || [];
    const contacts = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const phone = (r[3] || "").trim();
      const name = (r[4] || "").trim() || (r[35] || "").trim(); // login Name, falling back to Quo Name
      const idLink = (r[5] || "").trim();
      if (!phone || !name) continue;
      contacts.push({ phone, name, hasId: !!idLink });
    }
    return jsonResponse({ contacts });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Temporary diagnostic endpoint, added 2026-09-13 -- ground-truth Sheet
// lookup by name substring, independent of buyers_cache/Quo entirely (both
// of those are exactly what's suspected of being stuck for a given buyer,
// so a tool that only reads THEM can't tell "not in the Sheet at all" apart
// from "in the Sheet but not synced into cache yet"). Read-only, same
// INTERNAL_TOOLS_SECRET tier as the other /internal/* tools above.
// Tiny diagnostic, added 2026-09-13 -- the real header row (names + which
// letter each lives at), needed before adding any new column safely: this
// Sheet is read/written all over this file by hardcoded LETTER (D, E, F,
// AD, AF, ...), so a column inserted in the MIDDLE would silently shift
// every one of those and corrupt unrelated reads/writes. New columns only
// ever get APPENDED after whatever the real last one is.
async function handleInternalSheetHeaders(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  try {
    const accessToken = await getSheetsAccessToken(env);
    const range = encodeURIComponent(`'${LOGINS_TAB}'!A1:BZ1`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`headers read failed: ${await res.text()}`);
    const data = await res.json();
    const headers = (data.values && data.values[0]) || [];
    const colLetter = (i) => { let n = i, s = ""; while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } return s; };
    return jsonResponse({ headers: headers.map((h, i) => ({ col: colLetter(i), name: h })) });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// A1 column letters -> 1-indexed number (A=1, Z=26, AA=27, ...).
function columnLetterToNumber(col) {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// Real limit hit live 2026-09-13 adding the Quo-Name/Last-Activity columns:
// a Sheet's grid has a fixed column COUNT independent of how many columns
// actually have data -- App: Logins' grid was sized to exactly 35 (through
// AI), so writing AJ/AK 400'd with "exceeds grid limits" even though
// values.update can normally write to any UNUSED cell within the grid.
// Growing the grid (spreadsheets.batchUpdate updateSheetProperties) is a
// different call than writing a value to it -- values.update alone can
// never do this. Pads to at least 10 past what's asked for, once, so this
// doesn't recur on the next column added after these two.
async function ensureSheetGridWidth(env, accessToken, minColumns) {
  const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaRes.ok) throw new Error(`sheet metadata read failed: ${await metaRes.text()}`);
  const metaData = await metaRes.json();
  const sheet = (metaData.sheets || []).find((s) => s.properties.title === LOGINS_TAB);
  if (!sheet) throw new Error(`sheet tab not found: ${LOGINS_TAB}`);
  const current = sheet.properties.gridProperties.columnCount;
  if (current >= minColumns) return;
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{
        updateSheetProperties: {
          properties: { sheetId: sheet.properties.sheetId, gridProperties: { columnCount: minColumns + 10 } },
          fields: "gridProperties.columnCount",
        },
      }],
    }),
  });
  if (!res.ok) throw new Error(`grid expand failed: ${await res.text()}`);
}

// Generic one-cell write, added 2026-09-13 for the Quo-Name/Last-Activity
// column setup below -- kept as a permanent tool alongside sheet-headers
// (same tier: read the layout, write one cell by col+row) rather than a
// one-off throwaway, since "add/fix one Sheet cell by hand" is a recurring
// need for this kind of incident work.
async function handleInternalWriteCell(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const col = (body.col || "").trim();
  const row = Number(body.row);
  const value = body.value ?? "";
  if (!/^[A-Z]{1,3}$/.test(col) || !Number.isInteger(row) || row < 1) {
    return jsonResponse({ error: "invalid col or row" }, 400);
  }
  try {
    const accessToken = await getSheetsAccessToken(env);
    await ensureSheetGridWidth(env, accessToken, columnLetterToNumber(col));
    const a1 = `'${LOGINS_TAB}'!${col}${row}:${col}${row}`;
    const range = encodeURIComponent(a1);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: a1, values: [[value]] }),
    });
    if (!res.ok) throw new Error(`cell write failed: ${await res.text()}`);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleInternalFindLoginsRow(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  const url = new URL(request.url);
  const nameQuery = (url.searchParams.get("name") || "").trim().toLowerCase();
  if (!nameQuery) return jsonResponse({ error: "missing name query param" }, 400);
  try {
    const accessToken = await getSheetsAccessToken(env);
    const range = encodeURIComponent(`${LOGINS_TAB}!A:AK`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`logins read failed: ${await res.text()}`);
    const data = await res.json();
    const rows = data.values || [];
    const matches = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[4] || "").trim(); // column E
      // Search every column, not just Name -- a blank Name cell (the exact
      // thing suspected of being stuck) would never match a name-only
      // search, but the row could still be findable by email or phone.
      const rowMatches = r.some((cell) => (cell || "").toString().toLowerCase().includes(nameQuery));
      if (rowMatches) {
        matches.push({
          row: i + 1,
          email: r[1] || "",
          phone: r[3] || "",
          name,
          idLink: r[5] || "",
          quoLink: r[13] || "", // column N
          quoName: r[35] || "", // column AJ
          lastActivity: r[36] || "", // column AK
          stage: r[31] || "", // column AF
          manualAreaOverride: r[29] || "", // column AD
        });
      }
    }
    return jsonResponse({ matches });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// "Auto-link one OCR-matched ID file," added 2026-09-12 per Aaron's direct
// request to make the Dropbox-dropped-ID workflow fully automatic instead
// of requiring a click through /suggested-id-matches + /confirm-id-match +
// /rename-id-files every time. Shared-secret gated (INTERNAL_TOOLS_SECRET),
// same tier as the read-only /internal/* tools above -- but unlike those,
// THIS one writes (renames the Dropbox file, writes ID Link) on Aaron's own
// explicit go-ahead to automate this, not silently. The actual OCR + name-
// matching judgment call happens in the calling script (id-photo-watch.ts,
// via macOS Vision -- can't run in a Worker); this endpoint just performs
// the two writes once that script has already decided a match is
// confident. Deliberately a single-file call, not a batch like
// /rename-id-files -- the caller already knows exactly which file goes
// with which buyer, no server-side matching to redo.
// Shared core of the two "link an existing Dropbox file to a buyer" paths
// -- consolidated 2026-09-13 as part of a real ID-linking simplification
// pass (Aaron: "let's simplify the IDs"). Before this, handleConfirmIdMatch
// (the manual "Browse existing ID photos" panel) and handleInternalAutoLinkId
// (the automated OCR watcher) each carried their own copy of this exact
// rename+link+Sheet-write+cache-patch sequence -- genuinely risky
// duplication: the two had already drifted once (one had the real-time
// cache-patch fix before the other, earlier the same day). autorename is
// the one real behavioral difference between the two callers: the browse
// panel always expects a fresh target path (never collides, so autorename
// doesn't matter in practice, kept true for historical parity with what
// handleConfirmIdMatch always did); the OCR watcher passes false since it
// already knows a distinct name should be safe and wants a hard failure
// surfaced (flagged to Telegram) rather than a silent "(1)" suffix if that
// assumption is ever wrong. idName (the OCR'd name off the ID itself) is
// optional -- only the auto-link caller ever has one.
async function linkIdToBuyer(env, { dropboxPath, buyerPhone, buyerName, idName, autorename }) {
  await syncBuyerToSheet(env, toE164(buyerPhone));
  const [dropboxToken, accessToken] = await Promise.all([getDropboxAccessToken(env), getSheetsAccessToken(env)]);

  const originalFilename = dropboxPath.split("/").pop() || "";
  const targetName = buildIdFilename(buyerName, buyerPhone, originalFilename);
  const targetPath = `${DROPBOX_IDS_FOLDER}/${targetName}`;
  let finalPath = dropboxPath;
  if (targetName !== originalFilename) {
    const moveRes = await fetch("https://api.dropboxapi.com/2/files/move_v2", {
      method: "POST",
      headers: { Authorization: `Bearer ${dropboxToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from_path: dropboxPath, to_path: targetPath, autorename }),
    });
    if (!moveRes.ok) throw Object.assign(new Error("rename failed"), { httpDetail: await moveRes.text() });
    const moveData = await moveRes.json();
    finalPath = moveData.metadata.path_display;
  }

  const idLink = await createOrReuseSharedLink(dropboxToken, finalPath);
  // Most matched buyers have no App: Logins row at all -- find one if it
  // exists, otherwise create a minimal new row rather than requiring one.
  const row = await findLoginsRowByPhone(accessToken, buyerPhone);
  if (row) {
    await writeIdLink(accessToken, row, idLink);
    if (idName) await writeIdName(accessToken, row, idName);
  } else {
    await appendLoginsRow(accessToken, toE164(buyerPhone), buyerName, idLink);
    if (idName) {
      const newRow = await findLoginsRowByPhone(accessToken, buyerPhone);
      if (newRow) await writeIdName(accessToken, newRow, idName);
    }
  }

  return { finalPath, idLink };
}

async function handleInternalAutoLinkId(request, env) {
  if (!checkInternalToolsSecret(request, env)) return jsonResponse({ error: "not authorized" }, 403);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const dropboxPath = (body.dropboxPath || "").trim();
  const buyerPhone = (body.buyerPhone || "").trim();
  const buyerName = (body.buyerName || "").trim();
  // The name actually read off the ID itself (AAMVA field 1/2 parse, best
  // effort -- see id-photo-watch.ts), added 2026-09-12 per Aaron's direct
  // request to be able to tell a buyer's Quo name, IAH login name, and ID
  // name apart on the page. Independent of buyerName above, which is only
  // ever the MATCHED Quo contact's name (used for the file's own naming
  // convention) -- this is a separate fact worth keeping even when they agree.
  const idName = (body.idName || "").trim();
  if (!dropboxPath || !buyerPhone) return jsonResponse({ error: "missing dropboxPath or buyerPhone" }, 400);

  try {
    const { finalPath, idLink } = await linkIdToBuyer(env, { dropboxPath, buyerPhone, buyerName, idName, autorename: false });
    return jsonResponse({ ok: true, renamedTo: finalPath, idLink });
  } catch (e) {
    if (e.httpDetail) return jsonResponse({ error: "rename failed", detail: e.httpDetail }, 500);
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleConfirmIdMatch(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const dropboxPath = (body.dropboxPath || "").trim();
  const buyerPhone = (body.buyerPhone || "").trim();
  const buyerName = (body.buyerName || "").trim();
  if (!dropboxPath || !buyerPhone) return jsonResponse({ error: "missing dropboxPath or buyerPhone" }, 400);

  try {
    const { finalPath, idLink } = await linkIdToBuyer(env, { dropboxPath, buyerPhone, buyerName, idName: "", autorename: true });
    return jsonResponse({ ok: true, idLink, renamedTo: finalPath });
  } catch (e) {
    if (e.httpDetail) return jsonResponse({ error: "rename failed", detail: e.httpDetail }, 500);
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// "Browse existing, unassociated ID photos," added 2026-09-15 per Aaron's
// direct request -- the buyer detail page's ID lightbox now offers this
// alongside "Upload new ID," for files already sitting in the Buyer IDs
// Dropbox folder (e.g. from the OCR-renamed batch, or anything dropped in
// by hand) that no buyer is currently linked to yet. Deliberately does
// NOT create a shared link for every file up front -- checking existence
// only (list_shared_links with a path, never creating) keeps this to one
// cheap read per file, safely under the Workers free-plan's 50-subrequest
// cap even for a full folder; a real preview link is created lazily, one
// request per thumbnail actually rendered client-side (see
// handleAdminIdPhotoPreviewLink below), which is a SEPARATE invocation
// with its own budget.
//
// "Already linked" is checked against the Sheet's own ID Link column (F),
// not buyers_cache -- fixed 2026-09-13. The cache only reflects a buyer
// once something has given them a cache entry (crawl, or ensureBuyerInCache
// on some real-time write); the Sheet's F column is the actual thing
// writeIdLink writes to, so it's the true ground truth here. Checking the
// cache instead would risk showing an already-linked buyer's file as
// "unassociated" whenever their cache entry is missing or stale, and
// clicking it would rename/move that file onto a NEW buyer -- silently
// orphaning the original buyer's real ID Link URL in the Sheet. One extra
// Sheets column-range read (same cheap pattern as findLoginsRowByPhone)
// closes that gap.
async function handleAdminBrowseIdPhotos(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  try {
    const [dropboxToken, accessToken] = await Promise.all([
      getDropboxAccessToken(env),
      getSheetsAccessToken(env),
    ]);
    const linksRange = encodeURIComponent(`${LOGINS_TAB}!F:F`);
    const linksRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${linksRange}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!linksRes.ok) throw new Error(`id-link column read failed: ${await linksRes.text()}`);
    const linksData = await linksRes.json();
    const linkedUrls = new Set(
      (linksData.values || []).map((row) => (row[0] || "").trim()).filter(Boolean)
    );
    const files = await listDropboxFolder(dropboxToken, DROPBOX_IDS_FOLDER);
    const unassociated = [];
    for (const file of files) {
      const listRes = await fetch("https://api.dropboxapi.com/2/sharing/list_shared_links", {
        method: "POST",
        headers: { Authorization: `Bearer ${dropboxToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: file.path_display, direct_only: true }),
      });
      if (!listRes.ok) continue; // best-effort -- skip a file whose link status we couldn't check rather than fail the whole browse
      const listData = await listRes.json();
      const existingUrl = (listData.links || [])[0] && listData.links[0].url;
      if (existingUrl && linkedUrls.has(existingUrl)) continue; // a real buyer already points at this file -- not a candidate
      unassociated.push({ path: file.path_display, name: file.name });
    }
    return jsonResponse({ files: unassociated });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Creates (or reuses) a shared link for exactly ONE file, added 2026-09-15
// alongside handleAdminBrowseIdPhotos above -- called once per thumbnail
// the browse picker actually renders, as its own separate request/
// invocation (own subrequest budget), rather than up front for the whole
// folder.
async function handleAdminIdPhotoPreviewLink(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  const url = new URL(request.url);
  const dropboxPath = (url.searchParams.get("path") || "").trim();
  if (!dropboxPath) return jsonResponse({ error: "missing path" }, 400);

  try {
    const dropboxToken = await getDropboxAccessToken(env);
    const idLink = await createOrReuseSharedLink(dropboxToken, dropboxPath);
    return jsonResponse({ idLink });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// "Houses I've shown them" -- Aaron's own admin-side record, column AB,
// added 2026-09-11 per his direct request. Deliberately a read-then-write
// (not a blind overwrite like Favorites/Viewed above, which the CLIENT
// already owns the full authoritative list for) -- Aaron doesn't have the
// current list loaded client-side when he marks one shown, so this reads
// the cell fresh, adds/removes just the one address, and writes back,
// same "re-read immediately before writing" discipline already used by
// writeIdLink's callers elsewhere in this file to avoid clobbering a
// concurrent edit.
async function handleMarkShown(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const row = Number(body.buyerRow);
  const address = (body.address || "").trim();
  const action = body.action === "remove" ? "remove" : "add";
  if (!row || !address) return jsonResponse({ error: "missing buyerRow or address" }, 400);

  try {
    const accessToken = await getSheetsAccessToken(env);
    const range = encodeURIComponent(`${LOGINS_TAB}!AB${row}:AB${row}`);
    const getRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!getRes.ok) throw new Error(`shown-properties read failed: ${await getRes.text()}`);
    const current = (((await getRes.json()).values || [[]])[0] || [])[0] || "";
    const list = current ? current.split(" | ").map((s) => s.trim()).filter(Boolean) : [];
    const next = action === "remove"
      ? list.filter((a) => a !== address)
      : list.includes(address) ? list : [...list, address];

    const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
    const putRes = await fetch(putUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!AB${row}:AB${row}`, values: [[next.join(" | ")]] }),
    });
    if (!putRes.ok) throw new Error(`shown-properties write failed: ${await putRes.text()}`);
    return jsonResponse({ ok: true, shown: next });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Admin version of handleIdPhoto above, for the Buyers tab -- real bug
// found 2026-09-11: that tab's <img src="${lm.idLink}"> pointed straight
// at the raw Dropbox shared link, which doesn't render as an image at all
// embedded like that (Dropbox serves an HTML preview page at that URL,
// not raw image bytes) -- same reason handleIdPhoto/loadIdPhotoThumbnail
// exists for the visitor-facing My Info tab, just never wired up for this
// admin view. Google-OAuth gated (matching every other admin buyers
// endpoint) rather than reusing handleIdPhoto's email-based gate, which
// is deliberately weak to match the rest of the visitor-facing site --
// an admin view showing potentially any buyer's ID needs the stronger bar.
// Takes the Dropbox link directly (the admin worker already has it, from
// loginsMatch.idLink) rather than re-deriving it from a row, and caches
// by a hash of the link itself.
async function handleAdminIdPhoto(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);
  const verified = await verifyIdToken(idToken);
  if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const sharedLink = (body.dropboxLink || "").trim();
  if (!sharedLink) return jsonResponse({ error: "missing dropboxLink" }, 400);

  const cache = caches.default;
  const cacheKey = new Request(`https://admin-id-photo-cache.internal/${encodeURIComponent(sharedLink)}`, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const dropboxToken = await getDropboxAccessToken(env);
    const fileRes = await fetch("https://content.dropboxapi.com/2/sharing/get_shared_link_file", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dropboxToken}`,
        "Dropbox-API-Arg": JSON.stringify({ url: sharedLink }),
      },
    });
    if (!fileRes.ok) throw new Error(`dropbox file fetch failed: ${await fileRes.text()}`);

    // Same real Dropbox quirk as handleIdPhoto -- always octet-stream,
    // infer the real type from the filename in the result header instead.
    let contentType = "image/jpeg";
    const apiResultHeader = fileRes.headers.get("dropbox-api-result");
    if (apiResultHeader) {
      try {
        const meta = JSON.parse(apiResultHeader);
        const ext = (meta.name || "").split(".").pop().toLowerCase();
        const extMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic" };
        if (extMap[ext]) contentType = extMap[ext];
      } catch (e) {
        // fall through to the default above
      }
    }
    const bytes = await fileRes.arrayBuffer();
    const response = new Response(bytes, {
      status: 200,
      headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=3600", ...corsHeaders() },
    });
    await cache.put(cacheKey, response.clone());
    return response;
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleUploadId(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return jsonResponse({ error: "invalid form data" }, 400);
  }
  const name = (form.get("name") || "").toString().trim();
  const email = (form.get("email") || "").toString().trim();
  const phone = (form.get("phone") || "").toString().trim();
  const property = (form.get("property") || "").toString().trim();
  const inspectionDate = (form.get("inspectionDate") || "").toString().trim();
  const idPhoto = form.get("idPhoto");
  // A submitted <form>'s FormData always includes an entry for an unselected
  // file input (an empty File, name: "", size: 0) rather than omitting the
  // key entirely -- checking size, not just presence/type, is what actually
  // tells "no file chosen" apart from "a real file was chosen."
  const hasIdPhoto = !!idPhoto && typeof idPhoto !== "string" && idPhoto.size > 0;

  if (!name || !email || !phone || !property || !inspectionDate) {
    return jsonResponse({ error: "missing required field" }, 400);
  }

  try {
    // Real gap closed 2026-09-03: a photo used to be required on EVERY
    // booking, even for a returning visitor who already has one on file
    // (from an earlier booking, or uploaded directly via My Info -- see
    // handleUploadMyId below). Row lookup now happens first so that can be
    // checked server-side -- never just trusted from the client -- before
    // deciding whether a fresh photo is actually required.
    const accessToken = await getSheetsAccessToken(env);
    // phone passed through 2026-09-14 -- same fix as handleGateLogin's own
    // call, same reason: a first-ever booking with a new email but a phone
    // that already has a row (Quo conversation, Sheet backfill, etc.) used
    // to create a duplicate row instead of reusing the existing one.
    const target = await findOrNextLoginsRow(accessToken, email, phone);

    if (!hasIdPhoto && !target.existingIdLink) {
      return jsonResponse({ error: "missing ID photo" }, 400);
    }

    let idLink = target.existingIdLink || "";
    let filename = "";
    if (hasIdPhoto) {
      const dropboxToken = await getDropboxAccessToken(env);
      filename = buildIdFilename(name, phone, idPhoto.name);
      const destPath = `${DROPBOX_IDS_FOLDER}/${filename}`;
      const fileBytes = await idPhoto.arrayBuffer();
      await archivePreviousIdPhoto(dropboxToken, destPath);

      const uploadRes = await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${dropboxToken}`,
          // mode: "overwrite", not "add" -- see buildIdFilename's comment.
          // Same name + same last-4-of-phone showing up twice is treated as
          // the same person re-submitting, not a collision to reject.
          "Dropbox-API-Arg": JSON.stringify({ path: destPath, mode: "overwrite", mute: false }),
          "Content-Type": "application/octet-stream",
        },
        body: fileBytes,
      });
      if (!uploadRes.ok) throw new Error(`dropbox upload failed: ${await uploadRes.text()}`);

      // Real shared link, not just the folder link -- see
      // createOrReuseSharedLink's own comment for the regression this
      // fixes. Best-effort: a Dropbox sharing hiccup shouldn't block the
      // appointment save below, which is the actually-required part of
      // this submission.
      try {
        idLink = await createOrReuseSharedLink(dropboxToken, destPath);
      } catch (e) {
        // fall through with whatever idLink already was (existing or "")
        // -- flagged to Aaron via the Telegram note below either way.
      }
    }

    // Record this appointment in App: Logins -- added 2026-08-29, per
    // Aaron's direct request ("Each appointment created should be added to
    // a new column in the sheet"). Reuses the SAME find-or-create-row logic
    // as gate-login (findOrNextLoginsRow/writeLoginsRow) rather than
    // assuming a matching row already exists -- a Get Started submission
    // can use a DIFFERENT email than whatever originally passed the gate on
    // this device, since all three contact fields here are deliberately
    // editable. `agreed: true` is the right default when a fresh row gets
    // created from here, since reaching this form at all required already
    // passing the site-wide consent gate.
    let appointmentSaved = false;
    try {
      await writeLoginsRow(accessToken, target, { name, email, phone, agreed: true });
      if (idLink) await writeIdLink(accessToken, target.row, idLink);
      await addAppointment(accessToken, target.row, property, inspectionDate);
      appointmentSaved = true;
    } catch (e) {
      // Best-effort -- the ID/Dropbox upload (the actually-required part of
      // this submission) already succeeded by this point; a Sheet hiccup
      // here shouldn't turn into a visitor-facing failure for something
      // they already completed. Surfaced to Aaron via the Telegram note
      // below instead, so it's not silently lost.
    }

    // Notify Aaron -- informational, no approval needed (see the big
    // comment above this section for why). Best-effort (wrapped so a
    // Telegram hiccup can't fail the response for something the visitor
    // already completed successfully), but AWAITED -- a real bug found and
    // fixed 2026-09-02: this was fire-and-forget (no await), the exact same
    // Cloudflare Workers gotcha already found and fixed twice elsewhere in
    // this file (an unawaited promise can be killed the instant the
    // response returns). Wording now distinguishes a fresh upload from a
    // booking that reused an already-on-file ID, so Aaron isn't confused
    // about which case happened.
    if (env.TELEGRAM_BOT_TOKEN) {
      const text = hasIdPhoto
        ? `ID uploaded — ${name}, ${phone}, ${email}.\n` +
          `Property: ${property}\n` +
          `Wants to inspect: ${inspectionDate} (9 AM–8 PM, confirm 1 hr ahead)\n` +
          `Filed as: ${filename}\n` +
          `${idLink || DROPBOX_BUYER_IDS_FOLDER_LINK}` +
          (appointmentSaved ? "" : "\n(Note: could not save this appointment to App: Logins -- check manually.)")
        : `Viewing booked (reused ID already on file) — ${name}, ${phone}, ${email}.\n` +
          `Property: ${property}\n` +
          `Wants to inspect: ${inspectionDate} (9 AM–8 PM, confirm 1 hr ahead)` +
          (appointmentSaved ? "" : "\n(Note: could not save this appointment to App: Logins -- check manually.)");
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: AARON_TELEGRAM_CHAT_ID, text }),
      }).catch(() => {});
    }

    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Upload/replace the PRIMARY buyer's own ID directly from My Info, added
// 2026-09-03 -- closes the real remaining gap from Aaron's original "My
// Info" scope ask ("the ID should also be able to be uploaded from the my
// info page and register as already received on the showings page"). Only
// the co-buyer version of this existed before; the primary buyer's ID
// could only ever be attached via a full Showings booking. Mirrors
// handleUploadCoBuyerId's mechanics (same folder, same overwrite
// convention, same real shared-link creation) but simpler still -- no
// slot, no separate name/phone fields to manage, just the row's own
// already-on-file Name/Phone (required at gate-login, so always present
// by the time someone reaches My Info).
async function handleUploadMyId(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return jsonResponse({ error: "invalid form data" }, 400);
  }
  // identityPhone added 2026-09-14, now the PRIMARY identity -- see
  // findLoginsRowByIdentity's own comment. Named distinctly from the
  // on-file phone read from the row below (this handler already required
  // Phone to be saved on the row before an ID could attach, independent of
  // how the row was found).
  const email = (form.get("email") || "").toString().trim();
  const identityPhone = (form.get("phone") || "").toString().trim();
  const idPhoto = form.get("idPhoto");

  if (!isPlausiblePhone(identityPhone) && !isPlausibleEmail(email)) return jsonResponse({ error: "invalid identity" }, 400);
  if (!idPhoto || typeof idPhoto === "string") return jsonResponse({ error: "missing ID photo" }, 400);

  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByIdentity(accessToken, identityPhone, email);
    if (!row) return jsonResponse({ error: "not found" }, 404);

    const infoRange = encodeURIComponent(`${LOGINS_TAB}!D${row}:E${row}`);
    const infoRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${infoRange}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!infoRes.ok) throw new Error(`name/phone read failed: ${await infoRes.text()}`);
    const infoData = await infoRes.json();
    const [phone, name] = ((infoData.values || [[]])[0] || []);
    if (!name || !phone) {
      return jsonResponse({ error: "missing name/phone", message: "Please save your name and phone number first." }, 400);
    }

    const dropboxToken = await getDropboxAccessToken(env);
    const filename = buildIdFilename(name, phone, idPhoto.name);
    const destPath = `${DROPBOX_IDS_FOLDER}/${filename}`;
    const fileBytes = await idPhoto.arrayBuffer();
    await archivePreviousIdPhoto(dropboxToken, destPath);

    const uploadRes = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dropboxToken}`,
        "Dropbox-API-Arg": JSON.stringify({ path: destPath, mode: "overwrite", mute: false }),
        "Content-Type": "application/octet-stream",
      },
      body: fileBytes,
    });
    if (!uploadRes.ok) throw new Error(`dropbox upload failed: ${await uploadRes.text()}`);

    const idLink = await createOrReuseSharedLink(dropboxToken, destPath);
    await writeIdLink(accessToken, row, idLink);

    if (env.TELEGRAM_BOT_TOKEN) {
      const text = `ID uploaded via My Info — ${name}, ${phone}, ${email}.\nFiled as: ${filename}\n${idLink}`;
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: AARON_TELEGRAM_CHAT_ID, text }),
      }).catch(() => {});
    }

    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// ---------- job 5: appointment scheduling (2026-08-29) ----------
// Slots stored as "<address> | <date>" in App: Logins columns O-X
// (Appointment 1-10), one visitor row, up to 10 concurrent scheduled
// viewings. The Get Started page's appointments banner reads this LIVE on
// every visit (never cached in localStorage) specifically so Cancel/Change
// Date can never drift out of sync with what's actually shown -- the Sheet
// is the one source of truth here, same principle the rest of this build
// already follows for anything Aaron/Nathan also needs to see.
const APPOINTMENT_SLOT_COUNT = 10;
const APPOINTMENT_COLS = ["O", "P", "Q", "R", "S", "T", "U", "V", "W", "X"];

async function readAppointmentRawCells(accessToken, row) {
  const range = encodeURIComponent(`${LOGINS_TAB}!O${row}:X${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`appointment slots read failed: ${await res.text()}`);
  const data = await res.json();
  const cells = (data.values && data.values[0]) || [];
  const out = [];
  for (let i = 0; i < APPOINTMENT_SLOT_COUNT; i++) out.push((cells[i] || "").trim());
  return out;
}

// Third pipe segment (status), added 2026-09-15 per Aaron's direct
// request ("click to reschedule or cancel existing appointments...
// marked as no-show unless canceled or completed"): "" (Scheduled -- the
// default; an appointment written before this feature existed, with no
// third segment at all, parses to "" here exactly the same way, no
// migration needed), "Canceled", or "Completed". "No-show" is
// deliberately NEVER a stored value -- a PAST appointment with blank
// status just READS as an automatic no-show, both client-side and in
// appointment-notifier-worker.js's own Job 3 exclusion.
function parseAppointmentCell(raw, slot) {
  if (!raw) return null;
  const parts = raw.split(" | ");
  const address = (parts[0] || "").trim();
  const date = (parts[1] || "").trim();
  const status = (parts[2] || "").trim();
  if (!address || !date) return null;
  return { slot, address, date, status };
}
function buildAppointmentCell(address, date, status) {
  return `${address} | ${date} | ${status || ""}`;
}

// Drops any already-past slots, appends the new one, and FIFO-caps at 10 if
// genuinely more than 10 are still active. "today" here is server-side
// UTC, an approximation -- fine, since this only prunes stale entries to
// free capacity and never blocks a visitor action, unlike the client-side
// local-date check that guards the actual date PICKER.
async function addAppointment(accessToken, row, address, date) {
  const cells = await readAppointmentRawCells(accessToken, row);
  const todayUtc = new Date().toISOString().slice(0, 10);
  // Real bug fixed 2026-09-15, found while adding the status field: this
  // used to rebuild every SURVIVING active cell as bare "<address> |
  // <date>", silently dropping its status -- so scheduling any new
  // showing would reset every OTHER still-active appointment's Canceled/
  // Completed status back to blank. buildAppointmentCell preserves it now.
  let active = cells
    .map((raw, i) => parseAppointmentCell(raw, i + 1))
    .filter((a) => a && a.date >= todayUtc)
    .map((a) => buildAppointmentCell(a.address, a.date, a.status));
  active.push(buildAppointmentCell(address, date, ""));
  if (active.length > APPOINTMENT_SLOT_COUNT) active = active.slice(active.length - APPOINTMENT_SLOT_COUNT);
  while (active.length < APPOINTMENT_SLOT_COUNT) active.push("");

  const range = encodeURIComponent(`${LOGINS_TAB}!O${row}:X${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${LOGINS_TAB}!O${row}:X${row}`, values: [active] }),
  });
  if (!res.ok) throw new Error(`appointment slots write failed: ${await res.text()}`);

  // Auto-advance Stage to "Showing Scheduled," added 2026-09-12 per
  // Aaron's direct request ("the first time any showing is scheduled for
  // a Buyer"). This is the ONE real choke point both booking paths go
  // through (the public Get Started form and the admin "Schedule a
  // Showing" control), so it belongs here, not duplicated at each caller.
  // "First time" = never downgrade or re-trigger: only advances a stage
  // that's still BEFORE Showing Scheduled in the pipeline (blank, First
  // Contact, or ID Verified) -- a buyer already at Showing Scheduled or
  // further along (a second/third showing, or already a Buyer) is left
  // exactly where they are. Best-effort: a failure here shouldn't turn a
  // real, successful appointment booking into a visitor/admin-facing
  // error over what's really just a convenience side effect.
  try {
    await maybeAdvanceStageOnFirstShowing(accessToken, row);
  } catch (e) {
    // swallow -- see comment above
  }
}

const SHOWING_SCHEDULED_STAGE_INDEX = STAGE_VALUES.indexOf("Showing Scheduled");
async function maybeAdvanceStageOnFirstShowing(accessToken, row) {
  const range = encodeURIComponent(`${LOGINS_TAB}!AF${row}:AF${row}`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`stage read failed: ${await res.text()}`);
  const data = await res.json();
  const currentStage = ((data.values || [[]])[0] || [])[0] || "";
  const currentIdx = currentStage ? STAGE_VALUES.indexOf(currentStage) : -1;
  if (currentIdx >= SHOWING_SCHEDULED_STAGE_INDEX) return; // already there or further along -- never downgrade
  await writeStage(accessToken, row, "Showing Scheduled");
}

async function handleMyAppointments(request, env) {
  // Changed from GET ?email= to POST body 2026-09-06, same reasoning as
  // handleMyInfo above -- gate-check flagged this real PII-in-URL pattern.
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  // phone added 2026-09-14, now the PRIMARY identity -- see
  // findLoginsRowByIdentity's own comment.
  const email = (body.email || "").trim();
  const phone = (body.phone || "").trim();
  if (!email && !phone) return jsonResponse({ error: "missing identity" }, 400);
  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByIdentity(accessToken, phone, email);
    if (!row) return jsonResponse({ appointments: [] });
    const cells = await readAppointmentRawCells(accessToken, row);
    const appointments = cells.map((raw, i) => parseAppointmentCell(raw, i + 1)).filter(Boolean);
    return jsonResponse({ appointments });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Real gap found and fixed 2026-09-13, per Aaron's direct request for a
// "record of past showings, anything that has ever been scheduled... even
// if it passed" on the Buyer page: this used to blank the cell entirely
// (values: [[""]]) on a visitor's own self-service cancel, erasing any
// trace that a showing had ever been booked at all -- the admin-side
// Cancel button (appointmentManageControlsHtml -> handleAdminUpdateAppointment)
// already preserved a "Canceled" status instead of blanking, so the two
// paths had silently drifted into inconsistent behavior. Now reads the
// existing address/date first and rewrites the cell with status "Canceled"
// (same buildAppointmentCell format the admin path uses), so it still
// shows up in Past Showings. See app.js's own MY_APPOINTMENTS filter
// (status !== "Canceled") for the matching fix on the visitor-facing side
// -- otherwise a canceled-but-still-future-dated viewing would pop right
// back into the visitor's own "Viewings scheduled" list.
async function handleCancelAppointment(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  // phone added 2026-09-14, now the PRIMARY identity -- see
  // findLoginsRowByIdentity's own comment.
  const email = (body.email || "").trim();
  const phone = (body.phone || "").trim();
  const slot = parseInt(body.slot, 10);
  if ((!email && !phone) || !slot || slot < 1 || slot > APPOINTMENT_SLOT_COUNT) {
    return jsonResponse({ error: "missing/invalid identity or slot" }, 400);
  }
  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByIdentity(accessToken, phone, email);
    if (!row) return jsonResponse({ error: "no matching visitor row" }, 404);
    const col = APPOINTMENT_COLS[slot - 1];
    const range = encodeURIComponent(`${LOGINS_TAB}!${col}${row}:${col}${row}`);
    const getRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!getRes.ok) throw new Error(`cancel read failed: ${await getRes.text()}`);
    const getData = await getRes.json();
    const raw = ((getData.values && getData.values[0] && getData.values[0][0]) || "").trim();
    const existing = parseAppointmentCell(raw, slot);
    if (!existing) return jsonResponse({ error: "that slot is empty -- nothing to cancel" }, 404);
    const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
    const res = await fetch(putUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!${col}${row}:${col}${row}`, values: [[buildAppointmentCell(existing.address, existing.date, "Canceled")]] }),
    });
    if (!res.ok) throw new Error(`cancel write failed: ${await res.text()}`);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleUpdateAppointmentDate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  // phone added 2026-09-14, now the PRIMARY identity -- see
  // findLoginsRowByIdentity's own comment.
  const email = (body.email || "").trim();
  const phone = (body.phone || "").trim();
  const slot = parseInt(body.slot, 10);
  const newDate = (body.newDate || "").trim();
  if ((!email && !phone) || !slot || slot < 1 || slot > APPOINTMENT_SLOT_COUNT || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    return jsonResponse({ error: "missing/invalid identity, slot, or newDate" }, 400);
  }
  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByIdentity(accessToken, phone, email);
    if (!row) return jsonResponse({ error: "no matching visitor row" }, 404);
    const col = APPOINTMENT_COLS[slot - 1];
    const range = encodeURIComponent(`${LOGINS_TAB}!${col}${row}:${col}${row}`);
    const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
    const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!getRes.ok) throw new Error(`slot read failed: ${await getRes.text()}`);
    const getData = await getRes.json();
    const raw = ((getData.values && getData.values[0] && getData.values[0][0]) || "").trim();
    const existing = parseAppointmentCell(raw, slot);
    if (!existing) return jsonResponse({ error: "that slot is empty -- nothing to reschedule" }, 404);
    const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
    const putRes = await fetch(putUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!${col}${row}:${col}${row}`, values: [[`${existing.address} | ${newDate}`]] }),
    });
    if (!putRes.ok) throw new Error(`reschedule write failed: ${await putRes.text()}`);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// ---------- Phone-number change, verified via a reply-to-confirm text ----------
// Added 2026-09-02 -- see the PHONE_CHANGE_TIMEOUT_MS comment above for the
// full "why" (writeLoginsRow deliberately never overwrites an existing
// phone; this is the one real, gated path that can).

// Reads/writes the Pending Phone Changes tab. Row shape: Email, Old Phone,
// New Phone, Requested At, Expires At, Status, Target Row.
async function findPendingPhoneChangeByEmail(accessToken, email) {
  const range = encodeURIComponent(`${PENDING_PHONE_TAB}!A:G`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`pending-phone read failed: ${await res.text()}`);
  const data = await res.json();
  const rows = data.values || [];
  const target = email.trim().toLowerCase();
  // Last match wins if somehow more than one exists for the same email --
  // shouldn't happen given the upsert-in-place logic below, but don't crash
  // if it ever does.
  let found = null;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || "").trim().toLowerCase() === target) found = { row: i + 1, values: rows[i] };
  }
  return found;
}

async function findPendingPhoneChangeByNewPhone(accessToken, e164Phone) {
  const range = encodeURIComponent(`${PENDING_PHONE_TAB}!A:G`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`pending-phone read failed: ${await res.text()}`);
  const data = await res.json();
  const rows = data.values || [];
  for (let i = rows.length - 1; i >= 1; i--) {
    const [, , newPhone, , expiresAt, status] = rows[i];
    if ((newPhone || "").trim() === e164Phone && status === "Pending" && expiresAt && Date.parse(expiresAt) > Date.now()) {
      return { row: i + 1, values: rows[i] };
    }
  }
  return null;
}

async function writePendingPhoneChangeRow(accessToken, row, values) {
  const range = encodeURIComponent(`${PENDING_PHONE_TAB}!A${row}:G${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${PENDING_PHONE_TAB}!A${row}:G${row}`, values: [values] }),
  });
  if (!res.ok) throw new Error(`pending-phone write failed: ${await res.text()}`);
}

async function nextPendingPhoneChangeRow(accessToken) {
  const range = encodeURIComponent(`${PENDING_PHONE_TAB}!A:A`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`pending-phone read failed: ${await res.text()}`);
  const data = await res.json();
  return (data.values || []).length + 1;
}

// ---------- Pending Email Changes -- mirrors the 4 helpers above exactly,
// swapping what's being confirmed (email instead of phone) and what the
// webhook reply gets matched against (the visitor's existing on-file
// PHONE, since that's who the confirmation text actually goes to -- the
// new email itself can't receive a text). Columns: Old Email | New Email |
// Phone | Requested At | Expires At | Status | Target Row.
async function findPendingEmailChangeByOldEmail(accessToken, email) {
  const range = encodeURIComponent(`${PENDING_EMAIL_TAB}!A:G`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`pending-email read failed: ${await res.text()}`);
  const data = await res.json();
  const rows = data.values || [];
  const target = email.trim().toLowerCase();
  let found = null;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || "").trim().toLowerCase() === target) found = { row: i + 1, values: rows[i] };
  }
  return found;
}

async function findPendingEmailChangeByPhone(accessToken, e164Phone) {
  const range = encodeURIComponent(`${PENDING_EMAIL_TAB}!A:G`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`pending-email read failed: ${await res.text()}`);
  const data = await res.json();
  const rows = data.values || [];
  for (let i = rows.length - 1; i >= 1; i--) {
    const [, , phone, , expiresAt, status] = rows[i];
    if ((phone || "").trim() === e164Phone && status === "Pending" && expiresAt && Date.parse(expiresAt) > Date.now()) {
      return { row: i + 1, values: rows[i] };
    }
  }
  return null;
}

async function writePendingEmailChangeRow(accessToken, row, values) {
  const range = encodeURIComponent(`${PENDING_EMAIL_TAB}!A${row}:G${row}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: `${PENDING_EMAIL_TAB}!A${row}:G${row}`, values: [values] }),
  });
  if (!res.ok) throw new Error(`pending-email write failed: ${await res.text()}`);
}

async function nextPendingEmailChangeRow(accessToken) {
  const range = encodeURIComponent(`${PENDING_EMAIL_TAB}!A:A`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`pending-email read failed: ${await res.text()}`);
  const data = await res.json();
  return (data.values || []).length + 1;
}

async function sendQuoText(env, e164To, content) {
  const res = await fetch(`${QUO_BASE}/messages`, {
    method: "POST",
    headers: { Authorization: env.QUO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ content, from: FILLING_PHONE_NUMBER_ID, to: [e164To] }),
  });
  if (!res.ok) throw new Error(`quo send failed: ${await res.text()}`);
  return res.json();
}

// Step 1: a visitor requests a phone-number change. Only ever operates on an
// EXISTING row (found by email) -- never creates one, that's exclusively the
// gate-login path's job. Texts the NEW number and waits for a reply; the
// actual overwrite only ever happens in handleQuoMessageWebhook below.
async function handleRequestPhoneChange(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  // identityPhone added 2026-09-14, now the PRIMARY identity for finding
  // the requester's row -- see findLoginsRowByIdentity's own comment.
  // Distinct from newPhone below (the value being requested); email stays
  // in play unchanged for the pending-change record itself, which is
  // legitimately keyed by email as a value, not as an identity mechanism.
  const email = (body.email || "").trim();
  const identityPhone = (body.phone || "").trim();
  const newPhoneRaw = (body.newPhone || "").trim();
  if (!isPlausiblePhone(identityPhone) && !isPlausibleEmail(email)) return jsonResponse({ error: "invalid identity" }, 400);
  if (!isPlausiblePhone(newPhoneRaw)) return jsonResponse({ error: "invalid phone" }, 400);
  const newPhoneE164 = toE164(newPhoneRaw);
  if (!newPhoneE164) return jsonResponse({ error: "invalid phone" }, 400);

  try {
    const accessToken = await getSheetsAccessToken(env);
    const targetRow = await findLoginsRowByIdentity(accessToken, identityPhone, email);
    if (!targetRow) {
      return jsonResponse({ error: "not found", message: "We couldn't find an account with that email." }, 404);
    }

    const existingRange = encodeURIComponent(`${LOGINS_TAB}!D${targetRow}:D${targetRow}`);
    const existingRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${existingRange}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!existingRes.ok) throw new Error(`existing-phone read failed: ${await existingRes.text()}`);
    const existingData = await existingRes.json();
    const oldPhone = ((existingData.values || [[]])[0] || [])[0] || "";

    if (toE164(oldPhone) === newPhoneE164) {
      return jsonResponse({ error: "unchanged", message: "That's already the phone number we have on file." }, 400);
    }

    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + PHONE_CHANGE_TIMEOUT_MS).toISOString();
    // pendingKey falls back to identityPhone when email is blank (a
    // phone-only visitor, possible now that phone alone is valid identity)
    // -- avoids every blank-email requester colliding on the same "pending"
    // dedup lookup below. Confirmation itself still matches by the NEW
    // phone actually replying YES (see handleQuoMessageWebhook), so this
    // only affects the upsert-dedup, not correctness of the confirmation.
    const pendingKey = email || identityPhone;
    const rowValues = [pendingKey, oldPhone, newPhoneE164, nowIso, expiresIso, "Pending", String(targetRow)];

    // Upsert-in-place: refresh an existing pending request for this
    // requester rather than piling up duplicates if someone submits more
    // than once.
    const existingPending = await findPendingPhoneChangeByEmail(accessToken, pendingKey);
    const pendingRow = existingPending ? existingPending.row : await nextPendingPhoneChangeRow(accessToken);
    await writePendingPhoneChangeRow(accessToken, pendingRow, rowValues);

    await sendQuoText(
      env,
      newPhoneE164,
      `Reply YES within 1 hour to confirm updating your phone number for www.InstantApprovalHomes.com. Didn't request this? Just ignore this text.`,
    );

    return jsonResponse({ ok: true, message: `We've texted ${newPhoneE164} -- reply YES within 1 hour to confirm.` });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Step 1 of the email-change flow -- mirrors handleRequestPhoneChange
// exactly, except the confirmation text goes to the visitor's EXISTING,
// unchanged phone (email itself can't receive a text). Only ever operates
// on an existing row, found by the CURRENT email -- never creates one.
async function handleRequestEmailChange(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  // identityPhone added 2026-09-14 -- preferred for finding the requester's
  // row (see findLoginsRowByIdentity's own comment), more reliable than
  // the current email itself (a slight mistype of it would otherwise fail
  // this lookup entirely). `email` (the CURRENT email being moved away
  // from) stays required regardless -- this flow inherently needs a real
  // value to record as the "old" email, unlike the other endpoints above
  // where email was ever only a lookup key.
  const email = (body.email || "").trim();
  const identityPhone = (body.phone || "").trim();
  const newEmail = (body.newEmail || "").trim();
  if (!isPlausibleEmail(email)) return jsonResponse({ error: "invalid current email" }, 400);
  if (!isPlausibleEmail(newEmail)) return jsonResponse({ error: "invalid new email" }, 400);
  if (email.toLowerCase() === newEmail.toLowerCase()) {
    return jsonResponse({ error: "unchanged", message: "That's already the email we have on file." }, 400);
  }

  try {
    const accessToken = await getSheetsAccessToken(env);
    const targetRow = await findLoginsRowByIdentity(accessToken, identityPhone, email);
    if (!targetRow) {
      return jsonResponse({ error: "not found", message: "We couldn't find an account with that email." }, 404);
    }

    // Refuse if the desired new email already belongs to a DIFFERENT row --
    // avoids two visitor rows silently colliding on the same identity key.
    const collisionRow = await findLoginsRowByEmail(accessToken, newEmail);
    if (collisionRow && collisionRow !== targetRow) {
      return jsonResponse({ error: "in use", message: "That email is already associated with another account." }, 400);
    }

    const phoneRange = encodeURIComponent(`${LOGINS_TAB}!D${targetRow}:D${targetRow}`);
    const phoneRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${phoneRange}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!phoneRes.ok) throw new Error(`existing-phone read failed: ${await phoneRes.text()}`);
    const phoneData = await phoneRes.json();
    const onFilePhone = ((phoneData.values || [[]])[0] || [])[0] || "";
    const onFilePhoneE164 = toE164(onFilePhone);
    if (!onFilePhoneE164) {
      return jsonResponse({
        error: "no phone on file",
        message: "We don't have a phone number on file to confirm this with -- please add one first, or contact us directly.",
      }, 400);
    }

    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + EMAIL_CHANGE_TIMEOUT_MS).toISOString();
    const rowValues = [email, newEmail, onFilePhoneE164, nowIso, expiresIso, "Pending", String(targetRow)];

    // Upsert-in-place, same reasoning as the phone flow: refresh an
    // existing pending request for this email rather than piling up
    // duplicates on repeated submissions.
    const existingPending = await findPendingEmailChangeByOldEmail(accessToken, email);
    const pendingRow = existingPending ? existingPending.row : await nextPendingEmailChangeRow(accessToken);
    await writePendingEmailChangeRow(accessToken, pendingRow, rowValues);

    await sendQuoText(
      env,
      onFilePhoneE164,
      `Reply YES within 1 hour to confirm updating your email to ${newEmail} for www.InstantApprovalHomes.com. Didn't request this? Just ignore this text.`,
    );

    return jsonResponse({ ok: true, message: `We've texted your phone on file -- reply YES within 1 hour to confirm.` });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// ---------- OpenPhone/Quo webhook signature verification ----------
// Real, confirmed format (found live 2026-09-02 by capturing an actual
// request's headers -- the docs summary that led to the first attempt said
// "Standard-Webhooks-compatible", webhook-id/webhook-timestamp/webhook-
// signature headers, whsec_-prefixed secret -- confirmed wrong). The real
// header is a single `openphone-signature`, format
// `<scheme>;<version>;<timestamp>;<signature>` (e.g.
// "hmac;1;1639710054089;mw1K4fvh5m9XzsGon4C5N3KvL0bkmPZSAyb/9Vms2Qo="),
// matches OpenPhone's own real docs. Signed content is `{timestamp}.
// {payload}` (no id component), and the payload must have ALL whitespace/
// newlines stripped before signing -- re-serializing via
// JSON.stringify(JSON.parse(rawBody)) reproduces OpenPhone's own minified
// form for ordinary JSON. Verified against a real live webhook call.
async function verifyQuoWebhookSignature(request, rawBody, secret) {
  const sigHeader = request.headers.get("openphone-signature");
  if (!sigHeader) return false;

  const parts = sigHeader.split(";");
  if (parts.length !== 4) return false;
  const [, , timestamp, signature] = parts;

  let minified;
  try {
    minified = JSON.stringify(JSON.parse(rawBody));
  } catch (e) {
    return false;
  }

  const secretBytes = base64ToBytes(secret.trim());
  const signedContent = `${timestamp}.${minified}`;
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expected = bytesToBase64(new Uint8Array(sigBytes));

  return expected === signature;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Writes Quo-sourced identity onto this buyer's own App: Logins row: Quo
// Name (AJ) and Quo Link (N) if either is still blank -- non-destructive,
// same "fill a gap, never clobber" stance as writeLoginsRow's phone/name --
// and Last Activity (AK), which always refreshes since "most recent" is
// the only correct value for that one. Creates a bare phone-only row if
// none exists yet (a Quo-only buyer who's never been gated or booked a
// showing has no row at all otherwise) -- same convention as
// appendLoginsRow's other callers. Looks the Quo contact up itself rather
// than taking one as a parameter -- called standalone from several places
// below, not just ensureBuyerInCache, so it can't assume a caller already
// has one in hand.
// areasIfBlank (optional), added 2026-09-13 for the one-time area
// migration: 429 buyers had areas known ONLY via the old Quo-name-TB-tag
// parsing (admin-buyers-worker.js's parseAreasFromName, read at crawl
// time), with nothing ever written to this Sheet's own Manual Area
// Override column -- confirmed live via buyers_cache: 429 had a non-empty
// `areas` array with an EMPTY manualAreaOverride. Moving the buyers page
// off buyers_cache entirely (see comment above ensureBuyerInCache) would
// have silently blanked every one of their areas the moment that Quo-side
// parsing stopped running. Backfills AD from the caller's already-known
// areas, same non-destructive "only fill a gap" stance as Quo Name/Link.
// touchActivity (default true), added 2026-09-14 -- real bug found and
// fixed the same night: this used to stamp AK (Last Activity) to "now"
// on EVERY call unconditionally, including the one-time bulk backfill
// script (handleInternalSyncBuyerToSheet) that ran across all 741 known
// buyers TWICE that same evening for a completely unrelated reason
// (populating Quo Name/Link/Areas) -- confirmed live: Aaron noticed
// almost every row showing today's date in Last Activity, which was
// never real activity, just the backfill's own run time overwriting it.
// The REAL-TIME webhook path (ensureBuyerInCache, called on an actual
// inbound message) is the only caller that should ever touch this column
// -- that's genuine "something just happened." The manual/backfill
// trigger now passes touchActivity: false.
async function syncBuyerToSheet(env, e164Phone, areasIfBlank, touchActivity = true) {
  const [contact, accessToken] = await Promise.all([
    quoFindContactByPhone(env, e164Phone),
    getSheetsAccessToken(env),
  ]);
  const d = (contact && contact.defaultFields) || {};
  const quoName = [d.firstName, d.lastName].filter(Boolean).join(" ").trim();
  const quoLink = contact ? `https://my.quo.com/contacts/${contact.id}` : "";
  const nowIso = new Date().toISOString();

  let row = await findLoginsRowByPhone(accessToken, e164Phone);
  if (!row) {
    await appendLoginsRow(accessToken, e164Phone, "", "");
    row = await findLoginsRowByPhone(accessToken, e164Phone);
    if (!row) return; // shouldn't happen -- just appended it moments ago
  }

  // One read (N, AJ, AD together, via batchGet) to decide what's actually
  // still blank, then one write (batchUpdate) for whatever needs it.
  const getUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet`);
  getUrl.searchParams.append("ranges", `'${LOGINS_TAB}'!N${row}:N${row}`);
  getUrl.searchParams.append("ranges", `'${LOGINS_TAB}'!AJ${row}:AJ${row}`);
  getUrl.searchParams.append("ranges", `'${LOGINS_TAB}'!AD${row}:AD${row}`);
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!getRes.ok) throw new Error(`quo-name/link/area read failed: ${await getRes.text()}`);
  const getData = await getRes.json();
  const existingQuoLink = (((getData.valueRanges || [])[0] || {}).values || [[]])[0]?.[0] || "";
  const existingQuoName = (((getData.valueRanges || [])[1] || {}).values || [[]])[0]?.[0] || "";
  const existingAreas = (((getData.valueRanges || [])[2] || {}).values || [[]])[0]?.[0] || "";

  const data = [];
  if (touchActivity) data.push({ range: `${LOGINS_TAB}!AK${row}:AK${row}`, values: [[nowIso]] });
  if (!existingQuoLink && quoLink) data.push({ range: `${LOGINS_TAB}!N${row}:N${row}`, values: [[quoLink]] });
  if (!existingQuoName && quoName) data.push({ range: `${LOGINS_TAB}!AJ${row}:AJ${row}`, values: [[quoName]] });
  if (!existingAreas && areasIfBlank) data.push({ range: `${LOGINS_TAB}!AD${row}:AD${row}`, values: [[areasIfBlank]] });

  if (data.length === 0) return; // nothing changed -- e.g. a backfill re-run (touchActivity: false) that found no new gaps to fill

  const putRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });
  if (!putRes.ok) throw new Error(`quo-name/link/activity/area write failed: ${await putRes.text()}`);
}

// Step 2: Quo calls this when a message.received event fires on the Filling
// number. Verifies the signature first (unsigned/forged requests never get
// to touch the Sheet), then checks for a real, still-valid, matching pending
// request before doing anything. Always returns 200 once the signature
// check passes -- an unmatched or non-affirmative text is a normal, expected
// case (Quo delivers every inbound message to this number, not just replies
// to a pending request), not an error.
async function handleQuoMessageWebhook(request, env) {
  const rawBody = await request.text();

  if (!env.QUO_WEBHOOK_SECRET) {
    return jsonResponse({ error: "webhook not configured" }, 500);
  }
  const validSignature = await verifyQuoWebhookSignature(request, rawBody, env.QUO_WEBHOOK_SECRET);
  if (!validSignature) {
    return jsonResponse({ error: "invalid signature" }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return jsonResponse({ error: "invalid JSON" }, 400);
  }

  // Real field names confirmed 2026-09-02 via a captured live payload:
  // event type is "type", not "event"; the message object lives at
  // data.object, not data.resource -- both wrong guesses from a docs
  // summary rather than real payload data.
  if (payload.type !== "message.received") {
    return jsonResponse({ ok: true }); // not the event we care about, ack and ignore
  }

  const resource = (payload.data && payload.data.object) || {};
  const fromRaw = resource.from || (payload.data && payload.data.context && payload.data.context.from) || "";
  const text = (resource.text || resource.content || resource.body || "").trim();
  const fromE164 = toE164(fromRaw);

  // Runs for EVERY real inbound message, not just phone/email-confirmation
  // replies -- see ensureBuyerInCache's own comment above for why this
  // lives here. ctx.waitUntil isn't available in this handler's own scope
  // (it's called from the main fetch() below, not given ctx directly), so
  // this is awaited inline; best-effort/swallows its own errors either way.
  if (fromE164) await syncBuyerToSheet(env, fromE164);

  if (!fromE164 || !/^(yes|y|confirm|ok)\b/i.test(text)) {
    return jsonResponse({ ok: true }); // not an affirmative reply, nothing to do
  }

  try {
    const accessToken = await getSheetsAccessToken(env);
    const pendingPhone = await findPendingPhoneChangeByNewPhone(accessToken, fromE164);
    if (pendingPhone) {
      const [email, oldPhone, newPhone, , , , targetRowStr] = pendingPhone.values;
      const targetRow = Number(targetRowStr);

      const phoneUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${LOGINS_TAB}!D${targetRow}:D${targetRow}`)}?valueInputOption=RAW`;
      const writeRes = await fetch(phoneUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ range: `${LOGINS_TAB}!D${targetRow}:D${targetRow}`, values: [[newPhone]] }),
      });
      if (!writeRes.ok) throw new Error(`phone overwrite failed: ${await writeRes.text()}`);

      const confirmedRow = [email, oldPhone, newPhone, pendingPhone.values[3], pendingPhone.values[4], "Confirmed", targetRowStr];
      await writePendingPhoneChangeRow(accessToken, pendingPhone.row, confirmedRow);

      // Real bug fixed 2026-09-02: both notifications below were originally
      // fire-and-forget (fetch(...).catch(() => {}), no await) -- a real
      // Cloudflare Workers gotcha: an unawaited promise can be killed the
      // moment the response returns, since the runtime is free to tear down
      // the execution context right after. Confirmed live: the Sheet write
      // above (which WAS awaited) worked, but neither notification arrived.
      // Fixed by awaiting both -- still wrapped so a Telegram/Quo hiccup can
      // never turn the actual, already-successful overwrite into an error
      // response, but now the request genuinely doesn't finish until both
      // have had a real chance to complete.
      if (env.TELEGRAM_BOT_TOKEN) {
        const text2 = `Phone number CHANGED (visitor-confirmed) — ${email}.\nOld: ${oldPhone || "(blank)"}\nNew: ${newPhone}`;
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: AARON_TELEGRAM_CHAT_ID, text: text2 }),
        }).catch(() => {});
      }

      await sendQuoText(env, fromE164, "Thanks! Your phone number has been updated.").catch(() => {});

      return jsonResponse({ ok: true });
    }

    // No matching pending PHONE change -- check pending EMAIL changes next.
    // These are matched by the visitor's EXISTING (unchanged) phone number,
    // since that's who the confirmation text actually went to -- the new
    // email itself can't receive a text reply.
    const pendingEmail = await findPendingEmailChangeByPhone(accessToken, fromE164);
    if (!pendingEmail) {
      return jsonResponse({ ok: true }); // no matching/still-valid pending request of either kind
    }

    const [oldEmail, newEmail, onFilePhone, , , , targetRowStr2] = pendingEmail.values;
    const targetRow2 = Number(targetRowStr2);

    const emailUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${LOGINS_TAB}!B${targetRow2}:B${targetRow2}`)}?valueInputOption=RAW`;
    const writeRes2 = await fetch(emailUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!B${targetRow2}:B${targetRow2}`, values: [[newEmail]] }),
    });
    if (!writeRes2.ok) throw new Error(`email overwrite failed: ${await writeRes2.text()}`);

    const confirmedRow2 = [oldEmail, newEmail, onFilePhone, pendingEmail.values[3], pendingEmail.values[4], "Confirmed", targetRowStr2];
    await writePendingEmailChangeRow(accessToken, pendingEmail.row, confirmedRow2);

    if (env.TELEGRAM_BOT_TOKEN) {
      const text3 = `Email CHANGED (visitor-confirmed) — was ${oldEmail}.\nNew: ${newEmail}`;
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: AARON_TELEGRAM_CHAT_ID, text: text3 }),
      }).catch(() => {});
    }

    await sendQuoText(env, fromE164, "Thanks! Your email has been updated.").catch(() => {});

    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

// Triage notifications for missed calls / unreplied texts, added 2026-09-05
// -- replaces a 15-min polling watch-script on the NanoClaw side (item #5
// of that project's backlog) with real Quo webhooks, zero polling. Deliberately
// its own route + its own signing secret, entirely independent of
// handleQuoMessageWebhook above (a different purpose -- phone/email change
// confirmation) -- neither can break the other.
//
// Field-name assumption, flagged rather than silently trusted: the
// message.received shape (payload.type, data.object.from/text) is confirmed
// from a real captured payload (see handleQuoMessageWebhook's own comment).
// call.completed's shape is inferred from the REST /v1/calls response shape
// (status/direction/participants), NOT yet confirmed from a real delivered
// webhook -- verify with Quo's "send a test event to a webhook" endpoint
// right after this deploys, and correct the field paths below if the real
// payload differs.
async function handleQuoTriageWebhook(request, env) {
  const rawBody = await request.text();

  // Two separate Quo webhook subscriptions (calls, messages) both point at
  // this one route -- each got its own distinct signing key at creation
  // (confirmed live, not assumed), so this checks against both known
  // secrets rather than picking one; either matching is a valid signature.
  const candidateSecrets = [env.QUO_TRIAGE_MESSAGES_SECRET, env.QUO_TRIAGE_CALLS_SECRET].filter(Boolean);
  if (candidateSecrets.length === 0) {
    return jsonResponse({ error: "webhook not configured" }, 500);
  }
  let validSignature = false;
  for (const secret of candidateSecrets) {
    if (await verifyQuoWebhookSignature(request, rawBody, secret)) {
      validSignature = true;
      break;
    }
  }
  if (!validSignature) {
    return jsonResponse({ error: "invalid signature" }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return jsonResponse({ error: "invalid JSON" }, 400);
  }

  const resource = (payload.data && payload.data.object) || {};
  const nowIso = () => new Date().toISOString();

  // Accumulate-then-digest, added 2026-09-05 (Aaron's explicit request: no
  // per-event ping, one daily Momentum rollup instead). Writes a plain row
  // to the "Pending Follow-ups" tab in the Agent System Database Sheet
  // (same GCP service account already used against the Filling Sheet
  // above -- confirmed shared access, no new credential). A separate daily
  // job on the NanoClaw side reads this tab, composes one digest, and
  // marks rows Done -- see watch-scripts/quo-followup-digest.ts.
  //
  // Deliberately NOT calling Quo's call-summary/nextSteps here: that
  // endpoint summarizes a real, completed conversation -- a genuinely
  // missed/no-answer/abandoned call has no conversation to summarize by
  // definition. call-summary IS a real, useful future enhancement for
  // reviewing ANSWERED calls that might still need a follow-up, but that's
  // a different, broader feature than "missed calls / unreplied texts" --
  // flag it to Aaron as a real option later rather than build it blind now.
  let row = null;

  if (payload.type === "message.received") {
    const from = resource.from || (payload.data && payload.data.context && payload.data.context.from) || "unknown";
    const body = (resource.text || resource.content || resource.body || "").trim().slice(0, 500);
    row = ["Unreplied Text", from, body, "", "Open", resource.phoneNumberId || ""];
  } else if (payload.type === "call.completed") {
    const direction = resource.direction;
    const status = resource.status;
    if (direction === "incoming" && status && status !== "completed") {
      // The other party's number isn't cleanly separated from Aaron's own
      // Quo number in the REST /calls shape (both just sit in
      // `participants`) -- best-effort join rather than guessing which
      // index is which; correct this once the real webhook payload is seen
      // (flagged in this function's own top comment).
      const from = resource.from || (Array.isArray(resource.participants) ? resource.participants.join(" / ") : "unknown");
      row = ["Missed Call", from, `Status: ${status}`, "", "Open", resource.phoneNumberId || ""];
    }
  }

  if (row) {
    try {
      const accessToken = await getSheetsAccessToken(env);
      const range = encodeURIComponent("Pending Follow-ups!A:G");
      const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${DB_SHEET_ID}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
      const appendRes = await fetch(appendUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[nowIso(), ...row]] }),
      });
      if (!appendRes.ok) {
        // Log-and-continue, not throw -- Quo doesn't need a 500 for this;
        // a lost row here is recoverable (Aaron can be told directly), a
        // broken webhook ack could cause Quo to retry/disable the sub.
        console.error("Pending Follow-ups append failed:", await appendRes.text());
      }
    } catch (e) {
      console.error("Pending Follow-ups append threw:", String(e));
    }
  }

  return jsonResponse({ ok: true });
}

// Real per-request CORS fix, added 2026-08-31 (multi-origin bug found the
// day of the instantapprovalhomes.com domain cutover -- the site started
// loading from the new domain, but every internal response still hardcoded
// Access-Control-Allow-Origin to the old github.io origin, so browsers
// silently blocked every fetch() from the real site: curl (no CORS
// enforcement) worked fine, masking this from a raw endpoint test, but the
// real browser correctly refused every response and the frontend surfaced
// it as a generic "Something went wrong" error). Rather than thread the
// real Origin through every individual jsonResponse()/corsHeaders() call
// site (30+ of them), this wraps the single top-level fetch() entry point
// and rewrites just the one response header afterward, based on the
// incoming request's actual Origin against the allowlist above. Anything
// not on the allowlist (or with no Origin header at all -- e.g. a direct
// server-to-server call) is left exactly as the inner handlers already set
// it, unchanged from the original single-origin behavior.
async function route(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  const url = new URL(request.url);

  if (url.pathname === "/gate-login" && request.method === "POST") {
    return handleGateLogin(request, env);
  }

  if (url.pathname === "/sync-visitor" && request.method === "POST") {
    return handleSyncVisitor(request, env);
  }

  if (url.pathname === "/upload-id" && request.method === "POST") {
    return handleUploadId(request, env);
  }

  if (url.pathname === "/confirm-id-match" && request.method === "POST") {
    return handleConfirmIdMatch(request, env);
  }

  if (url.pathname === "/admin/upload-id" && request.method === "POST") {
    return handleAdminUploadId(request, env);
  }
  if (url.pathname === "/admin/browse-id-photos" && request.method === "GET") {
    return handleAdminBrowseIdPhotos(request, env);
  }
  if (url.pathname === "/admin/id-photo-preview-link" && request.method === "GET") {
    return handleAdminIdPhotoPreviewLink(request, env);
  }
  if (url.pathname === "/admin/update-contact-name" && request.method === "POST") {
    return handleAdminUpdateContactName(request, env);
  }
  if (url.pathname === "/admin/set-areas" && request.method === "POST") {
    return handleAdminSetAreas(request, env);
  }
  if (url.pathname === "/admin/add-appointment" && request.method === "POST") {
    return handleAdminAddAppointment(request, env);
  }
  if (url.pathname === "/admin/update-appointment" && request.method === "POST") {
    return handleAdminUpdateAppointment(request, env);
  }
  if (url.pathname === "/admin/set-sentiment" && request.method === "POST") {
    return handleAdminSetSentiment(request, env);
  }
  if (url.pathname === "/admin/set-stage" && request.method === "POST") {
    return handleAdminSetStage(request, env);
  }
  if (url.pathname === "/admin/backfill-stage" && request.method === "POST") {
    return handleAdminBackfillStage(request, env);
  }
  if (url.pathname === "/internal/backfill-stage" && request.method === "POST") {
    return handleInternalBackfillStage(request, env);
  }
  if (url.pathname === "/admin/set-hidden" && request.method === "POST") {
    return handleAdminSetHidden(request, env);
  }
  if (url.pathname === "/admin/set-dnc" && request.method === "POST") {
    return handleAdminSetDnc(request, env);
  }
  if (url.pathname === "/admin/set-co-buyer" && request.method === "POST") {
    return handleAdminSetCoBuyer(request, env);
  }

  if (url.pathname === "/internal/resync-buyer" && request.method === "POST") {
    return handleInternalResyncBuyer(request, env);
  }
  if (url.pathname === "/internal/backfill-role" && request.method === "POST") {
    return handleInternalBackfillRole(request, env);
  }
  if (url.pathname === "/internal/list-webhooks" && request.method === "GET") {
    return handleInternalListWebhooks(request, env);
  }
  if (url.pathname === "/internal/update-webhook" && request.method === "POST") {
    return handleInternalUpdateWebhook(request, env);
  }
  if (url.pathname === "/internal/raw-contact" && request.method === "GET") {
    return handleInternalRawContact(request, env);
  }
  if (url.pathname === "/internal/sheet-headers" && request.method === "GET") {
    return handleInternalSheetHeaders(request, env);
  }
  if (url.pathname === "/internal/write-cell" && request.method === "POST") {
    return handleInternalWriteCell(request, env);
  }
  if (url.pathname === "/internal/sync-buyer-to-sheet" && request.method === "POST") {
    return handleInternalSyncBuyerToSheet(request, env);
  }
  if (url.pathname === "/internal/find-duplicate-phones" && request.method === "GET") {
    return handleInternalFindDuplicatePhones(request, env);
  }
  if (url.pathname === "/internal/search-buyers-tab" && request.method === "GET") {
    return handleInternalSearchBuyersTab(request, env);
  }
  if (url.pathname === "/internal/quo-name-stats" && request.method === "GET") {
    return handleInternalQuoNameStats(request, env);
  }
  if (url.pathname === "/internal/restore-activity" && request.method === "POST") {
    return handleInternalRestoreActivity(request, env);
  }
  if (url.pathname === "/internal/backfill-names-from-quo" && request.method === "GET") {
    return handleInternalBackfillNamesFromQuo(request, env);
  }
  if (url.pathname === "/internal/glide-match" && request.method === "GET") {
    return handleInternalGlideMatch(request, env);
  }
  if (url.pathname === "/internal/find-logins-row" && request.method === "GET") {
    return handleInternalFindLoginsRow(request, env);
  }
  if (url.pathname === "/internal/find-quo-contact" && request.method === "GET") {
    return handleInternalFindQuoContact(request, env);
  }
  if (url.pathname === "/internal/list-id-files" && request.method === "GET") {
    return handleInternalListIdFiles(request, env);
  }
  if (url.pathname === "/internal/id-file-bytes" && request.method === "GET") {
    return handleInternalIdFileBytes(request, env);
  }
  if (url.pathname === "/internal/contacts" && request.method === "GET") {
    return handleInternalContacts(request, env);
  }
  if (url.pathname === "/internal/auto-link-id" && request.method === "POST") {
    return handleInternalAutoLinkId(request, env);
  }

  if (url.pathname === "/mark-shown" && request.method === "POST") {
    return handleMarkShown(request, env);
  }

  if (url.pathname === "/admin-id-photo" && request.method === "POST") {
    return handleAdminIdPhoto(request, env);
  }

  if (url.pathname === "/my-appointments" && request.method === "POST") {
    return handleMyAppointments(request, env);
  }

  if (url.pathname === "/cancel-appointment" && request.method === "POST") {
    return handleCancelAppointment(request, env);
  }

  if (url.pathname === "/update-appointment-date" && request.method === "POST") {
    return handleUpdateAppointmentDate(request, env);
  }

  if (url.pathname === "/admin-activity" && request.method === "GET") {
    return handleAdminActivity(request, env);
  }

  if (url.pathname === "/favorite-counts" && request.method === "GET") {
    return handleFavoriteCounts(request, env);
  }

  if (url.pathname === "/id-photo" && request.method === "POST") {
    return handleIdPhoto(request, env);
  }

  if (url.pathname === "/my-info" && request.method === "POST") {
    return handleMyInfo(request, env);
  }

  if (url.pathname === "/update-name" && request.method === "POST") {
    return handleUpdateName(request, env);
  }

  if (url.pathname === "/request-phone-change" && request.method === "POST") {
    return handleRequestPhoneChange(request, env);
  }

  if (url.pathname === "/request-email-change" && request.method === "POST") {
    return handleRequestEmailChange(request, env);
  }

  if (url.pathname === "/update-co-buyer" && request.method === "POST") {
    return handleUpdateCoBuyer(request, env);
  }

  if (url.pathname === "/upload-co-buyer-id" && request.method === "POST") {
    return handleUploadCoBuyerId(request, env);
  }

  if (url.pathname === "/upload-my-id" && request.method === "POST") {
    return handleUploadMyId(request, env);
  }

  // Called by Quo itself, not the site -- no CORS-origin concern here, this
  // is a server-to-server webhook.
  if (url.pathname === "/quo-webhook" && request.method === "POST") {
    return handleQuoMessageWebhook(request, env);
  }

  // Separate Quo webhook route for Triage notifications (missed calls /
  // unreplied texts) -- added 2026-09-05, own secret, own handler, see
  // handleQuoTriageWebhook's own comment for why this stays independent
  // of the route above.
  if (url.pathname === "/quo-triage-webhook" && request.method === "POST") {
    return handleQuoTriageWebhook(request, env);
  }

  if (request.method === "GET") {
    const listingId = url.searchParams.get("id");
    if (!listingId) return jsonResponse({ error: "missing id" }, 400);
    return handleAdminLookup(request, env, listingId);
  }

  return jsonResponse({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const response = await route(request, env);
    const origin = request.headers.get("Origin");
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", origin);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  },
};


// Instant-Approval Home Financing -- Admin API + Login-Gate Lead Capture
// (Cloudflare Worker)
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
async function findOrNextLoginsRow(accessToken, email) {
  const range = encodeURIComponent(`${LOGINS_TAB}!A:F`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`logins read failed: ${await res.text()}`);
  const data = await res.json();
  const col = data.values || [];
  const target = email.trim().toLowerCase();
  for (let i = 1; i < col.length; i++) {
    if ((col[i][1] || "").trim().toLowerCase() === target) {
      const existing = col[i] || [];
      return {
        row: i + 1, // 1-indexed sheet row
        isNew: false,
        existingPhone: (existing[3] || "").trim(),
        existingName: (existing[4] || "").trim(),
        existingIdLink: (existing[5] || "").trim(),
      };
    }
  }
  return { row: col.length + 1, isNew: true };
}

// Writes the full A:G span for a gate-login event. For a brand-new visitor
// this fills First Login through Last Login (columns A-G). For a returning
// visitor (isNew: false) this writes Phone/Name/Last Login (D, E, G) --
// NOT a blind overwrite: each of Phone/Name keeps its EXISTING value if one
// is already on file, and only takes the newly-submitted value to fill in
// a gap that was previously blank (see findOrNextLoginsRow above, which
// supplies existingPhone/existingName/existingIdLink for exactly this).
// Real reported bug, fixed 2026-08-29: this used to only ever touch Last
// Login for a returning visitor, so a legacy blank-Name row (e.g. from
// before the gate collected a name at all) could never be filled in later,
// even by a visitor who then typed their real name on a subsequent visit.
// ID Link (F) is always echoed back untouched either way -- the gate never
// collects it, so there's nothing to backfill or protect there, just don't
// let it get wiped by the batch write. Explicit-row values.update, not
// :append -- see the real auto-detection bug this avoided, documented in
// git history for this file (values:append landed a real submission's data
// starting at column O instead of A, on a row far past the real last row).
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
    const finalPhone = target.existingPhone || phone || "";
    const finalName = target.existingName || name || "";
    const finalIdLink = target.existingIdLink || "";
    const values = [[finalPhone, finalName, finalIdLink, nowIso]];
    const range = encodeURIComponent(`${LOGINS_TAB}!D${row}:G${row}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!D${row}:G${row}`, values }),
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

async function quoFindContactByPhone(env, e164Phone) {
  let pageToken;
  for (let page = 0; page < 10; page++) {
    const resp = await quoCall(env, "/contacts", { maxResults: "50", pageToken });
    const found = (resp.data || []).find((c) => (c.defaultFields.phoneNumbers || []).some((p) => p.value === e164Phone));
    if (found) return found;
    if (!resp.nextPageToken) break;
    pageToken = resp.nextPageToken;
  }
  return null;
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
    target = await findOrNextLoginsRow(accessToken, email);
    // Captured BEFORE writeLoginsRow, which is what actually fills the gap --
    // this reflects the row's state as it stood coming into this request.
    const phoneWasBlank = !target.isNew && !target.existingPhone;
    await writeLoginsRow(accessToken, target, { name, email, phone, agreed });
    target.phoneJustBackfilled = phoneWasBlank && !!phone;
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
      const phone = (row[2] || "").trim();
      const name = (row[3] || "").trim();
      for (let slot = 0; slot < 10; slot++) {
        const raw = (row[13 + slot] || "").trim();
        if (!raw) continue;
        const parts = raw.split(" | ");
        const address = (parts[0] || "").trim();
        const date = (parts[1] || "").trim();
        if (address && date) appointments.push({ address, date, name, email, phone });
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
  const url = new URL(request.url);
  const email = (url.searchParams.get("email") || "").trim();
  if (!isPlausibleEmail(email)) return jsonResponse({ error: "invalid email" }, 400);

  const cache = caches.default;
  const cacheKey = new Request(`https://id-photo-cache.internal/${encodeURIComponent(email.toLowerCase())}`, request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByEmail(accessToken, email);
    if (!row) return jsonResponse({ error: "not found" }, 404);

    const linkRange = encodeURIComponent(`${LOGINS_TAB}!F${row}:F${row}`);
    const linkRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${linkRange}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!linkRes.ok) throw new Error(`ID link read failed: ${await linkRes.text()}`);
    const linkData = await linkRes.json();
    const sharedLink = ((linkData.values || [[]])[0] || [])[0] || "";
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

async function handleSyncVisitor(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  const email = (body.email || "").trim();
  if (!email) return jsonResponse({ error: "missing email" }, 400);
  const filters = body.filters || {};
  const search = (body.search || "").trim();

  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByEmail(accessToken, email);
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

  if (!name || !email || !phone || !property || !inspectionDate) {
    return jsonResponse({ error: "missing required field" }, 400);
  }
  if (!idPhoto || typeof idPhoto === "string") {
    return jsonResponse({ error: "missing ID photo" }, 400);
  }

  try {
    const dropboxToken = await getDropboxAccessToken(env);
    const filename = buildIdFilename(name, phone, idPhoto.name);
    const destPath = `${DROPBOX_IDS_FOLDER}/${filename}`;
    const fileBytes = await idPhoto.arrayBuffer();

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
      const accessToken = await getSheetsAccessToken(env);
      const target = await findOrNextLoginsRow(accessToken, email);
      await writeLoginsRow(accessToken, target, { name, email, phone, agreed: true });
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
    // comment above this section for why). Best-effort, same as the
    // gate-login push: a failed notification never blocks the visitor.
    if (env.TELEGRAM_BOT_TOKEN) {
      const text =
        `ID uploaded — ${name}, ${phone}, ${email}.\n` +
        `Property: ${property}\n` +
        `Wants to inspect: ${inspectionDate} (9 AM–8 PM, confirm 1 hr ahead)\n` +
        `Filed as: ${filename}\n` +
        // Folder link, not a link to this exact file -- see
        // DROPBOX_BUYER_IDS_FOLDER_LINK's own comment for why.
        `${DROPBOX_BUYER_IDS_FOLDER_LINK}` +
        (appointmentSaved ? "" : "\n(Note: could not save this appointment to App: Logins -- check manually.)");
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
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

function parseAppointmentCell(raw, slot) {
  if (!raw) return null;
  const parts = raw.split(" | ");
  const address = (parts[0] || "").trim();
  const date = (parts[1] || "").trim();
  if (!address || !date) return null;
  return { slot, address, date };
}

// Drops any already-past slots, appends the new one, and FIFO-caps at 10 if
// genuinely more than 10 are still active. "today" here is server-side
// UTC, an approximation -- fine, since this only prunes stale entries to
// free capacity and never blocks a visitor action, unlike the client-side
// local-date check that guards the actual date PICKER.
async function addAppointment(accessToken, row, address, date) {
  const cells = await readAppointmentRawCells(accessToken, row);
  const todayUtc = new Date().toISOString().slice(0, 10);
  let active = cells
    .map((raw, i) => parseAppointmentCell(raw, i + 1))
    .filter((a) => a && a.date >= todayUtc)
    .map((a) => `${a.address} | ${a.date}`);
  active.push(`${address} | ${date}`);
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
}

async function handleMyAppointments(request, env) {
  const url = new URL(request.url);
  const email = (url.searchParams.get("email") || "").trim();
  if (!email) return jsonResponse({ error: "missing email" }, 400);
  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByEmail(accessToken, email);
    if (!row) return jsonResponse({ appointments: [] });
    const cells = await readAppointmentRawCells(accessToken, row);
    const appointments = cells.map((raw, i) => parseAppointmentCell(raw, i + 1)).filter(Boolean);
    return jsonResponse({ appointments });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
}

async function handleCancelAppointment(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  const email = (body.email || "").trim();
  const slot = parseInt(body.slot, 10);
  if (!email || !slot || slot < 1 || slot > APPOINTMENT_SLOT_COUNT) {
    return jsonResponse({ error: "missing/invalid email or slot" }, 400);
  }
  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByEmail(accessToken, email);
    if (!row) return jsonResponse({ error: "no matching visitor row" }, 404);
    const col = APPOINTMENT_COLS[slot - 1];
    const range = encodeURIComponent(`${LOGINS_TAB}!${col}${row}:${col}${row}`);
    const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
    const res = await fetch(putUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!${col}${row}:${col}${row}`, values: [[""]] }),
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
  const email = (body.email || "").trim();
  const slot = parseInt(body.slot, 10);
  const newDate = (body.newDate || "").trim();
  if (!email || !slot || slot < 1 || slot > APPOINTMENT_SLOT_COUNT || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    return jsonResponse({ error: "missing/invalid email, slot, or newDate" }, 400);
  }
  try {
    const accessToken = await getSheetsAccessToken(env);
    const row = await findLoginsRowByEmail(accessToken, email);
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
  const email = (body.email || "").trim();
  const newPhoneRaw = (body.newPhone || "").trim();
  if (!isPlausibleEmail(email)) return jsonResponse({ error: "invalid email" }, 400);
  if (!isPlausiblePhone(newPhoneRaw)) return jsonResponse({ error: "invalid phone" }, 400);
  const newPhoneE164 = toE164(newPhoneRaw);
  if (!newPhoneE164) return jsonResponse({ error: "invalid phone" }, 400);

  try {
    const accessToken = await getSheetsAccessToken(env);
    const targetRow = await findLoginsRowByEmail(accessToken, email);
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
    const rowValues = [email, oldPhone, newPhoneE164, nowIso, expiresIso, "Pending", String(targetRow)];

    // Upsert-in-place: refresh an existing pending request for this email
    // rather than piling up duplicates if someone submits more than once.
    const existingPending = await findPendingPhoneChangeByEmail(accessToken, email);
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

  if (!fromE164 || !/^(yes|y|confirm|ok)\b/i.test(text)) {
    return jsonResponse({ ok: true }); // not an affirmative reply, nothing to do
  }

  try {
    const accessToken = await getSheetsAccessToken(env);
    const pending = await findPendingPhoneChangeByNewPhone(accessToken, fromE164);
    if (!pending) {
      return jsonResponse({ ok: true }); // no matching/still-valid pending request
    }

    const [email, oldPhone, newPhone, , , , targetRowStr] = pending.values;
    const targetRow = Number(targetRowStr);

    const phoneUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${LOGINS_TAB}!D${targetRow}:D${targetRow}`)}?valueInputOption=RAW`;
    const writeRes = await fetch(phoneUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!D${targetRow}:D${targetRow}`, values: [[newPhone]] }),
    });
    if (!writeRes.ok) throw new Error(`phone overwrite failed: ${await writeRes.text()}`);

    const confirmedRow = [email, oldPhone, newPhone, pending.values[3], pending.values[4], "Confirmed", targetRowStr];
    await writePendingPhoneChangeRow(accessToken, pending.row, confirmedRow);

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
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
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

  if (url.pathname === "/my-appointments" && request.method === "GET") {
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

  if (url.pathname === "/id-photo" && request.method === "GET") {
    return handleIdPhoto(request, env);
  }

  if (url.pathname === "/request-phone-change" && request.method === "POST") {
    return handleRequestPhoneChange(request, env);
  }

  // Called by Quo itself, not the site -- no CORS-origin concern here, this
  // is a server-to-server webhook.
  if (url.pathname === "/quo-webhook" && request.method === "POST") {
    return handleQuoMessageWebhook(request, env);
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


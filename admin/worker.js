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

// Quo (OpenPhone) -- same base URL/auth shape as tools/quo.mjs on the
// droplet ("Authorization: <key>", no Bearer prefix -- confirmed against
// Quo's own docs, which explicitly say they don't use Bearer tokens).
// PN6pbOQwqH is the "Filling" number (618-418-4180), the one this whole
// site's Call/Text buttons point at -- new-visitor contacts get checked/
// created against conversations on this specific number, not "any number."
const QUO_BASE = "https://api.quo.com/v1";
const FILLING_PHONE_NUMBER_ID = "PN6pbOQwqH";

const ALLOWED_ORIGIN = "https://8aardav8.github.io";

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
async function findOrNextLoginsRow(accessToken, email) {
  const range = encodeURIComponent(`${LOGINS_TAB}!A:B`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`logins read failed: ${await res.text()}`);
  const data = await res.json();
  const col = data.values || [];
  const target = email.trim().toLowerCase();
  for (let i = 1; i < col.length; i++) {
    if ((col[i][1] || "").trim().toLowerCase() === target) return { row: i + 1, isNew: false }; // 1-indexed sheet row
  }
  return { row: col.length + 1, isNew: true };
}

// Writes the full A:G span for a gate-login event. For a brand-new visitor
// this fills First Login through Last Login (columns A-G); for a returning
// visitor (isNew: false) this only touches Last Login (G) -- First Login/
// Email/Agreed/Phone/Name/ID Link must never be silently overwritten by a
// repeat gate pass, same non-destructive stance already used by
// /sync-visitor. Explicit-row values.update, not :append -- see the real
// auto-detection bug this avoided, documented in git history for this file
// (values:append landed a real submission's data starting at column O
// instead of A, on a row far past the real last row).
async function writeLoginsRow(accessToken, { row, isNew }, { name, email, phone, agreed }) {
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
    const range = encodeURIComponent(`${LOGINS_TAB}!G${row}:G${row}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: `${LOGINS_TAB}!G${row}:G${row}`, values: [[nowIso]] }),
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
// Only ever called for a genuinely NEW visitor now (see handleGateLogin's
// call site below) -- no isNew parameter/branch needed here anymore, since
// a "returning visitor" message could never actually fire.
async function pushTelegramPing(env, name, email, phone, quoResult) {
  if (!env.TELEGRAM_BOT_TOKEN) return; // secret not set yet -- just skip
  const lines = [`New site visitor — ${name}, ${email}, ${phone}.`];
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
    await writeLoginsRow(accessToken, target, { name, email, phone, agreed });
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
  if (target.isNew) {
    await pushTelegramPing(env, name, email, phone, quoResult);
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

export default {
  async fetch(request, env) {
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

    if (request.method === "GET") {
      const listingId = url.searchParams.get("id");
      if (!listingId) return jsonResponse({ error: "missing id" }, 400);
      return handleAdminLookup(request, env, listingId);
    }

    return jsonResponse({ error: "not found" }, 404);
  },
};


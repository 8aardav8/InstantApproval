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
//    IMPORTANT, changed 2026-08-28 per Aaron's direct instruction: this
//    Worker does NOT write to the Filling Sheet at all anymore, even though
//    the service account now has Editor there. Aaron's ask was explicit --
//    "only allow editing in the App Logins tab for now, with Telegram
//    check-in before editing, including proposed changes." So instead of
//    writing directly, this creates an Approval Request Task in the Agent
//    System Database (the same Sheet/mechanism already used for every other
//    propose-then-approve flow in this whole project -- see CLAUDE.md's
//    Behavior-Change Request Loop / Dropbox execute-on-approval sections).
//    Nathan picks up the open Approval Request, checks in with Aaron on
//    Telegram showing the exact proposed row, and only appends it to the
//    Filling Sheet's "App: Logins" tab once Aaron approves. Nathan's own
//    standing instructions are the enforcement boundary for "App: Logins
//    only" -- this Worker never touches the Filling Sheet's write path.
//    The visitor's own gate still closes immediately on submit either way
//    (see app.js) -- they are never made to wait on Aaron's approval.
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
//   4. REAL PREREQUISITE for job 2 specifically, not yet done as of this
//      write: the Filling Sheet must share Editor access (not just Viewer)
//      with the service account's email -- job 1 only ever needed
//      spreadsheets.readonly, but appending a row needs write. Until this
//      is granted, /gate-login will fail cleanly with a caught error
//      (visitor sees "something went wrong, call/text us instead"), not a
//      silent failure.
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
//                                 Telegram wiring. Aaron's reply lands in
//                                 the same chat exactly as any other
//                                 message and reaches Nathan normally.

const AARON_EMAIL = "Ate7010@gmail.com";
const OAUTH_CLIENT_ID = "74546128016-r0b13a553shc79gae1hf8r42nkd47t3i.apps.googleusercontent.com";

// Aaron's own Telegram chat ID (the bot's one paired/owner chat) -- not a
// secret in the same sense as the bot token, just a "send to" address, so
// it's a plain constant here rather than a Worker secret.
const AARON_TELEGRAM_CHAT_ID = "5752904645";

const SHEET_ID = "1qDdTcKg2-myJVZkazVOneAAjMlFlMaGKKXlRK518WMk";
const SHEET_TAB = "PROPERTIES";

// Agent System Database -- a DIFFERENT spreadsheet from the Filling Sheet
// above, where the /gate-login route writes an Approval Request Task
// instead of touching the Filling Sheet directly (see the big comment
// block up top). Same service account, already has Editor here -- this is
// its home Sheet, no new grant needed.
const AGENT_DB_SHEET_ID = "1iFhl222SMp9S2tBuFzroLJWK7z5KU21kpjKbtjU3RJo";
const TASKS_TAB = "Tasks";

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

// ---------- job 2: create an Approval Request Task, not a direct write ----------
// Reads the current Task ID column fresh on every call (rather than trusting
// a cached max) to minimize -- not eliminate -- collision risk between two
// near-simultaneous submissions, matching this project's own standing rule
// ("always read the live sheet's current max ID before writing a new
// sequential one"). A rare collision here just means two Tasks share an ID,
// not a data-loss risk, so this lightweight approach is enough for a
// low-volume lead-capture form -- no locking mechanism built.
async function nextTaskId(accessToken) {
  const range = encodeURIComponent(`${TASKS_TAB}!A:A`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${AGENT_DB_SHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`task-id read failed: ${await res.text()}`);
  const data = await res.json();
  const col = data.values || [];
  let max = 0;
  for (const [cell] of col) {
    const m = /^(?:TASK|EVENT)-(\d+)$/.exec((cell || "").trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `TASK-${String(max + 1).padStart(6, "0")}`;
}

async function createGateLoginApprovalTask(accessToken, email, phone, agreed) {
  const taskId = await nextTaskId(accessToken);
  const now = new Date();
  const proposedRow = [now.toISOString(), email, phone, agreed ? "TRUE" : "FALSE"];

  // 32 columns, in the exact live Tasks-tab header order (confirmed
  // 2026-08-28, not assumed) -- Task ID, Task Type, Title/Description,
  // Status, Priority, Assignee, Requested By, Linked Project ID, Linked
  // Asset ID, Linked Network ID, Due Date, Created Date, Completed Date,
  // Dropbox Link, Notes/Flags, then 17 TickTick/Calendar-sync columns left
  // blank (not applicable to this Task).
  const row = [
    taskId,
    "Approval Request",
    "New site visitor — approve adding to App: Logins", // fixed, neutral -- not a paraphrase, matches the Behavior-Change Request Loop convention
    "Open",
    "Medium",
    "Nathan",
    "Site (gate-login)",
    "", "", "", // Linked Project/Asset/Network ID
    "", // Due Date
    now.toISOString().slice(0, 10), // Created Date
    "", // Completed Date
    "", // Dropbox Link
    `Proposed row for Filling Sheet "App: Logins" tab (A:D): ` +
      `Time=${proposedRow[0]}, Email=${proposedRow[1]}, Phone=${proposedRow[2]}, Agreed=${proposedRow[3]}. ` +
      `Check in with Aaron on Telegram before writing -- do not append until he approves.`,
  ];

  const range = encodeURIComponent(`${TASKS_TAB}!A:O`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${AGENT_DB_SHEET_ID}/values/${range}:append?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`approval-task append failed: ${await res.text()}`);
  return taskId;
}

// Very simple, deliberately non-strict validation -- this is a lead-capture
// gate, not a KYC form. Just enough to reject obvious garbage/empty submits.
function isPlausibleEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function isPlausiblePhone(v) { return (v || "").replace(/\D/g, "").length >= 10; }

// Immediate check-in (2026-08-28) -- a plain, one-way push via Telegram's
// own sendMessage API, independent of Nathan/NanoClaw entirely. Best-effort:
// if this fails (bad token, Telegram hiccup), the Approval Request Task
// still exists and Nathan will still surface it on its own normal Approvals
// check -- a failed push here is a lost "instant" nicety, not a lost
// approval, so this never throws back to the caller.
async function pushTelegramCheckIn(env, taskId, email, phone) {
  if (!env.TELEGRAM_BOT_TOKEN) return; // secret not set yet -- just skip
  const text =
    `New site visitor wants in — email ${email}, phone ${phone}.\n` +
    `OK to add to App: Logins? Reply to approve or reject.`;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: AARON_TELEGRAM_CHAT_ID, text }),
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
  const email = (body.email || "").trim();
  const phone = (body.phone || "").trim();
  const agreed = !!body.agreed;

  if (!isPlausibleEmail(email)) return jsonResponse({ error: "invalid email" }, 400);
  if (!isPlausiblePhone(phone)) return jsonResponse({ error: "invalid phone" }, 400);

  try {
    const accessToken = await getSheetsAccessToken(env);
    const taskId = await createGateLoginApprovalTask(accessToken, email, phone, agreed);
    await pushTelegramCheckIn(env, taskId, email, phone);
    return jsonResponse({ ok: true, taskId });
  } catch (e) {
    return jsonResponse({ error: "server error", detail: String(e) }, 500);
  }
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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname === "/gate-login" && request.method === "POST") {
      return handleGateLogin(request, env);
    }

    if (request.method === "GET") {
      const listingId = url.searchParams.get("id");
      if (!listingId) return jsonResponse({ error: "missing id" }, 400);
      return handleAdminLookup(request, env, listingId);
    }

    return jsonResponse({ error: "not found" }, 404);
  },
};

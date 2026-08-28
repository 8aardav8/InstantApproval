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
//    app.js) plus basic field validation here. Appends one row
//    (Time/Email/Phone/Agreed) to the Filling Sheet's "App: Logins" tab --
//    the same tab/shape the current Glide app already writes into.
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

const AARON_EMAIL = "Ate7010@gmail.com";
const OAUTH_CLIENT_ID = "74546128016-r0b13a553shc79gae1hf8r42nkd47t3i.apps.googleusercontent.com";

const SHEET_ID = "1qDdTcKg2-myJVZkazVOneAAjMlFlMaGKKXlRK518WMk";
const SHEET_TAB = "PROPERTIES";
const LOGINS_TAB = "App: Logins";

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

// ---------- job 2: append a row to App: Logins ----------
async function appendLoginRow(accessToken, email, phone, agreed) {
  const range = encodeURIComponent(`${LOGINS_TAB}!A:D`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=RAW`;
  const row = [new Date().toISOString(), email, phone, agreed ? "TRUE" : "FALSE"];
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`sheets append failed: ${await res.text()}`);
}

// Very simple, deliberately non-strict validation -- this is a lead-capture
// gate, not a KYC form. Just enough to reject obvious garbage/empty submits.
function isPlausibleEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function isPlausiblePhone(v) { return (v || "").replace(/\D/g, "").length >= 10; }

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
    await appendLoginRow(accessToken, email, phone, agreed);
    return jsonResponse({ ok: true });
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

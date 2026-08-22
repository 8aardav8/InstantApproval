// Instant-Approval Home Financing -- Admin API (Cloudflare Worker)
//
// Returns the 5 admin-only fields (Total Price, Additional Notes, Lock box,
// Seller name and link, direct Sheet-row link) for one listing, ONLY after
// verifying the caller is Aaron himself via a Google Sign-In ID token.
// Never bundled into the public properties.json, never cached, read live
// from the Sheet on every request using the same service-account credential
// already used by generate_properties.py.
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

const AARON_EMAIL = "Notactuallyit@yahoo.com";
const OAUTH_CLIENT_ID = "74546128016-r0b13a553shc79gae1hf8r42nkd47t3i.apps.googleusercontent.com";

const SHEET_ID = "1qDdTcKg2-myJVZkazVOneAAjMlFlMaGKKXlRK518WMk";
const SHEET_TAB = "PROPERTIES";
const SHEET_TAB_GID = "1440969658"; // confirmed live, for the direct row link

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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ---------- verify the caller is really Aaron ----------
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
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const listingId = url.searchParams.get("id");
    if (!listingId) return jsonResponse({ error: "missing id" }, 400);

    const authHeader = request.headers.get("Authorization") || "";
    const idToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!idToken) return jsonResponse({ error: "not authenticated" }, 401);

    const verified = await verifyIdToken(idToken);
    if (!verified.ok) return jsonResponse({ error: "not authorized", reason: verified.reason }, 403);

    try {
      const accessToken = await getSheetsAccessToken(env);
      const rows = await fetchSheetRows(accessToken);
      const headers = rows[0] || [];
      const col = (name) => headers.indexOf(name);
      const addressCol = col("Address");
      const totalPriceCol = col("Total Price");
      const notesCol = col("Additional Notes");
      const lockboxCol = col("Lock box "); // real header has a trailing space
      const sellerCol = col("Seller name and link");

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const address = row[addressCol] || "";
        if (!address || slugify(address) !== listingId) continue;

        const rowNum = i + 1; // 1-indexed, +1 for the header row already skipped
        return jsonResponse({
          totalPrice: row[totalPriceCol] || "",
          additionalNotes: row[notesCol] || "",
          lockbox: row[lockboxCol] || "",
          sellerNameAndLink: row[sellerCol] || "",
          sheetRowLink: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${SHEET_TAB_GID}&range=A${rowNum}`,
        });
      }
      return jsonResponse({ error: "listing not found" }, 404);
    } catch (e) {
      return jsonResponse({ error: "server error", detail: String(e) }, 500);
    }
  },
};

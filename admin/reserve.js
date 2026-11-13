// ---------- "Reserve this home": Square deposit invoices (2026-11-13) ----------
// Aaron: "a button on each property page if it's available that allows the
// person to reserve that property by paying a 50% nonrefundable deposit,
// which would equal half of the down payment ... synced up with my square
// account." Design decisions and Aaron's words: instant-approval-homes/
// SESSION_LOG.md, 2026-11-13. Terms text: docs/reserve-deposit-terms.md in
// the OS folder (tests/reserve-test.mjs checks this file against it).
//
// Core purpose (RULE-000072): a buyer who has toured a home can ask for a
// deposit invoice for exactly 50% of that home's CURRENT down payment, and
// Aaron hears about it. Everything after the invoice exists (photo
// attachment, Sheet log, Telegram) is best-effort and never blocks it; a
// failure there is reported, not swallowed.
//
// Sheet access is by tab gid + column developer metadata (RULE-000155),
// never tab names, header text or letters. Tags created 2026-11-13.
//
// Config (all Worker secrets, so a deploy never resets them):
//   SQUARE_TOKEN                  access token for SQUARE_ENV
//   SQUARE_ENV                    "sandbox" (default) or "production"
//   SQUARE_LOCATION_ID            location for invoices
//   SQUARE_WEBHOOK_SIGNATURE_KEY  from the webhook subscription
//   RESERVE_PUBLIC                "true" shows the button to buyers; anything
//                                 else = Aaron (admin sign-in) only
//   RESERVE_AUTO_SEND             "true" emails the invoice at once; anything
//                                 else leaves a draft for Aaron to send

export const RESERVE_GIDS = { props: 1440969658, logins: 5432432, deposits: 420385263 };
const SQUARE_VERSION = "2025-01-23";
const SQUARE_HOSTS = { sandbox: "https://connect.squareupsandbox.com", production: "https://connect.squareup.com" };
// Same public, referrer-restricted key the site uses for its photos (app.js).
const STREETVIEW_KEY = "AIzaSyDopPbLVJJXmv5kj8piuRv0W1tZlSDUBG0";
const SITE_ORIGIN = "https://instantapprovalhomes.com";
export const AARON_PHONE_DISPLAY = "(618) 418-4180";

export const MSG = {
  notToured: `You can reserve a home after you've toured it. If this is a mistake, call us at ${AARON_PHONE_DISPLAY} and we'll fix it.`,
  notAvailable: "This home is no longer available to reserve.",
  noEmail: "We need your email address to send the deposit invoice. Add it under My Info, then try again.",
  needsCall: `We couldn't set up this reservation online. Please call us at ${AARON_PHONE_DISPLAY}.`,
  notOpen: "Online reservations aren't open yet.",
  mustAgree: "Please tick the box to confirm before reserving.",
};

// ---------- pure helpers (tested in tests/reserve-test.mjs) ----------

export function normAddr(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// "$3,000" -> 300000 (cents). Anything unparseable or <= 0 -> null.
export function parseMoneyCents(s) {
  const t = (s || "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(parseFloat(t) * 100);
  return cents > 0 ? cents : null;
}

export function fmtMoney(cents) {
  const whole = cents % 100 === 0;
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

const STATE_AT_END = /\b(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b\.?,?\s*(\d{2},?\d{3}(-\d{4})?)?\s*(,\s*USA)?\s*$/;
const STATE_NAMES = { illinois: "IL", missouri: "MO", virginia: "VA", michigan: "MI", mississippi: "MS", ohio: "OH", alabama: "AL", indiana: "IN", arkansas: "AR", georgia: "GA", louisiana: "LA", "north carolina": "NC", pennsylvania: "PA", iowa: "IA" };

// Area ("IL - Decatur", "Virginia") first, the address as a fallback.
export function listingState(area, address) {
  const a = (area || "").trim();
  const head = a.split(" - ")[0].trim();
  if (/^[A-Z]{2}$/.test(head)) return head;
  if (STATE_NAMES[head.toLowerCase()]) return STATE_NAMES[head.toLowerCase()];
  const m = (address || "").trim().match(STATE_AT_END);
  return m ? m[1] : null;
}

// True if the buyer toured this address: it's in Shown Properties, or an
// appointment cell for it is marked Completed (Aaron 2026-11-13: "tour
// first"; "I meant completed").
export function hasToured(shownCell, appointmentCells, address) {
  const target = normAddr(address);
  if (!target) return false;
  const shown = (shownCell || "").split(" | ").map(normAddr);
  if (shown.includes(target)) return true;
  return (appointmentCells || []).some((cell) => {
    const parts = (cell || "").split(" | ");
    return normAddr(parts[0]) === target && (parts[2] || "").trim() === "Completed";
  });
}

// The agreed text. Keep in step with docs/reserve-deposit-terms.md (OS
// folder); tests/reserve-test.mjs fails if they drift.
export function reserveTerms({ address, downCents, isIL }) {
  const deposit = Math.round(downCents / 2);
  const remaining = downCents - deposit;
  const items = [
    `1. Amount. The reservation deposit is 50% of the down payment listed for this property on the day you request it: ${fmtMoney(deposit)} for ${address}.`,
    `2. Non-refundable. The deposit is non-refundable once paid, except as stated in item 6.`,
  ];
  if (isIL) items.push(`Illinois properties only: the deposit is fully refundable if you ask in writing within 3 business days of paying it. After that it is non-refundable, except as stated in item 6.`);
  items.push(
    `3. What it does. Once your deposit is received, we stop marketing the property and reserve it for you while we send the purchase documents for e-signature.`,
    `4. Credited to your down payment. The deposit counts toward your down payment. The rest of the down payment (${fmtMoney(remaining)}) is paid on the same day the purchase documents are e-signed.`,
    `5. Deadline. You must e-sign and pay the rest of the down payment within 7 days of paying the deposit. If you don't, the reservation ends, the property goes back on the market, and the deposit is kept.`,
    `6. When you get it back. You get a full refund if (a) someone else already paid a deposit on this property before you did, or (b) we are unable to sell you the property.`,
    `7. As-is. All homes are sold as-is.`,
    `8. Who is buying. The deposit applies only to the buyer(s) named on the invoice and only to this property. It can't be moved to a different property.`,
  );
  const checkbox = isIL
    ? "I have inspected this property and I understand the deposit is non-refundable after 3 business days."
    : "I have inspected this property and I understand the deposit is non-refundable.";
  return { deposit, remaining, items, checkbox };
}

// Square invoice settings copied from Aaron's hand-made Earline Betts
// invoice #001288 (2026-11-13): card + Cash App Pay, card on file allowed,
// no tips, "Name - address" title, his message, rest due in 7 days with
// reminders at -6/-3/0/+1/+3 days. Differences he chose: the 50% deposit
// is a real Square deposit due today, and no closing-packet PDF or mention
// of it ("Skip the pdf or any mention of it on the invoice").
export function invoiceDate(daysAhead, now = Date.now()) {
  return new Date(now + daysAhead * 86400e3).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}
export function buildInvoice({ locationId, orderId, customerId, buyer, listing, downCents, terms, now = Date.now() }) {
  const first = (buyer.name || "").trim().split(/\s+/)[0];
  const message = [
    `Hi${first ? " " + first : ""}. Once you've decided to move forward with the purchase, you may pay this entire invoice, or just the 50% deposit. Once payment is received, your home is reserved for you and taken off the market.`,
    "",
    "The final closing packet with the specifics of your deal will be ready the next day after payment.",
    "",
    "Once full down payment is received, we can e-sign your agreement, and the place is yours same day!",
    "",
    `Down payment: ${fmtMoney(downCents)}. Deposit due now (50%): ${fmtMoney(terms.deposit)}. Rest due within 7 days: ${fmtMoney(terms.remaining)}.`,
    `You confirmed: "${terms.checkbox}"`,
    "",
    "Reservation Deposit Terms",
    ...terms.items,
  ].join("\n");
  return {
    location_id: locationId, order_id: orderId, primary_recipient: { customer_id: customerId },
    title: `${buyer.name ? buyer.name + " - " : ""}${listing.address}`.slice(0, 255),
    description: message.slice(0, 65000),
    payment_requests: [
      { request_type: "DEPOSIT", fixed_amount_requested_money: { amount: terms.deposit, currency: "USD" }, due_date: invoiceDate(0, now), tipping_enabled: false },
      { request_type: "BALANCE", due_date: invoiceDate(7, now), tipping_enabled: false,
        reminders: [-6, -3, 0, 1, 3].map((d) => ({ relative_scheduled_days: d, message: "Reminder: the rest of your down payment is due." })) },
    ],
    delivery_method: "EMAIL",
    sale_or_service_date: invoiceDate(0, now),
    store_payment_method_enabled: true,
    accepted_payment_methods: { card: true, cash_app_pay: true, bank_account: false, square_gift_card: false, buy_now_pay_later: false },
  };
}

function colLetter(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// ---------- handlers ----------

export function createReserve(deps) {
  const { SHEET_ID, getSheetsAccessToken, jsonResponse, verifySessionToken, verifyIdToken, slugify, toE164, AARON_TELEGRAM_CHAT_ID } = deps;
  const SHEETS = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

  async function gfetch(token, path, init = {}) {
    const res = await fetch(SHEETS + path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`sheets ${path.slice(0, 60)} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  // Tab titles by gid, and column positions by developer metadata key.
  async function loadLayout(token) {
    const [meta, info] = await Promise.all([
      gfetch(token, "/developerMetadata:search", { method: "POST", body: JSON.stringify({ dataFilters: [{ developerMetadataLookup: { locationType: "COLUMN" } }] }) }),
      gfetch(token, "?fields=sheets.properties(sheetId,title)"),
    ]);
    const titles = {};
    for (const s of info.sheets || []) titles[s.properties.sheetId] = s.properties.title;
    const cols = {};
    for (const m of meta.matchedDeveloperMetadata || []) {
      const d = m.developerMetadata;
      if (!d.metadataKey.startsWith("iah.")) continue;
      (cols[d.metadataKey] = cols[d.metadataKey] || []).push({ sheetId: d.location.dimensionRange.sheetId, index: d.location.dimensionRange.startIndex });
    }
    for (const k of Object.keys(cols)) cols[k].sort((a, b) => a.index - b.index);
    const tab = (gid) => {
      if (!titles[gid]) throw new Error(`Sheet tab gid ${gid} not found`);
      return `'${titles[gid].replace(/'/g, "''")}'`;
    };
    const one = (key, gid) => {
      const list = (cols[key] || []).filter((c) => c.sheetId === gid);
      if (list.length !== 1) throw new Error(`column tag ${key} found ${list.length} times`);
      return list[0].index;
    };
    const many = (key, gid) => (cols[key] || []).filter((c) => c.sheetId === gid).map((c) => c.index);
    return { tab, one, many };
  }

  async function readRows(token, tabRef) {
    return (await gfetch(token, `/values/${encodeURIComponent(tabRef)}`)).values || [];
  }

  async function putCell(token, tabRef, row, colIdx, value) {
    const range = `${tabRef}!${colLetter(colIdx)}${row}`;
    await gfetch(token, `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ range, values: [[value]] }) });
  }

  async function telegram(env, text) {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: AARON_TELEGRAM_CHAT_ID, text }),
      });
    } catch (e) { /* best effort */ }
  }

  function squareEnv(env) { return env.SQUARE_ENV === "production" ? "production" : "sandbox"; }

  async function square(env, method, path, body) {
    const res = await fetch(SQUARE_HOSTS[squareEnv(env)] + path, {
      method, headers: { Authorization: `Bearer ${env.SQUARE_TOKEN}`, "Square-Version": SQUARE_VERSION, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`square ${path} ${res.status}: ${JSON.stringify(data.errors || data)}`);
    return data;
  }

  // Who is asking. A buyer's signed session is the identity. Aaron's admin
  // sign-in may act for a buyer (body.phone) when he has no session.
  async function identify(request, env, body) {
    const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const isAdmin = !!bearer && (await verifyIdToken(bearer)).ok;
    let phone = await verifySessionToken(env, request.headers.get("X-IAH-Session"));
    // Aaron testing as a buyer (his own session is used when he leaves it blank).
    if (isAdmin && body.phone) phone = toE164(body.phone);
    return { isAdmin, phone };
  }

  // Everything the decision needs, read fresh from the Sheet.
  async function evaluate(token, layout, phone, listingId) {
    const L = RESERVE_GIDS.logins, P = RESERVE_GIDS.props;
    const props = await readRows(token, layout.tab(P));
    const ci = { status: layout.one("iah.prop.status", P), address: layout.one("iah.prop.address", P), area: layout.one("iah.prop.area", P), down: layout.one("iah.prop.down", P), rowId: layout.one("iah.prop.rowid", P) };
    let listing = null;
    for (let i = 1; i < props.length; i++) {
      const r = props[i];
      const addr = (r[ci.address] || "").trim();
      if (addr && slugify(addr) === listingId) { listing = { row: i + 1, address: addr, status: (r[ci.status] || "").trim(), area: r[ci.area] || "", down: r[ci.down] || "", rowId: r[ci.rowId] || "" }; break; }
    }
    if (!listing) return { ok: false, code: "no-listing", message: MSG.notAvailable };
    if (listing.status.toLowerCase().replace(/[\s-]/g, "") !== "available") return { ok: false, code: "not-available", message: MSG.notAvailable, listing };

    const logins = await readRows(token, layout.tab(L));
    const phoneIdx = layout.one("iah.login.phone", L);
    let rowNum = null, row = null;
    for (let i = 1; i < logins.length; i++) {
      if (toE164((logins[i][phoneIdx] || "").trim()) === phone) { rowNum = i + 1; row = logins[i]; break; }
    }
    if (!row) return { ok: false, code: "no-buyer", message: MSG.notToured, listing };
    const buyer = {
      row: rowNum, phone,
      name: (row[layout.one("iah.login.name", L)] || "").trim(),
      email: (row[layout.one("iah.login.email", L)] || "").trim(),
    };
    const appts = layout.many("iah.login.appointment", L).map((i) => row[i] || "");
    if (!hasToured(row[layout.one("iah.login.shown", L)], appts, listing.address)) return { ok: false, code: "not-toured", message: MSG.notToured, listing, buyer };

    const downCents = parseMoneyCents(listing.down);
    const state = listingState(listing.area, listing.address);
    if (!downCents || !state) return { ok: false, code: !downCents ? "no-down" : "no-state", message: MSG.needsCall, listing, buyer };
    if (!/^\S+@\S+\.\S+$/.test(buyer.email)) return { ok: false, code: "no-email", message: MSG.noEmail, listing, buyer };
    const isIL = state === "IL";
    return { ok: true, listing, buyer, downCents, state, isIL, terms: reserveTerms({ address: listing.address, downCents, isIL }) };
  }

  async function readBody(request) {
    try { return await request.json(); } catch (e) { return {}; }
  }

  // GET /reserve-status -- lets the page decide whether to show the button.
  async function handleStatus(request, env) {
    return jsonResponse({ public: env.RESERVE_PUBLIC === "true", env: squareEnv(env) });
  }

  // POST /reserve-check {listingId} -- eligibility + the exact terms to show.
  async function handleCheck(request, env) {
    const body = await readBody(request);
    const who = await identify(request, env, body);
    if (!who.phone) return jsonResponse({ error: "session required", message: "Please sign in again." }, 401);
    if (env.RESERVE_PUBLIC !== "true" && !who.isAdmin) return jsonResponse({ ok: false, message: MSG.notOpen }, 403);
    try {
      const token = await getSheetsAccessToken(env);
      const r = await evaluate(token, await loadLayout(token), who.phone, String(body.listingId || ""));
      if (!r.ok) return jsonResponse({ ok: false, code: r.code, message: r.message });
      return jsonResponse({ ok: true, address: r.listing.address, down: fmtMoney(r.downCents), deposit: fmtMoney(r.terms.deposit), remaining: fmtMoney(r.terms.remaining), isIL: r.isIL, terms: r.terms.items, checkbox: r.terms.checkbox });
    } catch (e) {
      return jsonResponse({ ok: false, message: MSG.needsCall, detail: String(e) }, 500);
    }
  }

  // POST /reserve-request {listingId, inspected: true}
  async function handleRequest(request, env) {
    const body = await readBody(request);
    const who = await identify(request, env, body);
    if (!who.phone) return jsonResponse({ error: "session required", message: "Please sign in again." }, 401);
    if (env.RESERVE_PUBLIC !== "true" && !who.isAdmin) return jsonResponse({ ok: false, message: MSG.notOpen }, 403);
    if (body.inspected !== true) return jsonResponse({ ok: false, message: MSG.mustAgree }, 400);
    if (!env.SQUARE_TOKEN || !env.SQUARE_LOCATION_ID) return jsonResponse({ ok: false, message: MSG.needsCall, detail: "square not configured" }, 500);

    let token, layout, r;
    try {
      token = await getSheetsAccessToken(env);
      layout = await loadLayout(token);
      r = await evaluate(token, layout, who.phone, String(body.listingId || ""));
    } catch (e) {
      return jsonResponse({ ok: false, message: MSG.needsCall, detail: String(e) }, 500);
    }
    if (!r.ok) {
      if (r.code === "not-toured" || r.code === "no-buyer") await telegram(env, `🏠 Reserve refused (not toured): ${r.buyer ? r.buyer.name : "unknown buyer"} ${who.phone} tried ${r.listing ? r.listing.address : body.listingId}. They were told to call if it's a mistake.`);
      return jsonResponse({ ok: false, code: r.code, message: r.message });
    }

    const D = RESERVE_GIDS.deposits;
    const dep = {
      requestedAt: layout.one("iah.dep.requestedAt", D), invoiceId: layout.one("iah.dep.invoiceId", D), status: layout.one("iah.dep.status", D),
      env: layout.one("iah.dep.env", D), phone: layout.one("iah.dep.phone", D), name: layout.one("iah.dep.name", D), email: layout.one("iah.dep.email", D),
      address: layout.one("iah.dep.address", D), propRowId: layout.one("iah.dep.propRowId", D), state: layout.one("iah.dep.state", D),
      down: layout.one("iah.dep.down", D), deposit: layout.one("iah.dep.deposit", D), paidAt: layout.one("iah.dep.paidAt", D),
      amountPaid: layout.one("iah.dep.amountPaid", D), note: layout.one("iah.dep.note", D),
    };
    const depRows = await readRows(token, layout.tab(D));
    const envName = squareEnv(env);
    // One open invoice per buyer per home: a second click returns the first.
    const open = depRows.slice(1).find((x) => x[dep.phone] === who.phone && normAddr(x[dep.address]) === normAddr(r.listing.address) && x[dep.env] === envName && /^(Draft|Sent)$/.test(x[dep.status] || ""));
    if (open) return jsonResponse({ ok: true, already: true, message: autoSend(env) ? "Your deposit invoice was already sent. Check your email." : "We already have your reservation request. Your deposit invoice will be emailed to you shortly." });

    // --- core: the Square invoice ---
    let invoice;
    try {
      const customerId = await findOrCreateCustomer(env, r.buyer);
      const order = await square(env, "POST", "/v2/orders", {
        idempotency_key: crypto.randomUUID(),
        order: { location_id: env.SQUARE_LOCATION_ID, customer_id: customerId, reference_id: (r.listing.rowId || "").slice(0, 40),
          line_items: [{ name: `Down payment: ${r.listing.address}`.slice(0, 512), quantity: "1", base_price_money: { amount: r.downCents, currency: "USD" } }] },
      });
      invoice = (await square(env, "POST", "/v2/invoices", {
        idempotency_key: crypto.randomUUID(),
        invoice: buildInvoice({ locationId: env.SQUARE_LOCATION_ID, orderId: order.order.id, customerId, buyer: r.buyer, listing: r.listing, downCents: r.downCents, terms: r.terms }),
      })).invoice;
    } catch (e) {
      await telegram(env, `⚠️ Reserve request FAILED at Square: ${r.buyer.name} ${who.phone}, ${r.listing.address}, deposit ${fmtMoney(r.terms.deposit)}.\n${String(e).slice(0, 500)}`);
      return jsonResponse({ ok: false, message: MSG.needsCall, detail: String(e) }, 502);
    }

    // --- best effort from here on: each failure is reported, none undoes the invoice ---
    const problems = [];
    try { await attachStreetView(env, invoice.id, r.listing.address); } catch (e) { problems.push(`photo: ${String(e).slice(0, 200)}`); }
    let status = "Draft", publicUrl = "";
    if (autoSend(env)) {
      try {
        const cur = (await square(env, "GET", `/v2/invoices/${invoice.id}`)).invoice;
        const pub = (await square(env, "POST", `/v2/invoices/${invoice.id}/publish`, { idempotency_key: crypto.randomUUID(), version: cur.version })).invoice;
        status = "Sent"; publicUrl = pub.public_url || "";
      } catch (e) { problems.push(`send: ${String(e).slice(0, 200)}`); }
    }
    try {
      const rowVals = [];
      const set = (k, v) => { rowVals[dep[k]] = v; };
      set("requestedAt", new Date().toISOString()); set("invoiceId", invoice.id); set("status", status); set("env", envName);
      set("phone", who.phone); set("name", r.buyer.name); set("email", r.buyer.email); set("address", r.listing.address);
      set("propRowId", r.listing.rowId); set("state", r.state); set("down", fmtMoney(r.downCents)); set("deposit", fmtMoney(r.terms.deposit));
      set("paidAt", ""); set("amountPaid", ""); set("note", problems.join("; "));
      for (let i = 0; i < rowVals.length; i++) if (rowVals[i] === undefined) rowVals[i] = "";
      await appendRow(token, layout.tab(D), depRows.length, rowVals, dep.invoiceId, invoice.id);
    } catch (e) { problems.push(`sheet log: ${String(e).slice(0, 200)}`); }

    const where = envName === "production" ? "" : " [SANDBOX TEST]";
    await telegram(env, [
      `🏠 Reservation request${where}: ${r.buyer.name || "(no name)"} ${who.phone}`,
      `${r.listing.address}${r.isIL ? " (IL: refundable 3 business days)" : ""}`,
      `Down ${fmtMoney(r.downCents)} → deposit ${fmtMoney(r.terms.deposit)}`,
      status === "Sent" ? `Invoice emailed to ${r.buyer.email}. ${publicUrl}` : `Draft invoice ready. Review and send it in Square: Invoices → Drafts.`,
      problems.length ? `⚠️ Not done: ${problems.join("; ")}` : "",
    ].filter(Boolean).join("\n"));

    return jsonResponse({ ok: true, message: status === "Sent"
      ? `Your invoice was emailed to ${r.buyer.email}. Pay the ${fmtMoney(r.terms.deposit)} deposit (or the full ${fmtMoney(r.downCents)}) to reserve this home.`
      : `Reservation request received. Your invoice will be emailed to ${r.buyer.email} shortly. Paying the ${fmtMoney(r.terms.deposit)} deposit reserves this home.` });
  }

  function autoSend(env) { return env.RESERVE_AUTO_SEND === "true"; }

  async function findOrCreateCustomer(env, buyer) {
    const found = await square(env, "POST", "/v2/customers/search", { query: { filter: { phone_number: { exact: buyer.phone } } }, limit: 1 });
    if (found.customers && found.customers.length) {
      const c = found.customers[0];
      if (!c.email_address && buyer.email) await square(env, "PUT", `/v2/customers/${c.id}`, { email_address: buyer.email });
      return c.id;
    }
    const [given, ...rest] = (buyer.name || "Buyer").split(/\s+/);
    return (await square(env, "POST", "/v2/customers", {
      idempotency_key: crypto.randomUUID(), given_name: given, family_name: rest.join(" ") || undefined,
      email_address: buyer.email, phone_number: buyer.phone,
    })).customer.id;
  }

  // The same Street View picture the property page shows (Aaron chose "the
  // listing's main photo").
  async function attachStreetView(env, invoiceId, address) {
    const img = await fetch(`https://maps.googleapis.com/maps/api/streetview?size=800x500&fov=50&location=${encodeURIComponent(address)}&key=${STREETVIEW_KEY}`, { headers: { Referer: `${SITE_ORIGIN}/` } });
    const type = img.headers.get("Content-Type") || "";
    if (!img.ok || !type.startsWith("image/")) throw new Error(`street view ${img.status} ${type}`);
    const fd = new FormData();
    fd.append("request", JSON.stringify({ idempotency_key: crypto.randomUUID(), description: "Property photo" }));
    fd.append("image_file", new Blob([await img.arrayBuffer()], { type: type.split(";")[0] }), "property.jpg");
    const res = await fetch(`${SQUARE_HOSTS[squareEnv(env)]}/v2/invoices/${invoiceId}/attachments`, {
      method: "POST", headers: { Authorization: `Bearer ${env.SQUARE_TOKEN}`, "Square-Version": SQUARE_VERSION }, body: fd,
    });
    if (!res.ok) throw new Error(`attachment ${res.status} ${await res.text()}`);
  }

  // Writes below the last row seen, then reads it back (lessons: never
  // trust an append's landing spot). If someone else took that row in the
  // meantime, tries the next one.
  async function appendRow(token, tabRef, rowsSeen, values, keyIdx, keyValue) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = rowsSeen + 1 + attempt;
      const range = `${tabRef}!A${row}:${colLetter(values.length - 1)}${row}`;
      const existing = (await gfetch(token, `/values/${encodeURIComponent(range)}`)).values;
      if (existing && existing.length && existing[0].some((v) => v)) continue;
      await gfetch(token, `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ range, values: [values] }) });
      const back = ((await gfetch(token, `/values/${encodeURIComponent(range)}`)).values || [[]])[0] || [];
      if (back[keyIdx] === keyValue) return row;
      throw new Error(`read-back mismatch on row ${row}`);
    }
    throw new Error("no free row found");
  }

  // ---------- Square webhook: invoice.payment_made ----------
  async function verifySquareSignature(env, request, raw) {
    const sig = request.headers.get("x-square-hmacsha256-signature") || "";
    if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY || !sig) return false;
    const u = new URL(request.url);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SQUARE_WEBHOOK_SIGNATURE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(u.origin + u.pathname + raw)));
    let s = ""; for (const b of mac) s += String.fromCharCode(b);
    const want = btoa(s);
    if (want.length !== sig.length) return false;
    let diff = 0; for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
  }

  async function handleWebhook(request, env) {
    const raw = await request.text();
    if (!(await verifySquareSignature(env, request, raw))) return jsonResponse({ error: "bad signature" }, 401);
    let evt; try { evt = JSON.parse(raw); } catch (e) { return jsonResponse({ error: "bad json" }, 400); }
    if (evt.type !== "invoice.payment_made") return jsonResponse({ ok: true, ignored: evt.type });
    const inv = (((evt.data || {}).object) || {}).invoice || {};
    if (!inv.id) return jsonResponse({ ok: true, ignored: "no invoice" });
    try {
      const msg = await recordPayment(env, inv);
      if (msg) await telegram(env, msg);
      return jsonResponse({ ok: true });
    } catch (e) {
      await telegram(env, `⚠️ Square deposit paid but the Sheet update FAILED (invoice ${inv.id}). Check Square and the Square Deposits tab.\n${String(e).slice(0, 400)}`);
      return jsonResponse({ error: "server error", detail: String(e) }, 500); // Square retries
    }
  }

  // Returns the Telegram text, or "" for a repeat delivery.
  async function recordPayment(env, inv) {
    const token = await getSheetsAccessToken(env);
    const layout = await loadLayout(token);
    const D = RESERVE_GIDS.deposits, P = RESERVE_GIDS.props, L = RESERVE_GIDS.logins;
    const c = (k) => layout.one(k, D);
    const rows = await readRows(token, layout.tab(D));
    const i = rows.findIndex((x, n) => n > 0 && x[c("iah.dep.invoiceId")] === inv.id);
    if (i < 0) return `💰 Square invoice ${inv.id} was paid, but it isn't in the Square Deposits tab (not made by the Reserve button?). Nothing changed.`;
    const rec = rows[i], sheetRow = i + 1;
    // The invoice is the full down payment with 50% due now (Aaron
    // 2026-11-13, "Full down, 50% due now"). Paying the deposit reserves
    // the home; paying the rest only updates the log. Square sends one
    // event per payment, possibly more than once.
    const prev = rec[c("iah.dep.status")] || "";
    if (prev === "Paid in full") return ""; // already handled
    const paidCents = (inv.payment_requests || []).reduce((sum, q) => sum + (((q.total_completed_amount_money || {}).amount) || 0), 0);
    const fullyPaid = inv.status === "PAID";
    const depositCents = parseMoneyCents(rec[c("iah.dep.deposit")]) || Infinity;
    const reservedNow = fullyPaid || paidCents >= depositCents;
    const next = fullyPaid ? "Paid in full" : reservedNow ? "Deposit paid" : "Partly paid";
    if (next === prev && fmtMoney(paidCents) === rec[c("iah.dep.amountPaid")]) return ""; // repeat delivery
    const tab = layout.tab(D);
    await putCell(token, tab, sheetRow, c("iah.dep.status"), next);
    await putCell(token, tab, sheetRow, c("iah.dep.paidAt"), new Date().toISOString());
    await putCell(token, tab, sheetRow, c("iah.dep.amountPaid"), fmtMoney(paidCents));
    const who = `${rec[c("iah.dep.name")] || "(no name)"} ${rec[c("iah.dep.phone")]}`;
    const address = rec[c("iah.dep.address")];
    const flagged = /^Second payer/.test(rec[c("iah.dep.note")] || "");
    if (!reservedNow) return `💰 Partial payment, below the deposit: ${who}, ${address}, ${fmtMoney(paidCents)} of ${fmtMoney(depositCents)}. Not reserved yet; nothing else changed.`;
    if (prev === "Deposit paid") {
      if (flagged) return `⚠️ ${who} paid MORE on ${address} (${fmtMoney(paidCents)} total), but they were the second payer. Refund all of it in Square.`;
      return fullyPaid ? `💰 PAID IN FULL: ${who}, ${address}, ${fmtMoney(paidCents)}. Set their Stage to Full Down Received when the paperwork is ready.` : `💰 More paid: ${who}, ${address}, ${fmtMoney(paidCents)} so far.`;
    }

    // Someone else paid first? (Aaron chose "Allow both"; terms item 6a refunds the second.)
    const otherPaid = rows.some((x, n) => n > 0 && n !== i && /^(Deposit paid|Paid in full)$/.test(x[c("iah.dep.status")] || "") && normAddr(x[c("iah.dep.address")]) === normAddr(address));
    const props = await readRows(token, layout.tab(P));
    const pRowIdx = layout.one("iah.prop.rowid", P), pStatusIdx = layout.one("iah.prop.status", P);
    const rowId = rec[c("iah.dep.propRowId")];
    const pi = rowId ? props.findIndex((x, n) => n > 0 && x[pRowIdx] === rowId) : -1;
    const propStatus = pi > 0 ? (props[pi][pStatusIdx] || "").trim() : "";
    if (otherPaid) {
      await putCell(token, tab, sheetRow, c("iah.dep.note"), "Second payer: refund per terms item 6(a)");
      return `⚠️ SECOND deposit paid on ${address}: ${who}, ${fmtMoney(paidCents)}. Another buyer paid first. Per terms item 6(a), refund this one in Square and cancel the rest of their invoice. Sheet not changed otherwise.`;
    }
    // Fake (sandbox) money never changes the real listing or buyer.
    if (rec[c("iah.dep.env")] !== "production") {
      return `💰 [SANDBOX TEST] Deposit paid: ${who}, ${address}, ${fmtMoney(paidCents)}. Real Sheet NOT changed; live it would set the home to Pending (now "${propStatus || "row not found"}") and the buyer to Deposit Received.`;
    }
    const done = [];
    if (pi > 0 && /^available$/i.test(propStatus.replace(/[\s-]/g, ""))) { await putCell(token, layout.tab(P), pi + 1, pStatusIdx, "Pending"); done.push("property set to Pending"); }
    else done.push(pi > 0 ? `property left as "${propStatus}"` : "property row not found by Row ID, status not changed");
    const logins = await readRows(token, layout.tab(L));
    const phoneIdx = layout.one("iah.login.phone", L);
    const li = logins.findIndex((x, n) => n > 0 && toE164((x[phoneIdx] || "").trim()) === rec[c("iah.dep.phone")]);
    if (li > 0) {
      await putCell(token, layout.tab(L), li + 1, layout.one("iah.login.depositProperty", L), address);
      await putCell(token, layout.tab(L), li + 1, layout.one("iah.login.stage", L), "Deposit Received");
      done.push("buyer Stage → Deposit Received (Trello card follows)");
    } else done.push("buyer row not found, Stage not changed");
    const il = rec[c("iah.dep.state")] === "IL" ? "\nIL home: refundable if they ask in writing within 3 business days." : "";
    const head = fullyPaid ? `💰 PAID IN FULL (deposit + rest)` : `💰 DEPOSIT PAID`;
    return `${head}: ${who}, ${address}, ${fmtMoney(paidCents)}.\n${done.join("; ")}.${fullyPaid ? "" : "\n7-day clock to e-sign and pay the rest starts now."}${il}`;
  }

  // Marking an appointment Completed also records the house as shown, so
  // the proof of a tour survives addAppointment pruning past cells.
  async function addShownOnComplete(env, phone, address) {
    const token = await getSheetsAccessToken(env);
    const layout = await loadLayout(token);
    const L = RESERVE_GIDS.logins;
    const logins = await readRows(token, layout.tab(L));
    const phoneIdx = layout.one("iah.login.phone", L), shownIdx = layout.one("iah.login.shown", L);
    const li = logins.findIndex((x, n) => n > 0 && toE164((x[phoneIdx] || "").trim()) === toE164(phone));
    if (li < 0) throw new Error("buyer row not found");
    const list = (logins[li][shownIdx] || "").split(" | ").map((s) => s.trim()).filter(Boolean);
    if (list.some((a) => normAddr(a) === normAddr(address))) return false;
    await putCell(token, layout.tab(L), li + 1, shownIdx, [...list, address.trim()].join(" | "));
    return true;
  }

  return { handleStatus, handleCheck, handleRequest, handleWebhook, addShownOnComplete };
}

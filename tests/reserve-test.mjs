// "Reserve this home" deposit invoices (admin/reserve.js), 2026-11-13.
// Run: node tests/reserve-test.mjs   (scripts/deploy-worker.sh runs it too)
// Money moves on this path, so every rule Aaron set is checked here against
// fake Sheets/Square/Telegram. Fake data only; unknown hosts throw.
import { generateKeyPairSync, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import worker from '../admin/worker.js';
import { parseMoneyCents, listingState, hasToured, reserveTerms, buildInvoice, invoiceDate, MSG, RESERVE_GIDS } from '../admin/reserve.js';

let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };

// ---------- pure helpers ----------
eq('down "$3,000" -> cents', parseMoneyCents('$3,000'), 300000);
eq('down blank -> null', parseMoneyCents(''), null);
eq('down "TBD" -> null', parseMoneyCents('TBD'), null);
eq('state from Area "IL - Decatur"', listingState('IL - Decatur', ''), 'IL');
eq('state from Area "Virginia"', listingState('Virginia', ''), 'VA');
eq('state from address with odd zip', listingState('', '1012 E Wood Street Decatur IL 62,521'), 'IL');
eq('state from address with no zip', listingState('', '4043 Camellia Ave, Saint Louis, MO'), 'MO');
eq('state from address ending USA', listingState('', '945 W Packard St, Decatur, IL 62522, USA'), 'IL');
eq('no state -> null', listingState('', '1438 N 44th St, E St Louis, 62204'), null);
const A = '12 Fake St Decatur IL 62,521';
eq('toured: in Shown Properties', hasToured(`Other Rd | ${A}`, [], A), true);
eq('toured: Shown match ignores spacing/punctuation', hasToured('12 fake st, decatur il 62521', [], A), true);
eq('toured: Completed appointment', hasToured('', [`${A} | 2026-11-01 | Completed`], A), true);
eq('not toured: scheduled appointment only', hasToured('', [`${A} | 2026-11-20 | `], A), false);
eq('not toured: canceled appointment', hasToured('', [`${A} | 2026-11-01 | Canceled`], A), false);
eq('not toured: a different house', hasToured('Other Rd', [], A), false);
const t = reserveTerms({ address: A, downCents: 300000, isIL: false });
eq('deposit is half the down', [t.deposit, t.remaining], [150000, 150000]);
eq('odd-cent down splits without losing a cent', (({ deposit, remaining }) => deposit + remaining)(reserveTerms({ address: A, downCents: 300001, isIL: false })), 300001);
eq('non-IL terms have no IL line', t.items.some((x) => x.startsWith('Illinois')), false);
const til = reserveTerms({ address: A, downCents: 300000, isIL: true });
eq('IL terms add the 3-business-day line', til.items.some((x) => x.startsWith('Illinois properties only') && x.includes('3 business days')), true);
eq('IL checkbox wording', til.checkbox.endsWith('non-refundable after 3 business days.'), true);

// ---------- terms in code match the approved doc ----------
const DOC = '/Users/aarondavid/Desktop/OS/instant-approval-homes/docs/reserve-deposit-terms.md';
if (existsSync(DOC)) {
  const doc = readFileSync(DOC, 'utf8');
  const clean = (s) => s.replace(/\*\*/g, '').replace(/\s*\(Aaron [^)]*\)\s*$/, '').trim();
  const sub = (s) => s.replace('{{deposit}}', '$1,500').replace('{{address}}', A).replace('{{remaining}}', '$1,500');
  const docItems = doc.split('\n').filter((l) => /^\d\. /.test(l)).map((l) => sub(clean(l)));
  eq('doc numbered items == code items (non-IL)', docItems, t.items);
  const ilLine = doc.split('\n').find((l) => l.includes('Illinois properties only'));
  eq('doc IL line == code IL line', clean(ilLine.replace(/^\s*-\s*/, '')), til.items.find((x) => x.startsWith('Illinois')));
  eq('doc checkbox == code checkbox', doc.includes(`"☐ ${t.checkbox}"`), true);
} else console.log('SKIP terms-doc comparison (OS folder not on this machine)');

// ---------- handler flows against a fake world ----------
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const SRC = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
const OAUTH_CLIENT_ID = SRC.match(/const OAUTH_CLIENT_ID = "([^"]+)"/)[1];
const AARON_EMAIL = SRC.match(/const AARON_EMAIL = "([^"]+)"/)[1];
const baseEnv = { INTERNAL_TOOLS_SECRET: 'fake-secret', GCP_SA_EMAIL: 'f@example.com', GCP_SA_PRIVATE_KEY: PEM, TELEGRAM_BOT_TOKEN: 'fake',
  SQUARE_TOKEN: 'sq-fake', SQUARE_LOCATION_ID: 'LOC1', SQUARE_WEBHOOK_SIGNATURE_KEY: 'whkey', RESERVE_PUBLIC: 'true' };
const PHONE = '+12175550101', PHONE2 = '+12175550102';
const session = (p) => { const pl = Buffer.from(JSON.stringify({ p, exp: Date.now() + 3600e3 })).toString('base64url'); return `${pl}.${createHmac('sha256', 'fake-secret:session-v1').update(pl).digest('base64url')}`; };
const slug = (a) => a.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const P_H = ['Available?', 'X', 'X', 'Address', 'Area', 'Down', 'Row ID'];
// Same positions as the real App: Logins, so the older fixed-letter code (D = phone, O:X = appointments) works in this fake too.
const LI = { email: 1, phone: 3, name: 4, appt: 14, shown: 27, stage: 31, dep: 39 };
const L_H = Array.from({ length: 40 }, (_, i) => `col${i}`);
const D_H = ['Requested At', 'Invoice ID', 'Status', 'Square Env', 'Buyer Phone', 'Buyer Name', 'Buyer Email', 'Property Address', 'Property Row ID', 'State', 'Down', 'Deposit', 'Paid At', 'Amount Paid', 'Note'];
const META = [
  [RESERVE_GIDS.props, 0, 'iah.prop.status'], [RESERVE_GIDS.props, 3, 'iah.prop.address'], [RESERVE_GIDS.props, 4, 'iah.prop.area'], [RESERVE_GIDS.props, 5, 'iah.prop.down'], [RESERVE_GIDS.props, 6, 'iah.prop.rowid'],
  [RESERVE_GIDS.logins, LI.email, 'iah.login.email'], [RESERVE_GIDS.logins, LI.phone, 'iah.login.phone'], [RESERVE_GIDS.logins, LI.name, 'iah.login.name'],
  ...Array.from({ length: 10 }, (_, i) => [RESERVE_GIDS.logins, LI.appt + i, 'iah.login.appointment']),
  [RESERVE_GIDS.logins, LI.shown, 'iah.login.shown'], [RESERVE_GIDS.logins, LI.stage, 'iah.login.stage'], [RESERVE_GIDS.logins, LI.dep, 'iah.login.depositProperty'],
  ...['requestedAt', 'invoiceId', 'status', 'env', 'phone', 'name', 'email', 'address', 'propRowId', 'state', 'down', 'deposit', 'paidAt', 'amountPaid', 'note'].map((k, i) => [RESERVE_GIDS.deposits, i, `iah.dep.${k}`]),
];
const TITLES = { [RESERVE_GIDS.props]: 'PROPERTIES', [RESERVE_GIDS.logins]: 'App: Logins', [RESERVE_GIDS.deposits]: 'Square Deposits' };

function world({ shown = A, appts = [], status = 'Available', down = '$3,000', area = 'IL - Decatur', email = 'pat@example.com' } = {}) {
  const loginRow = (phone, name, sh) => { const r = Array(40).fill(''); Object.assign(r, { [LI.email]: email, [LI.phone]: phone, [LI.name]: name, [LI.shown]: sh, [LI.stage]: 'First Showing Done' }); appts.forEach((a, i) => { r[LI.appt + i] = a; }); return r; };
  const w = {
    tabs: {
      PROPERTIES: [P_H, ['Available', '', '', 'Other Home Rd Decatur IL 62521', 'IL - Decatur', '$2,000', 'ROW-OTHER'], [status, '', '', A, area, down, 'ROW-A']],
      'App: Logins': [L_H, loginRow(PHONE, 'Pat Example', shown), loginRow(PHONE2, 'Sam Second', A)],
      'Square Deposits': [D_H],
    },
    square: [], telegrams: [], invoices: {}, n: 0,
  };
  const grid = (title) => w.tabs[title];
  const colIdx = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const parse = (range) => {
    const m = range.match(/^'?(.*?)'?!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/);
    if (!m) return { title: range.replace(/^'|'$/g, '') };
    const title = m[1].replace(/''/g, "'");
    if (!m[3]) return { title, c1: colIdx(m[2]), c2: colIdx(m[4] || m[2]), r1: 1, r2: grid(title) ? grid(title).length : 0 }; // whole columns, e.g. D:D
    return { title, c1: colIdx(m[2]), r1: +m[3], c2: colIdx(m[4] || m[2]), r2: +(m[5] || m[3]) };
  };
  w.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') return json({ access_token: 'fake' });
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/tokeninfo') return url.searchParams.get('id_token') === 'ADMIN' ? json({ aud: OAUTH_CLIENT_ID, email: AARON_EMAIL, email_verified: 'true' }) : json({}, 400);
    if (url.hostname === 'api.telegram.org') { w.telegrams.push(body.text); return json({ ok: true }); }
    if (url.hostname === 'maps.googleapis.com') return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
    if (url.hostname === 'sheets.googleapis.com') {
      if (url.pathname.endsWith('/developerMetadata:search')) return json({ matchedDeveloperMetadata: META.map(([sheetId, index, key]) => ({ developerMetadata: { metadataKey: key, location: { dimensionRange: { sheetId, startIndex: index, endIndex: index + 1 } } } })) });
      if (url.searchParams.get('fields')) return json({ sheets: Object.entries(TITLES).map(([id, title]) => ({ properties: { sheetId: +id, title } })) });
      const range = decodeURIComponent(url.pathname.split('/values/')[1] || '');
      const p = parse(range); const g = grid(p.title); if (!g) throw new Error('test: unknown tab ' + p.title);
      if (init.method === 'PUT') {
        body.values[0].forEach((v, k) => { const r = p.r1 - 1; while (g.length <= r) g.push([]); g[r][p.c1 + k] = v; });
        return json({});
      }
      if (p.r1 === undefined) return json({ values: g });
      const out = []; for (let r = p.r1; r <= p.r2; r++) out.push((g[r - 1] || []).slice(p.c1, p.c2 + 1));
      return json({ values: out.some((x) => x.length) ? out : undefined });
    }
    if (url.hostname === 'connect.squareupsandbox.com' || url.hostname === 'connect.squareup.com') {
      w.square.push(`${init.method || 'GET'} ${url.pathname}`);
      if (url.pathname === '/v2/customers/search') return json({ customers: [] });
      if (url.pathname === '/v2/customers') return json({ customer: { id: 'CUST1' } });
      if (url.pathname === '/v2/orders') { w.lastOrder = body.order; return json({ order: { id: 'ORD1' } }); }
      if (url.pathname === '/v2/invoices') { const id = `INV${++w.n}`; w.invoices[id] = body.invoice; return json({ invoice: { id, version: 0 } }); }
      if (/\/attachments$/.test(url.pathname)) return json({ attachment: { id: 'ATT' } });
      if (/\/publish$/.test(url.pathname)) return json({ invoice: { id: 'x', status: 'UNPAID', public_url: 'https://pay.example/inv' } });
      if (/^\/v2\/invoices\/[^/]+$/.test(url.pathname)) return json({ invoice: { version: 1 } });
    }
    throw new Error(`test: refused ${url.hostname}${url.pathname}`);
  };
  return w;
}
async function call(w, path, body, { env = baseEnv, phone = PHONE, admin = false, raw, headers = {} } = {}) {
  globalThis.fetch = w.fetch;
  const h = { 'Content-Type': 'application/json', ...headers };
  if (phone) h['X-IAH-Session'] = session(phone);
  if (admin) h.Authorization = 'Bearer ADMIN';
  const res = await worker.fetch(new Request(`https://worker.example.com${path}`, { method: 'POST', headers: h, body: raw ?? JSON.stringify(body) }), env);
  return { status: res.status, data: await res.json() };
}
const LID = slug(A);
const depRow = (w, n = 1) => w.tabs['Square Deposits'][n] || [];

{ const w = world({ shown: '' }); const r = await call(w, '/reserve-request', { listingId: LID, inspected: true });
  eq('not toured: refused with the call-us message', [r.data.ok, r.data.message], [false, MSG.notToured]);
  eq('not toured: Square never called', w.square.length, 0);
  eq('not toured: Aaron told', w.telegrams.some((x) => x.includes('Reserve refused')), true); }
{ const w = world({ shown: '', appts: [`${A} | 2026-11-20 | `] }); const r = await call(w, '/reserve-check', { listingId: LID });
  eq('booked-but-not-toured is refused', r.data.message, MSG.notToured); }
{ const w = world({ shown: '', appts: [`${A} | 2026-11-01 | Completed`] }); const r = await call(w, '/reserve-check', { listingId: LID });
  eq('Completed appointment is enough', r.data.ok, true); }
{ const w = world(); const r = await call(w, '/reserve-check', { listingId: LID });
  eq('check: deposit is half the CURRENT Sheet down', [r.data.ok, r.data.down, r.data.deposit, r.data.isIL], [true, '$3,000', '$1,500', true]);
  eq('check: IL checkbox shown', r.data.checkbox.endsWith('after 3 business days.'), true); }
{ const w = world({ down: '$2,400', area: 'MO - St. Louis' }); const r = await call(w, '/reserve-check', { listingId: LID });
  eq('check: down changed in Sheet -> new amount, non-IL', [r.data.deposit, r.data.isIL, r.data.checkbox.endsWith('non-refundable.')], ['$1,200', false, true]); }
{ const w = world({ status: 'Pending' }); const r = await call(w, '/reserve-request', { listingId: LID, inspected: true });
  eq('Pending home is refused, no Square', [r.data.message, w.square.length], [MSG.notAvailable, 0]); }
{ const w = world({ down: '' }); const r = await call(w, '/reserve-request', { listingId: LID, inspected: true });
  eq('blank down -> call us, no Square', [r.data.message, w.square.length], [MSG.needsCall, 0]); }
{ const w = world({ email: '' }); const r = await call(w, '/reserve-request', { listingId: LID, inspected: true });
  eq('no email -> asked to add it', r.data.message, MSG.noEmail); }
{ const w = world(); const r = await call(w, '/reserve-request', { listingId: LID });
  eq('box not ticked -> refused, no Square', [r.status, w.square.length], [400, 0]); }
{ const w = world(); const r = await call(w, '/reserve-request', { listingId: LID, inspected: true }, { phone: null });
  eq('no session -> 401', r.status, 401); }
{ const w = world(); const r = await call(w, '/reserve-request', { listingId: LID, inspected: true }, { env: { ...baseEnv, RESERVE_PUBLIC: 'false' } });
  eq('not public yet: buyer refused, no Square', [r.status, w.square.length], [403, 0]); }
{ const w = world(); const r = await call(w, '/reserve-check', { listingId: LID, phone: PHONE }, { env: { ...baseEnv, RESERVE_PUBLIC: 'false' }, phone: null, admin: true });
  eq('not public yet: Aaron (admin) can test for a buyer', r.data.ok, true); }

let paidWorld;
{ const w = world(); const r = await call(w, '/reserve-request', { listingId: LID, inspected: true });
  const inv = w.invoices.INV1;
  eq('request: ok', r.data.ok, true);
  eq('request: invoice total is the full down payment', w.lastOrder.line_items[0].base_price_money, { amount: 300000, currency: 'USD' });
  eq('request: 50% deposit due today, rest due in 7 days', [inv.payment_requests[0].request_type, inv.payment_requests[0].fixed_amount_requested_money.amount, inv.payment_requests[0].due_date, inv.payment_requests[1].request_type, inv.payment_requests[1].due_date], ['DEPOSIT', 150000, invoiceDate(0), 'BALANCE', invoiceDate(7)]);
  eq('request: Earline settings (Cash App + card only, card on file, reminders, title)', [inv.accepted_payment_methods, inv.store_payment_method_enabled, inv.payment_requests[1].reminders.map((x) => x.relative_scheduled_days), inv.title], [{ card: true, cash_app_pay: true, bank_account: false, square_gift_card: false, buy_now_pay_later: false }, true, [-6, -3, 0, 1, 3], `Pat Example - ${A}`]);
  eq('request: message is personal and never mentions the PDF', [inv.description.startsWith("Hi Pat. Once you've decided"), /attach|example agreement/i.test(inv.description)], [true, false]);
  eq('request: invoice carries the address and IL terms', [inv.title.includes(A), inv.description.includes('Illinois properties only'), inv.description.includes('3 business days')], [true, true, true]);
  eq('request: draft only (no publish) while auto-send is off', w.square.some((x) => x.endsWith('/publish')), false);
  eq('request: photo attached', w.square.some((x) => x.endsWith('/attachments')), true);
  const d = depRow(w);
  eq('request: logged in Square Deposits', [d[1], d[2], d[3], d[4], d[7], d[8], d[9], d[10], d[11]], ['INV1', 'Draft', 'sandbox', PHONE, A, 'ROW-A', 'IL', '$3,000', '$1,500']);
  eq('request: Aaron told it is a sandbox test', w.telegrams.some((x) => x.includes('Reservation request [SANDBOX TEST]') && x.includes('deposit $1,500')), true);
  const again = await call(w, '/reserve-request', { listingId: LID, inspected: true });
  eq('second click: no second invoice', [again.data.already, Object.keys(w.invoices).length], [true, 1]);
  paidWorld = w; }
{ const w = world(); await call(w, '/reserve-request', { listingId: LID, inspected: true }, { env: { ...baseEnv, RESERVE_AUTO_SEND: 'true' } });
  eq('auto-send on: invoice published, logged Sent', [w.square.some((x) => x.endsWith('/publish')), depRow(w)[2]], [true, 'Sent']); }

// ---------- webhook ----------
const sign = (raw) => createHmac('sha256', 'whkey').update('https://worker.example.com/square-webhook' + raw).digest('base64');
{ // Sandbox money must never touch the real listing or buyer.
  const w = world(); await call(w, '/reserve-request', { listingId: LID, inspected: true });
  const raw = JSON.stringify({ type: 'invoice.payment_made', data: { object: { invoice: { id: 'INV1', status: 'PARTIALLY_PAID', payment_requests: [{ total_completed_amount_money: { amount: 150000 } }] } } } });
  await call(w, '/square-webhook', null, { phone: null, raw, headers: { 'x-square-hmacsha256-signature': createHmac('sha256', 'whkey').update('https://worker.example.com/square-webhook' + raw).digest('base64') } });
  eq('sandbox paid: deposit row Paid, real listing and buyer untouched', [depRow(w)[2], w.tabs.PROPERTIES[2][0], w.tabs['App: Logins'][1][LI.stage]], ['Deposit paid', 'Available', 'First Showing Done']);
  eq('sandbox paid: Aaron told it was a test', w.telegrams.at(-1).startsWith('💰 [SANDBOX TEST]'), true); }
// Square reports each payment request's completed amount; status PARTIALLY_PAID until all is paid.
const payEvt = (id, paid, status) => JSON.stringify({ type: 'invoice.payment_made', data: { object: { invoice: { id, status, payment_requests: [{ request_type: 'DEPOSIT', total_completed_amount_money: { amount: Math.min(paid, 150000) } }, { request_type: 'BALANCE', total_completed_amount_money: { amount: Math.max(0, paid - 150000) } }] } } } });
const paidEvent = (id) => payEvt(id, 150000, 'PARTIALLY_PAID');
{ const w = paidWorld; const raw = paidEvent('INV1');
  w.tabs['Square Deposits'][1][3] = 'production'; // live-money path
  const bad = await call(w, '/square-webhook', null, { phone: null, raw, headers: { 'x-square-hmacsha256-signature': 'nope' } });
  eq('webhook: bad signature refused, nothing written', [bad.status, depRow(w)[2]], [401, 'Draft']);
  const ok = await call(w, '/square-webhook', null, { phone: null, raw, headers: { 'x-square-hmacsha256-signature': sign(raw) } });
  eq('webhook: deposit paid -> row Deposit paid', [ok.status, depRow(w)[2], depRow(w)[13]], [200, 'Deposit paid', '$1,500']);
  eq('webhook: property -> Pending', w.tabs.PROPERTIES[2][0], 'Pending');
  eq('webhook: other property untouched', w.tabs.PROPERTIES[1][0], 'Available');
  eq('webhook: buyer Stage + Deposit Property set', [w.tabs['App: Logins'][1][LI.stage], w.tabs['App: Logins'][1][LI.dep]], ['Deposit Received', A]);
  eq('webhook: Aaron told, with IL note', w.telegrams.some((x) => x.startsWith('💰 DEPOSIT PAID') && x.includes('3 business days')), true);
  const n = w.telegrams.length;
  await call(w, '/square-webhook', null, { phone: null, raw, headers: { 'x-square-hmacsha256-signature': sign(raw) } });
  eq('webhook: repeat delivery changes nothing, no second alert', w.telegrams.length, n);
  const full = payEvt('INV1', 300000, 'PAID');
  await call(w, '/square-webhook', null, { phone: null, raw: full, headers: { 'x-square-hmacsha256-signature': sign(full) } });
  eq('webhook: rest paid -> Paid in full, Stage left for Aaron', [depRow(w)[2], depRow(w)[13], w.tabs['App: Logins'][1][LI.stage], w.telegrams.at(-1).startsWith('💰 PAID IN FULL')], ['Paid in full', '$3,000', 'Deposit Received', true]);
  const n2 = w.telegrams.length;
  await call(w, '/square-webhook', null, { phone: null, raw: full, headers: { 'x-square-hmacsha256-signature': sign(full) } });
  eq('webhook: repeat full-payment delivery is silent', w.telegrams.length, n2);
  // Second buyer had an invoice too ("Allow both") and pays after.
  w.tabs.PROPERTIES[2][0] = 'Pending';
  w.tabs['Square Deposits'].push(['t', 'INV9', 'Draft', 'production', PHONE2, 'Sam Second', 's@example.com', A, 'ROW-A', 'IL', '$3,000', '$1,500', '', '', '']);
  const raw2 = paidEvent('INV9');
  await call(w, '/square-webhook', null, { phone: null, raw: raw2, headers: { 'x-square-hmacsha256-signature': sign(raw2) } });
  eq('webhook: second payer flagged for refund', [depRow(w, 2)[2], depRow(w, 2)[14]], ['Deposit paid', 'Second payer: refund per terms item 6(a)']);
  eq('webhook: second payer does not change their Stage', w.tabs['App: Logins'][2][LI.stage], 'First Showing Done');
  eq('webhook: Aaron told to refund', w.telegrams.at(-1).includes('SECOND deposit'), true);
  const more = payEvt('INV9', 300000, 'PAID');
  await call(w, '/square-webhook', null, { phone: null, raw: more, headers: { 'x-square-hmacsha256-signature': sign(more) } });
  eq('webhook: second payer paying the rest is told to refund all', w.telegrams.at(-1).includes('Refund all of it'), true); }
{ // Paying in full at once reserves too.
  const w = world(); await call(w, '/reserve-request', { listingId: LID, inspected: true }); w.tabs['Square Deposits'][1][3] = 'production';
  const raw = payEvt('INV1', 300000, 'PAID');
  await call(w, '/square-webhook', null, { phone: null, raw, headers: { 'x-square-hmacsha256-signature': sign(raw) } });
  eq('paid in full at once: reserved and logged', [depRow(w)[2], w.tabs.PROPERTIES[2][0], w.tabs['App: Logins'][1][LI.stage]], ['Paid in full', 'Pending', 'Deposit Received']); }
{ // Less than the deposit does not reserve.
  const w = world(); await call(w, '/reserve-request', { listingId: LID, inspected: true }); w.tabs['Square Deposits'][1][3] = 'production';
  const raw = payEvt('INV1', 50000, 'PARTIALLY_PAID');
  await call(w, '/square-webhook', null, { phone: null, raw, headers: { 'x-square-hmacsha256-signature': sign(raw) } });
  eq('below the deposit: not reserved', [depRow(w)[2], w.tabs.PROPERTIES[2][0]], ['Partly paid', 'Available']); }
{ // Aaron, signed in as himself AND as admin, can test as a buyer.
  const w = world(); const r = await call(w, '/reserve-check', { listingId: LID, phone: PHONE2 }, { phone: '+19995550000', admin: true });
  eq('admin with own session can act for a buyer', r.data.ok, true);
  // PHONE hasn't toured, PHONE2 has: a non-admin naming PHONE2 must still be judged as PHONE.
  const w2 = world({ shown: '' }); const r2 = await call(w2, '/reserve-check', { listingId: LID, phone: PHONE2 }, { phone: PHONE });
  eq('a buyer cannot act for someone else (body phone ignored)', r2.data.message, MSG.notToured); }

// ---------- Completed appointment also marks the house shown ----------
{ const w = world({ shown: '' });
  const r = await call(w, '/admin/update-appointment', { phone: PHONE, slot: 1, address: A, date: '2026-11-01', status: 'Completed' }, { phone: null, admin: true });
  eq('Completed -> added to Shown Properties', [r.data.ok, w.tabs['App: Logins'][1][LI.shown]], [true, A]);
  const r2 = await call(w, '/admin/update-appointment', { phone: PHONE, slot: 1, address: A, date: '2026-11-01', status: 'Completed' }, { phone: null, admin: true });
  eq('Completed again -> not duplicated', [r2.data.shownAdded, w.tabs['App: Logins'][1][LI.shown]], [false, A]); }
{ const w = world({ shown: '' });
  await call(w, '/admin/update-appointment', { phone: PHONE, slot: 1, address: A, date: '2026-11-01', status: 'Canceled' }, { phone: null, admin: true });
  eq('Canceled -> Shown untouched', w.tabs['App: Logins'][1][LI.shown], ''); }

// Pull-to-refresh must ignore touches inside pop-ups (Aaron 2026-11-13: scrolling
// up in the Reserve pop-up refreshed the page). Source check on the gesture code.
{ const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const ptr = app.slice(app.indexOf('function initPullToRefresh'), app.indexOf('"touchmove"', app.indexOf('function initPullToRefresh')));
  eq('pull-to-refresh skips touches inside pop-ups', ptr.includes('closest(".id-lightbox-overlay")'), true); }

console.log(`\n${fail} failed`);
process.exit(fail ? 1 : 0);

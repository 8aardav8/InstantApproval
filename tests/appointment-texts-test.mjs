// Showing booked / canceled texts (Aaron, 2026-11-20: "Appointment set and
// appointment cancelled should have the toggle and send automatically";
// "Theirs and mine"). Run: node tests/appointment-texts-test.mjs
// (scripts/deploy-worker.sh runs it too). Fake data and fake services only.
import { generateKeyPairSync, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker, { prettyApptDate } from '../admin/worker.js';
import { makeSheet, cell, LOGINS_GID } from './iah-fixture.mjs';
import { _resetLayoutForTest } from '../admin/layout.js';

let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const SRC = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
const AUD = SRC.match(/const OAUTH_CLIENT_ID = "([^"]+)"/)[1], ADMIN = SRC.match(/const AARON_EMAIL = "([^"]+)"/)[1];
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const PHONE = '+15555550123';
const payload = Buffer.from(JSON.stringify({ p: PHONE, exp: Date.now() + 3600e3 })).toString('base64url');
const SESSION = `${payload}.${createHmac('sha256', 'fake:session-v1').update(payload).digest('base64url')}`;
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const D = day(2), ADDR = '1 Test St, Saint Louis, MO 63121';
const TPL = 870288652;

function world({ mode = { appointment_booked: 'Auto', appointment_canceled: 'Auto' }, dnc = '', appts = [] } = {}) {
  const kv = new Map();
  const env = { INTERNAL_TOOLS_SECRET: 'fake', GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM, QUO_API_KEY: 'fake', TELEGRAM_BOT_TOKEN: 'fake', BUYERS_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
  const sheet = makeSheet({ loginRows: [{ email: 'pat@example.com', agreed: 'TRUE', phone: PHONE, name: 'Pat Example', idLink: 'id:fake', dnc }], extraTabs: { [TPL]: { title: 'Text Templates', rows: [
    ['Key', 'Label', 'Template Text', 'Available Merge Fields', 'Last Updated', 'Auto Send'],
    ['appointment_booked', 'Booked', 'Booked {{address}} for {{date}} -Aaron', '', '', mode.appointment_booked],
    ['appointment_canceled', 'Canceled', 'Canceled {{address}} on {{date}} -Aaron', '', '', mode.appointment_canceled],
  ] } } });
  appts.forEach((v, i) => { const t = sheet.tabs[LOGINS_GID]; t.rows[1][t.rows[0].indexOf(`Appointment ${i + 1}`)] = v; });
  const w = { env, sheet, texts: [], tg: [], quoDown: false };
  w.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/tokeninfo') return json({ aud: AUD, email: ADMIN, email_verified: 'true' });
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'fake' });
    if (url.hostname === 'api.telegram.org') { w.tg.push(JSON.parse(init.body).text); return json({ ok: true }); }
    if (url.hostname === 'api.quo.com' && url.pathname === '/v1/messages') { if (w.quoDown) return json({ e: 'down' }, 500); w.texts.push(JSON.parse(init.body)); return json({ data: {} }); }
    if (url.hostname === 'api.quo.com') return json({ data: [] });
    if (url.hostname === 'sheets.googleapis.com') return sheet.handle(url, init);
    throw new Error(`test: refused ${url.hostname}${url.pathname}`);
  };
  return w;
}
const call = async (w, path, body, headers = {}) => {
  globalThis.fetch = w.fetch; _resetLayoutForTest();
  const res = await worker.fetch(new Request(`https://w.example.com${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good', ...headers }, body: JSON.stringify(body) }), w.env, { waitUntil() {} });
  return res.status;
};
const book = async (w, address = ADDR, date = D) => {
  globalThis.fetch = w.fetch; _resetLayoutForTest();
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Pat Example', email: 'pat@example.com', phone: PHONE, property: address, inspectionDate: date })) fd.append(k, v);
  return (await worker.fetch(new Request('https://w.example.com/upload-id', { method: 'POST', headers: { 'X-IAH-Session': SESSION }, body: fd }), w.env)).status;
};
const slot1 = (w) => cell(w.sheet, LOGINS_GID, 2, 'Appointment 1');
const proposals = (w) => w.tg.filter((t) => /Approval — showing/.test(t));

eq('date reads like a person wrote it', prettyApptDate('2026-11-24'), 'Tuesday, November 24');
{ const w = world(); await book(w);
  eq("buyer books on the site (Auto): one text, to the buyer", w.texts.map((m) => m.to[0]), [PHONE]);
  eq('…with the address and date filled in', w.texts[0].content, `Booked ${ADDR} for ${prettyApptDate(D)} -Aaron`);
  eq('…and Aaron gets a Sent note', w.tg.filter((t) => /Sent — showing booked/.test(t)).length, 1);
  await book(w);
  eq('the same booking again: no second text', w.texts.length, 1); }
{ const w = world({ mode: { appointment_booked: 'Approve', appointment_canceled: 'Approve' } });
  await call(w, '/admin/add-appointment', { phone: PHONE, address: ADDR, date: D });
  eq('Aaron books for them (Approve): nothing to the buyer', w.texts.length, 0);
  eq('…one proposal to Aaron with the text', [proposals(w).length, /Booked 1 Test St/.test(proposals(w)[0] || '')], [1, true]); }
{ const w = world({ mode: { appointment_booked: 'Off', appointment_canceled: 'Off' } });
  eq('Off: the booking saves', [await call(w, '/admin/add-appointment', { phone: PHONE, address: ADDR, date: D }), slot1(w)], [200, `${ADDR} | ${D} | `]);
  eq('Off: nothing to the buyer and nothing to Aaron about it', [w.texts.length, w.tg.filter((t) => /showing/.test(t)).length], [0, 0]); }
{ const w = world({ dnc: 'TRUE' }); eq('DNC: the booking saves', await call(w, '/admin/add-appointment', { phone: PHONE, address: ADDR, date: D }), 200);
  eq('Do Not Contact buyer: no text', w.texts.length, 0); }
{ const w = world(); eq('past date: the call works', await call(w, '/admin/add-appointment', { phone: PHONE, address: ADDR, date: day(-3) }), 200);
  eq('logging a past showing: no text', w.texts.length, 0); }
{ const w = world({ appts: [`${ADDR} | ${D} | `] });
  await call(w, '/cancel-appointment', { phone: PHONE, slot: 1 }, { 'X-IAH-Session': SESSION });
  eq('buyer cancels on the site: canceled text', [slot1(w), w.texts.map((m) => m.content)], [`${ADDR} | ${D} | Canceled`, [`Canceled ${ADDR} on ${prettyApptDate(D)} -Aaron`]]);
  await call(w, '/cancel-appointment', { phone: PHONE, slot: 1 }, { 'X-IAH-Session': SESSION });
  eq('canceling it again: no second text', w.texts.length, 1); }
{ const w = world({ appts: [`${ADDR} | ${D} | `] });
  await call(w, '/admin/update-appointment', { phone: PHONE, slot: 1, address: ADDR, date: D, status: 'Canceled' });
  eq('Aaron cancels for them: canceled text', w.texts.map((m) => /^Canceled/.test(m.content)), [true]);
  await call(w, '/admin/update-appointment', { phone: PHONE, slot: 1, address: ADDR, date: D, status: '' });
  eq('…then turns it back on: booked text', w.texts.map((m) => m.content.split(' ')[0]), ['Canceled', 'Booked']); }
{ const w = world({ appts: [`${ADDR} | ${D} | `] });
  await call(w, '/admin/update-appointment', { phone: PHONE, slot: 1, address: ADDR, date: D, status: '' });
  eq('re-saving an unchanged showing: no text', w.texts.length, 0);
  await call(w, '/admin/update-appointment', { phone: PHONE, slot: 1, address: ADDR, date: D, status: 'Completed' });
  eq('marking it Completed: no text', w.texts.length, 0);
  await call(w, '/admin/update-appointment', { phone: PHONE, slot: 1, address: ADDR, date: day(4), status: '' });
  eq('Aaron moves it to a new date: booked text with the new date', w.texts.map((m) => m.content), [`Booked ${ADDR} for ${prettyApptDate(day(4))} -Aaron`]); }
{ const w = world({ appts: [`${ADDR} | ${D} | `] });
  await call(w, '/update-appointment-date', { phone: PHONE, slot: 1, newDate: day(5) }, { 'X-IAH-Session': SESSION });
  eq('buyer moves it to a new date: booked text with the new date', w.texts.map((m) => m.content), [`Booked ${ADDR} for ${prettyApptDate(day(5))} -Aaron`]); }
{ const w = world(); w.quoDown = true; const s = await call(w, '/admin/add-appointment', { phone: PHONE, address: ADDR, date: D });
  eq('Quo down: the booking still saves and answers OK', [s, slot1(w)], [200, `${ADDR} | ${D} | `]);
  eq('…and Aaron is flagged once', w.tg.filter((t) => /FAILED and will not be retried/.test(t)).length, 1); }
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

// "See site as" a buyer (Aaron 2026-11-21: "see what they see, but make no
// changes while browsing as them"). Run: node tests/view-as-test.mjs
// (scripts/deploy-worker.sh runs it too). Only Aaron can start it; the pass can
// read the buyer's pages and nothing else; it changes nothing in the Sheet; and
// it is never accepted as a real sign-in (Reserve and the rest).
import { generateKeyPairSync, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker from '../admin/worker.js';
import { makeSheet, cell, LOGINS_GID } from './iah-fixture.mjs';
import { _resetLayoutForTest } from '../admin/layout.js';

let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const SRC = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
const AUD = SRC.match(/const OAUTH_CLIENT_ID = "([^"]+)"/)[1], ADMIN = SRC.match(/const AARON_EMAIL = "([^"]+)"/)[1];
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const SECRET = 'fake';
const env = { INTERNAL_TOOLS_SECRET: SECRET, GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM, TELEGRAM_BOT_TOKEN: 'fake', QUO_API_KEY: 'fake' };
const ANN = '+15555550123', D = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
const sheet = makeSheet({ loginRows: [{ email: 'ann@example.com', phone: ANN, name: 'Ann Buyer', favorites: '12 X St', lastLogin: 'OLD', appointments: [`12 X St | ${D} | `] }] });
const texts = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/tokeninfo') {
    if (url.searchParams.get('id_token') !== 'good') return new Response('{}', { status: 400 });
    return json({ aud: AUD, email: ADMIN, email_verified: 'true' });
  }
  if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'fake' });
  if (url.hostname === 'api.telegram.org') return json({ ok: true });
  if (url.hostname === 'api.quo.com') { texts.push(init.body); return json({ data: [] }); }
  if (url.hostname === 'sheets.googleapis.com') return sheet.handle(url, init);
  throw new Error(`test: refused ${url.hostname}${url.pathname}`);
};
const call = async (path, body, headers = {}) => {
  _resetLayoutForTest();
  const res = await worker.fetch(new Request(`https://w.example.com${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }), env, { waitUntil() {} });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, body: j };
};
const b64 = (s) => Buffer.from(s).toString('base64url');
const realSession = () => { const p = b64(JSON.stringify({ p: ANN, exp: Date.now() + 3600e3 })); return `${p}.${createHmac('sha256', `${SECRET}:session-v1`).update(p).digest('base64url')}`; };
const login = () => cell(sheet, LOGINS_GID, 2, 'Last Login'), favs = () => cell(sheet, LOGINS_GID, 2, 'Favorites'), appt = () => cell(sheet, LOGINS_GID, 2, 'Appointment 1');

eq('starting needs Aaron\'s sign-in', (await call('/admin/view-as', { phone: ANN })).status, 401);
eq('a bad sign-in is refused', (await call('/admin/view-as', { phone: ANN }, { Authorization: 'Bearer bad' })).status, 403);
eq('a phone with no site sign-in: refused', (await call('/admin/view-as', { phone: '+15550009999' }, { Authorization: 'Bearer good' })).status, 404);
const start = await call('/admin/view-as', { phone: ANN }, { Authorization: 'Bearer good' });
eq('Aaron starts it: a pass plus the buyer\'s name', [start.status, start.body.name, start.body.phone], [200, 'Ann Buyer', ANN]);
const V = { 'X-IAH-Session': start.body.token };

let r = await call('/my-info', { phone: '+19999999999' }, V);
eq('reads their My Info (as them, whatever phone is sent)', [r.status, r.body.name], [200, 'Ann Buyer']);
r = await call('/my-appointments', {}, V);
eq('reads their showings', [r.status, (r.body.appointments || []).length], [200, 1]);
r = await call('/sync-visitor', { favoriteChanges: [{ address: '9 Y Ave', action: 'add' }], favorites: ['7 Z Rd'], filters: { sort: 'x' }, search: 'hello' }, V);
eq('the visit sync only reads: favorites come back', [r.status, r.body.favorites], [200, ['12 X St']]);
eq('…and nothing was written (favorites, Last Login, search)', [favs(), login(), cell(sheet, LOGINS_GID, 2, 'Last Search')], ['12 X St', 'OLD', '']);
for (const path of ['/cancel-appointment', '/update-appointment-date', '/update-name', '/request-phone-change', '/request-email-change', '/update-co-buyer', '/upload-my-id']) {
  r = await call(path, { slot: 1, newDate: D, name: 'Hacked', email: 'x@y.z', newPhone: '+15550001111' }, V);
  eq(`${path}: refused as view-only`, [r.status, r.body.error], [403, 'view-only']);
}
eq('…and the showing and name are untouched', [appt(), cell(sheet, LOGINS_GID, 2, 'Name')], [`12 X St | ${D} | `, 'Ann Buyer']);
eq('no texts were sent', texts.filter((t) => /messages|content/.test(String(t))).length, 0);
r = await call('/reserve-request', { listingId: 'x' }, V);
const r2 = await call('/reserve-request', { listingId: 'x' });
eq('Reserve treats the pass as signed out', r.status, r2.status);
r = await call('/sync-visitor', { favoriteChanges: [{ address: '9 Y Ave', action: 'add' }] }, { 'X-IAH-Session': realSession(), 'X-IAH-View-Only': '1' });
eq('a forged view-only header can\'t change a real visit', favs(), '12 X St | 9 Y Ave');
const forged = (() => { const p = b64(JSON.stringify({ p: ANN, exp: Date.now() + 3600e3, ro: 1 })); return `${p}.${createHmac('sha256', `${SECRET}:session-v1`).update(p).digest('base64url')}`; })();
eq('a pass signed with the wrong key is not a view pass', (await call('/my-info', {}, { 'X-IAH-Session': forged.replace(/.$/, 'A') })).status, 401);
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);

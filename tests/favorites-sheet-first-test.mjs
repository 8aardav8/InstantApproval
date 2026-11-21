// Favorites: the Sheet is the main copy (Aaron, 2026-11-20: "I'd like a way to
// favorite properties for a buyer from my end of the site").
// Run: node tests/favorites-sheet-first-test.mjs   (scripts/deploy-worker.sh runs it too)
// A buyer's visit must never wipe a favorite Aaron added; taps apply in order;
// an old cached page's full list only adds; /admin-favorite needs Aaron's
// Google sign-in, the right row phone and an exact PROPERTIES address.
import { generateKeyPairSync, createHmac } from 'node:crypto';
import worker, { applyFavoriteChanges, mergeFavoritesUnion } from '../admin/worker.js';
import { makeSheet, cell, LOGINS_GID } from './iah-fixture.mjs';
import { moveColumn } from './fake-sheets.mjs';
import { _resetLayoutForTest } from '../admin/layout.js';
import { readFileSync } from 'node:fs';
// Aaron's sign-in identity, read from the worker itself (not copied here).
const SRC = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
const AUD = SRC.match(/const OAUTH_CLIENT_ID = "([^"]+)"/)[1], ADMIN = SRC.match(/const AARON_EMAIL = "([^"]+)"/)[1];

let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const SECRET = 'internal-test-secret';
const env = { INTERNAL_TOOLS_SECRET: SECRET, GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM, TELEGRAM_BOT_TOKEN: 'fake' };
const A = '12 X St, Peoria, IL', B = '9 Y Ave, Peoria, IL', C = '3 Z Rd, Peoria, IL';
const ANN = '+15555550101';
const sheet = makeSheet({
  loginRows: [{ phone: ANN, name: 'Ann', favorites: A }, { phone: '+15555550102', name: 'Bo' }],
  propRows: [{ address: A }, { address: B }, { address: C }],
});
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/tokeninfo') {
    if (url.searchParams.get('id_token') !== 'good') return new Response('{}', { status: 400 });
    return new Response(JSON.stringify({ aud: AUD, email: ADMIN, email_verified: 'true' }));
  }
  if (url.hostname === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'fake' }));
  if (url.hostname === 'api.telegram.org') return new Response('{}');
  if (url.hostname === 'sheets.googleapis.com') return sheet.handle(url, init);
  throw new Error(`test: refused ${url.hostname}${url.pathname}`);
};
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sessionFor = (phone) => {
  const payload = b64url(JSON.stringify({ p: phone, exp: Date.now() + 3600e3 }));
  return `${payload}.${b64url(createHmac('sha256', `${SECRET}:session-v1`).update(payload).digest())}`;
};
const call = async (path, body, headers = {}) => {
  _resetLayoutForTest();
  const res = await worker.fetch(new Request(`https://w.example.com${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
const sync = (extra) => call('/sync-visitor', { phone: ANN, filters: {}, search: '', ...extra }, { 'X-IAH-Session': sessionFor(ANN) });
const favs = (row) => cell(sheet, LOGINS_GID, row, 'Favorites');

// Pure helpers
eq('taps apply in order', applyFavoriteChanges([A], [{ address: B, action: 'add' }, { address: A, action: 'remove' }, { address: B, action: 'add' }]), [B]);
eq('add then remove the same home ends removed', applyFavoriteChanges([], [{ address: C, action: 'add' }, { address: C, action: 'remove' }]), []);
eq('a full list only adds', mergeFavoritesUnion([A, B], [B, C]), [A, B, C]);

// Buyer visits
let r = await sync({ favoriteChanges: [] });
eq('a plain visit keeps the Sheet list and returns it', [r.status, r.body && r.body.favorites, favs(2)], [200, [A], A]);
r = await sync({ favoriteChanges: [], favorites: [] });
eq('an empty phone (new device) wipes nothing', [r.body.favorites, favs(2)], [[A], A]);
r = await sync({ favorites: [B] });
eq('an old cached page sending a full list only adds', favs(2), `${A} | ${B}`);
r = await sync({ favoriteChanges: [{ address: B, action: 'remove' }] });
eq("the buyer's own un-heart removes", [r.body.favorites, favs(2)], [[A], A]);
r = await sync({ favorites: [C], favoriteChanges: [{ address: C, action: 'remove' }] });
eq('hand-over list merges first, then taps apply', favs(2), A);

// Aaron's admin endpoint
r = await call('/admin-favorite', { buyerRow: 2, phone: ANN, address: B, action: 'add' });
eq('no Google sign-in: refused', r.status, 401);
r = await call('/admin-favorite', { buyerRow: 2, phone: ANN, address: B, action: 'add' }, { Authorization: 'Bearer junk' });
eq('a bad Google token: refused', [r.status, favs(2)], [403, A]);
const admin = (body) => call('/admin-favorite', body, { Authorization: 'Bearer good' });
r = await admin({ buyerRow: 2, phone: ANN, address: B, action: 'add' });
eq('Aaron adds a favorite', [r.status, favs(2)], [200, `${A} | ${B}`]);
r = await sync({ favoriteChanges: [] });
eq("the buyer's next visit keeps it and hands it to their phone", [r.body.favorites, favs(2)], [[A, B], `${A} | ${B}`]);
r = await sync({ favoriteChanges: [], favorites: [A] });
eq("an old page that never saw it doesn't wipe it", favs(2), `${A} | ${B}`);
r = await admin({ buyerRow: 2, phone: ANN, address: B, action: 'add' });
eq('adding twice: no duplicate', [r.status, favs(2)], [200, `${A} | ${B}`]);
r = await admin({ buyerRow: 2, phone: ANN, address: '9 Y Ave', action: 'add' });
eq('an address not on PROPERTIES is refused', [r.status, favs(2)], [422, `${A} | ${B}`]);
r = await admin({ buyerRow: 3, phone: ANN, address: C, action: 'add' });
eq("phone doesn't match the row: refused", [r.status, favs(3)], [409, '']);
r = await admin({ buyerRow: 2, phone: ANN, address: A, action: 'remove' });
eq('Aaron removes a favorite', [r.status, favs(2)], [200, B]);
moveColumn(sheet.tabs[LOGINS_GID], sheet.tabs[LOGINS_GID].rows[0].indexOf('Favorites'), 3);
r = await admin({ buyerRow: 2, phone: ANN, address: C, action: 'add' });
eq('follows the column tag when the column moves', [r.status, favs(2)], [200, `${B} | ${C}`]);
r = await sync({ favoriteChanges: [{ address: B, action: 'remove' }] });
eq('buyer sync follows the moved column too', favs(2), C);
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);

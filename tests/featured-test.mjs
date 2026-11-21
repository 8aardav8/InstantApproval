// Featured Deals tick box (Aaron, 2026-11-20: "add the featured checkbox able
// to be ticked inside the admin panel of the site"). Run: node tests/featured-test.mjs
// (scripts/deploy-worker.sh runs it too). Needs Aaron's sign-in, writes only the
// one matching row's Featured cell, refuses an unknown or doubled address, and
// follows the column tag.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker from '../admin/worker.js';
import { makeSheet, cell, PROPS_GID } from './iah-fixture.mjs';
import { moveColumn } from './fake-sheets.mjs';
import { _resetLayoutForTest } from '../admin/layout.js';

let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const SRC = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
const AUD = SRC.match(/const OAUTH_CLIENT_ID = "([^"]+)"/)[1], ADMIN = SRC.match(/const AARON_EMAIL = "([^"]+)"/)[1];
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { INTERNAL_TOOLS_SECRET: 'x', GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM, TELEGRAM_BOT_TOKEN: 'fake' };
const sheet = makeSheet({ propRows: [
  { status: 'Available', address: '12 X St, Peoria, IL', featured: 'FALSE', lockbox: '1234' },
  { status: 'Available', address: '9 Y Ave, Peoria, IL', featured: 'FALSE' },
  { status: 'Available', address: '5 Twin Rd', featured: 'FALSE' },
  { status: 'Pending', address: '5 Twin Rd', featured: 'FALSE' },
] });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/tokeninfo') {
    if (url.searchParams.get('id_token') !== 'good') return new Response('{}', { status: 400 });
    return new Response(JSON.stringify({ aud: AUD, email: ADMIN, email_verified: 'true' }));
  }
  if (url.hostname === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'fake' }));
  if (url.hostname === 'api.telegram.org') return new Response('{}');
  if (url.hostname === 'sheets.googleapis.com') return sheet.handle(url, init);
  throw new Error(`test: refused ${url.hostname}${url.pathname}`);
};
const call = async (method, path, body, tok = 'good') => {
  _resetLayoutForTest();
  const res = await worker.fetch(new Request(`https://w.example.com${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
const feat = (row) => cell(sheet, PROPS_GID, row, 'Featured');
const ID = '12-x-st-peoria-il';

let r = await call('POST', '/admin/set-featured', { id: ID, featured: true }, 'bad');
eq('a bad sign-in is refused', [r.status, feat(2)], [403, 'FALSE']);
r = await call('POST', '/admin/set-featured', { id: ID, featured: true });
eq('tick: saved and read back', [r.status, r.body.featured, feat(2)], [200, true, 'TRUE']);
eq('…only that row changed', [feat(3), cell(sheet, PROPS_GID, 2, 'Lock box ')], ['FALSE', '1234']);
r = await call('POST', '/admin/set-featured', { id: ID, featured: false });
eq('untick', [r.status, feat(2)], [200, 'FALSE']);
r = await call('POST', '/admin/set-featured', { id: 'nowhere-st', featured: true });
eq('unknown listing: 404, nothing written', r.status, 404);
r = await call('POST', '/admin/set-featured', { id: '5-twin-rd', featured: true });
eq('two rows with one address: refused', [r.status, feat(4), feat(5)], [409, 'FALSE', 'FALSE']);
r = await call('POST', '/admin/set-featured', { id: ID, featured: 'yes' });
eq('featured must be true or false', r.status, 400);
moveColumn(sheet.tabs[PROPS_GID], sheet.tabs[PROPS_GID].rows[0].indexOf('Featured'), 1);
r = await call('POST', '/admin/set-featured', { id: '9-y-ave-peoria-il', featured: true });
eq('follows the column tag when the column moves', [r.status, feat(3)], [200, 'TRUE']);
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);

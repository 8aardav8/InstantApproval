// Admin search (Aaron 2026-11-21: "When in admin mode, have the search bar
// search anything on the sheet row"). Run: node tests/admin-search-test.mjs
// (scripts/deploy-worker.sh runs it too). The index needs Aaron's sign-in, uses
// the same ids as the public listings, and covers every cell of the row.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker, { adminSearchIndex } from '../admin/worker.js';
import { makeSheet } from './iah-fixture.mjs';
import { _resetLayoutForTest } from '../admin/layout.js';

let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const SRC = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
const AUD = SRC.match(/const OAUTH_CLIENT_ID = "([^"]+)"/)[1], ADMIN = SRC.match(/const AARON_EMAIL = "([^"]+)"/)[1];
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { INTERNAL_TOOLS_SECRET: 'x', GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM, TELEGRAM_BOT_TOKEN: 'fake' };
const sheet = makeSheet({ propRows: [
  { status: 'Available', address: '12 X St, Peoria, IL', seller: 'Kise LLC', lockbox: '4321', notes: 'New roof 2024' },
  { status: 'Off- market', address: '12 X St, Peoria, IL', seller: 'Other Owner' },
  { status: 'typo', address: '7 Hidden Ln', seller: 'Nobody' },
] });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/tokeninfo') {
    if (url.searchParams.get('id_token') !== 'good') return new Response('{}', { status: 400 });
    return new Response(JSON.stringify({ aud: AUD, email: ADMIN, email_verified: 'true' }));
  }
  if (url.hostname === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'fake' }));
  if (url.hostname === 'sheets.googleapis.com') return sheet.handle(url, init);
  throw new Error(`test: refused ${url.hostname}${url.pathname}`);
};
const call = async (tok) => {
  _resetLayoutForTest();
  const res = await worker.fetch(new Request('https://w.example.com/admin/search-index', { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }), env, { waitUntil() {} });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json, cache: res.headers.get('Cache-Control') };
};
eq('no sign-in: refused', (await call()).status, 401);
eq('a bad sign-in: refused, nothing sent', [(await call('bad')).status, (await call('bad')).body.index], [403, undefined]);
const r = await call('good');
eq('signed in: one entry per public listing, same ids as the site', Object.keys(r.body.index), ['12-x-st-peoria-il', '12-x-st-peoria-il-1']);
eq('private columns are searchable', ['kise llc', '4321', 'new roof'].map((q) => r.body.index['12-x-st-peoria-il'].includes(q)), [true, true, true]);
eq('the duplicate address keeps its own row', r.body.index['12-x-st-peoria-il-1'].includes('other owner'), true);
eq('a row the site does not list is not in the index', JSON.stringify(r.body.index).includes('nobody'), false);
eq('never cached', r.cache, 'no-store');
eq('pure: blank address skipped', adminSearchIndex([['h'], ['Available', '', '']], 1, 0), {});
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);

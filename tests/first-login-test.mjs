// First Login gets filled the first time a buyer actually signs in.
// Run: node tests/first-login-test.mjs   (scripts/deploy-worker.sh runs it too)
// Real case, 2026-11-12: Eric Johnson's row was created before he ever
// signed in (from Quo / an ID link), so First Login stayed blank. His
// sign-ins only stamped Last Login, and the buyer page showed ❌ "never
// logged in". Fake data and fake services only; unknown hosts throw.
import { generateKeyPairSync, createHmac } from 'node:crypto';
import worker from '../admin/worker.js';
import { makeSheet, cell, LOGINS_GID } from './iah-fixture.mjs';
import { moveColumn } from './fake-sheets.mjs';
import { _resetLayoutForTest } from '../admin/layout.js';

let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { INTERNAL_TOOLS_SECRET: 'fake-secret-for-tests', GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM, QUO_API_KEY: 'fake', TELEGRAM_BOT_TOKEN: 'fake' };
const PHONE = '+15555550123';
// A real signed session for the fake secret (same format as createSessionToken).
const payload = Buffer.from(JSON.stringify({ p: PHONE, exp: Date.now() + 3600e3 })).toString('base64url');
const SESSION = `${payload}.${createHmac('sha256', 'fake-secret-for-tests:session-v1').update(payload).digest('base64url')}`;

function world(firstLogin) {
  // Row 2 of a fake App: Logins (tests/iah-fixture.mjs), real headers and column tags.
  const sheet = makeSheet({ loginRows: [{ firstLogin, email: 'pat@example.com', agreed: 'TRUE', phone: PHONE, name: 'Pat Example', lastLogin: '2026-01-01T00:00:00.000Z' }] });
  const w = { sheet, get: (h) => cell(sheet, LOGINS_GID, 2, h) };
  w.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'fake' });
    if (url.hostname === 'api.telegram.org') return json({ ok: true });
    if (url.hostname === 'api.quo.com' || url.hostname === 'api.openphone.com') throw new Error('quo unavailable in test');
    if (url.hostname === 'sheets.googleapis.com') return sheet.handle(url, init);
    throw new Error(`test: refused ${url.hostname}${url.pathname}`);
  };
  return w;
}
async function post(w, path, body) {
  globalThis.fetch = w.fetch; _resetLayoutForTest();
  const res = await worker.fetch(new Request(`https://worker.example.com${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IAH-Session': SESSION }, body: JSON.stringify(body) }), env);
  return res.status;
}
const gate = { name: 'Pat Typed Name', email: 'pat@example.com', phone: PHONE, agreed: true };

{ const w = world(''); const s = await post(w, '/gate-login', gate);
  eq('gate sign-in on a row with blank First Login fills it', [s, /^\d{4}-/.test(w.get('First Login')), w.get('First Login') === w.get('Last Login')], [200, true, true]);
  eq('the stored name is kept, not the typed one', w.get('Name'), 'Pat Example'); }
{ const w = world('2025-12-19T16:54:01.377Z'); await post(w, '/gate-login', gate);
  eq('an existing First Login is never changed', w.get('First Login'), '2025-12-19T16:54:01.377Z'); }
{ const w = world(''); const s = await post(w, '/sync-visitor', { phone: PHONE });
  eq('a visit (sync) on a row with blank First Login fills it', [s, /^\d{4}-/.test(w.get('First Login'))], [200, true]); }
{ const w = world('2025-12-19T16:54:01.377Z'); await post(w, '/sync-visitor', { phone: PHONE });
  eq('a visit never touches an existing First Login', w.get('First Login'), '2025-12-19T16:54:01.377Z'); }


// TASK-000844: Aaron moves columns; values must follow their tags, not letters.
{ const w = world('');
  const t = w.sheet.tabs[LOGINS_GID];
  moveColumn(t, 0, 20);   // First Login dragged far right
  moveColumn(t, 4, 2);    // Name (now at 3 after the first move) dragged left
  moveColumn(t, 30, 1);   // something else pushed in front of Email
  const before = JSON.stringify(t.rows[0]);
  const s = await post(w, '/gate-login', gate);
  eq('moved columns: header row untouched', JSON.stringify(t.rows[0]), before);
  eq('moved columns: First Login filled in its moved column', [s, /^\d{4}-/.test(w.get('First Login')), w.get('First Login') === w.get('Last Login')], [200, true, true]);
  eq('moved columns: stored name kept in Name column', w.get('Name'), 'Pat Example');
  eq('moved columns: email still in Email column', w.get('Email'), 'pat@example.com');
  eq('moved columns: phone still in Phone column', w.get('Phone'), PHONE); }

console.log(`\n${fail} failed`);
process.exit(fail ? 1 : 0);

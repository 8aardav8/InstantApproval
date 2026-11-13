// First Login gets filled the first time a buyer actually signs in.
// Run: node tests/first-login-test.mjs   (scripts/deploy-worker.sh runs it too)
// Real case, 2026-11-12: Eric Johnson's row was created before he ever
// signed in (from Quo / an ID link), so First Login stayed blank. His
// sign-ins only stamped Last Login, and the buyer page showed ❌ "never
// logged in". Fake data and fake services only; unknown hosts throw.
import { generateKeyPairSync, createHmac } from 'node:crypto';
import worker from '../admin/worker.js';

let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { INTERNAL_TOOLS_SECRET: 'fake-secret-for-tests', GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM, QUO_API_KEY: 'fake', TELEGRAM_BOT_TOKEN: 'fake' };
const PHONE = '+15555550123';
// A real signed session for the fake secret (same format as createSessionToken).
const payload = Buffer.from(JSON.stringify({ p: PHONE, exp: Date.now() + 3600e3 })).toString('base64url');
const SESSION = `${payload}.${createHmac('sha256', 'fake-secret-for-tests:session-v1').update(payload).digest('base64url')}`;

function world(firstLogin) {
  // Row 2 of App: Logins, A:G = First Login, Email, Agreed, Phone, Name, ID Link, Last Login.
  const w = { rowA: [firstLogin, 'pat@example.com', 'TRUE', PHONE, 'Pat Example', '', '2026-01-01T00:00:00.000Z'], writes: {} };
  w.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'fake' });
    if (url.hostname === 'api.telegram.org') return json({ ok: true });
    if (url.hostname === 'api.quo.com' || url.hostname === 'api.openphone.com') throw new Error('quo unavailable in test');
    if (url.hostname === 'sheets.googleapis.com') {
      const range = decodeURIComponent(url.pathname.split('/values/')[1] || '');
      if (init.method === 'PUT') { w.writes[range] = JSON.parse(init.body).values[0]; return json({}); }
      const cols = { A: 0, B: 1, D: 3 };
      const m = range.match(/^App: Logins!([A-Z])(\d*):([A-Z])\d*$/);
      if (m && !m[2]) { const a = cols[m[1]], b = 'ABCDEFG'.indexOf(m[3]); return json({ values: [['h'], w.rowA.slice(a, b + 1)] }); }
      if (m && m[2] === '2') return json({ values: [w.rowA.slice(cols[m[1]], 'ABCDEFG'.indexOf(m[3]) + 1)] });
      return json({ values: [] });
    }
    throw new Error(`test: refused ${url.hostname}${url.pathname}`);
  };
  return w;
}
async function post(w, path, body) {
  globalThis.fetch = w.fetch;
  const res = await worker.fetch(new Request(`https://worker.example.com${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IAH-Session': SESSION }, body: JSON.stringify(body) }), env);
  return res.status;
}
const gate = { name: 'Pat Typed Name', email: 'pat@example.com', phone: PHONE, agreed: true };

{ const w = world(''); const s = await post(w, '/gate-login', gate); const row = w.writes['App: Logins!A2:G2'];
  eq('gate sign-in on a row with blank First Login fills it', [s, !!row && /^\d{4}-/.test(row[0]), !!row && row[0] === row[6]], [200, true, true]);
  eq('the stored name is kept, not the typed one', row && row[4], 'Pat Example'); }
{ const w = world('2025-12-19T16:54:01.377Z'); await post(w, '/gate-login', gate); const row = w.writes['App: Logins!A2:G2'];
  eq('an existing First Login is never changed', row && row[0], '2025-12-19T16:54:01.377Z'); }
{ const w = world(''); const s = await post(w, '/sync-visitor', { phone: PHONE });
  eq('a visit (sync) on a row with blank First Login fills it', [s, /^\d{4}-/.test((w.writes['App: Logins!A2:A2'] || [''])[0])], [200, true]); }
{ const w = world('2025-12-19T16:54:01.377Z'); await post(w, '/sync-visitor', { phone: PHONE });
  eq('a visit never touches an existing First Login', 'App: Logins!A2:A2' in w.writes, false); }

console.log(`\n${fail} failed`);
process.exit(fail ? 1 : 0);

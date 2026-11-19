// Gate Capture Log: each sign-up must land in column A, or Aaron is told.
// Run: node tests/gate-capture-test.mjs   (scripts/deploy-worker.sh runs it too)
// 2026-11-19 (L127): Google's append can guess the wrong start column. The
// gate log keeps append (atomic, so simultaneous sign-ups can't collide) but
// checks the response's updatedRange. Fake data and fake services only.
import { generateKeyPairSync } from 'node:crypto';
import worker from '../admin/worker.js';
import { makeSheet } from './iah-fixture.mjs';
import { _resetLayoutForTest } from '../admin/layout.js';
let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM, TELEGRAM_BOT_TOKEN: 'fake' };
const GATE = 1768423850;
async function capture(mode) {
  const sheet = makeSheet(); const texts = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'fake' });
    if (url.hostname === 'api.telegram.org') { texts.push(JSON.parse(init.body).text); return json({ ok: true }); }
    if (url.hostname === 'sheets.googleapis.com') {
      if (decodeURIComponent(url.pathname).endsWith(':append')) {
        if (mode === '429') return json({ error: { code: 429 } }, 429);
        if (mode === 'shifted') return json({ updates: { updatedRange: "'Gate Capture Log'!O67:U67" } });
      }
      return sheet.handle(url, init);
    }
    throw new Error(`test: refused ${url.hostname}`);
  };
  _resetLayoutForTest();
  const res = await worker.fetch(new Request('https://worker.example.com/gate-capture', { method: 'POST', body: JSON.stringify({ name: 'Pat Example', email: 'pat@example.com', phone: '+15555550123', agreed: true }) }), env);
  return { status: res.status, texts, rows: sheet.tabs[GATE].rows };
}
{ const r = await capture('ok');
  eq('normal sign-up lands in column A', [r.rows.length, (r.rows[1] || [])[1], (r.rows[1] || [])[3]], [2, 'Pat Example', '+15555550123']);
  eq('normal sign-up sends no alert', r.texts.length, 0); }
{ const r = await capture('shifted');
  eq('a row landing in the wrong column alerts Aaron with the lead', r.texts.length === 1 && /O67/.test(r.texts[0]) && r.texts[0].includes('+15555550123'), true); }
{ const r = await capture('429');
  eq('a failed write alerts Aaron with the lead', r.texts.length === 1 && /429/.test(r.texts[0]) && r.texts[0].includes('Pat Example'), true);
  eq('the beacon still gets 204', r.status, 204); }
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);

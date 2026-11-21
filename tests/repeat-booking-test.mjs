// Booking the same showing twice must not add a second copy, or ping Aaron twice.
// Run: node tests/repeat-booking-test.mjs   (scripts/deploy-worker.sh runs it too)
// Real case, 2026-11-15: Torey Taylor's one booking of 6580 Saint Louis Ave
// for 11/16 landed in Appointment 1, 2 and 3 (the submit was sent three
// times while the ID upload ran). Fake data and fake services only.
import { generateKeyPairSync, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker from '../admin/worker.js';
import { makeSheet, cell, LOGINS_GID } from './iah-fixture.mjs';
import { _resetLayoutForTest } from '../admin/layout.js';

let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { INTERNAL_TOOLS_SECRET: 'fake', GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM, QUO_API_KEY: 'fake', TELEGRAM_BOT_TOKEN: 'fake' };
const PHONE = '+15555550123';
const payload = Buffer.from(JSON.stringify({ p: PHONE, exp: Date.now() + 3600e3 })).toString('base64url');
const SESSION = `${payload}.${createHmac('sha256', 'fake:session-v1').update(payload).digest('base64url')}`;
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const D = day(2), ADDR = '1 Test St, Saint Louis, MO 63121';

function world(appts = []) {
  const row = { email: 'pat@example.com', agreed: 'TRUE', phone: PHONE, name: 'Pat Example', idLink: 'id:fake' };
  const sheet = makeSheet({ loginRows: [row] });
  appts.forEach((v, i) => { const t = sheet.tabs[LOGINS_GID]; t.rows[1][t.rows[0].indexOf(`Appointment ${i + 1}`)] = v; });
  const w = { sheet, telegrams: 0, slots: () => Array.from({ length: 10 }, (_, i) => cell(sheet, LOGINS_GID, 2, `Appointment ${i + 1}`)).filter(Boolean) };
  w.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'fake' });
    // Count only the booking ping to Aaron, not the buyer-text proposal (2026-11-20).
    if (url.hostname === 'api.telegram.org') { if (!/showing booked text/.test(String(init.body))) w.telegrams++; else w.proposals = (w.proposals || 0) + 1; return json({ ok: true }); }
    if (url.hostname === 'api.quo.com' || url.hostname === 'api.openphone.com') throw new Error('quo unavailable in test');
    if (url.hostname === 'sheets.googleapis.com') return sheet.handle(url, init);
    throw new Error(`test: refused ${url.hostname}${url.pathname}`);
  };
  return w;
}
async function book(w, address = ADDR, date = D) {
  globalThis.fetch = w.fetch; _resetLayoutForTest();
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Pat Example', email: 'pat@example.com', phone: PHONE, property: address, inspectionDate: date })) fd.append(k, v);
  const res = await worker.fetch(new Request('https://worker.example.com/upload-id', { method: 'POST', headers: { 'X-IAH-Session': SESSION }, body: fd }), env);
  return res.status;
}

{ const w = world(); const s = [await book(w), await book(w), await book(w)];
  eq('three submits of the same showing all answer OK', s, [200, 200, 200]);
  eq('…but the showing is saved once', w.slots(), [`${ADDR} | ${D} | `]);
  eq('…and Aaron is told once', w.telegrams, 1);
  eq('…and the buyer text is proposed once', w.proposals, 1); }
{ const w = world(); await book(w); await book(w, ADDR, day(3)); await book(w, '2 Other St', D);
  eq('a different date or a different house is still a new showing', w.slots().length, 3); }
{ const w = world([`${ADDR} | ${D} | Canceled`]); await book(w);
  eq('booking a canceled showing again turns it back on, no copy', w.slots(), [`${ADDR} | ${D} | `]); }
{ const w = world([`${ADDR} | ${D} | Completed`]); await book(w);
  eq('a completed one is left as it is', w.slots(), [`${ADDR} | ${D} | Completed`]); }

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const sub = app.slice(app.indexOf('fetch(UPLOAD_ID_ENDPOINT') - 900, app.indexOf('fetch(UPLOAD_ID_ENDPOINT'));
eq('the page ignores extra taps while a booking uploads', [/if \(form\.dataset\.busy\) return;/.test(sub), /submitBtn\.disabled = true/.test(sub)], [true, true]);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

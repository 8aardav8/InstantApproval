// Templates page Auto/Approve/Off settings (Aaron, 2026-11-20: "On the templates
// page, each template should have a toggle", then "Can we do threeway toggles
// to set auto/off/check?"). Run: node tests/template-autosend-test.mjs
// (scripts/deploy-worker.sh runs it too). Only the automatic texts take a
// setting, only Auto/Approve/Off is saved, the wording is untouched, it needs Aaron's
// sign-in, and it follows the column tag.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker, { autoSendValue } from '../admin/worker.js';
import { makeSheet, cell } from './iah-fixture.mjs';
import { moveColumn } from './fake-sheets.mjs';
import { _resetLayoutForTest } from '../admin/layout.js';

let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const SRC = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
const AUD = SRC.match(/const OAUTH_CLIENT_ID = "([^"]+)"/)[1], ADMIN = SRC.match(/const AARON_EMAIL = "([^"]+)"/)[1];
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { INTERNAL_TOOLS_SECRET: 'x', GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM, TELEGRAM_BOT_TOKEN: 'fake' };
const TPL = 870288652;
const sheet = makeSheet({ extraTabs: { [TPL]: { title: 'Text Templates', rows: [
  ['Key', 'Label', 'Template Text', 'Available Merge Fields', 'Last Updated', 'Auto Send'],
  ['day_of_reminder', 'Day-of', 'Morning words', '', '', 'On'],
  ['status_change', 'Status', 'Status words', '', '', ''],
  ['price_drop', 'Price', 'Price words', '', '', 'Approve'],
  ['snippet_hi', 'Snippet: Hi', 'Hi words', '', '', ''],
] } } });
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
const call = async (method, path, body, tok = 'good') => {
  _resetLayoutForTest();
  const res = await worker.fetch(new Request(`https://w.example.com${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
const auto = (row) => cell(sheet, TPL, row, 'Auto Send');

eq('blank status cell reads Auto (how it worked before)', autoSendValue('status_change', ''), 'Auto');
eq('blank price cell reads Approve', autoSendValue('price_drop', ''), 'Approve');
eq('the brief name Check reads as Approve', autoSendValue('price_drop', 'Check'), 'Approve');
eq('the first version\'s On reads as Auto', autoSendValue('day_of_reminder', 'On'), 'Auto');
let r = await call('GET', '/admin/text-templates');
eq('the page gets each switch, none for a snippet', r.body.templates.map((t) => [t.key, t.autoSend]), [['day_of_reminder', 'Auto'], ['status_change', 'Auto'], ['price_drop', 'Approve'], ['snippet_hi', null]]);
r = await call('POST', '/admin/set-text-template', { key: 'price_drop', autoSend: 'Auto' }, 'bad');
eq('a bad sign-in is refused', [r.status, auto(4)], [403, 'Approve']);
r = await call('POST', '/admin/set-text-template', { key: 'price_drop', autoSend: 'Auto' });
eq('set price drops to Auto', [r.status, r.body.autoSend, auto(4)], [200, 'Auto', 'Auto']);
r = await call('POST', '/admin/set-text-template', { key: 'price_drop', autoSend: 'Off' });
eq('set price drops to Off', [r.status, auto(4)], [200, 'Off']);
eq('the wording is untouched', cell(sheet, TPL, 4, 'Template Text'), 'Price words');
r = await call('POST', '/admin/set-text-template', { key: 'snippet_hi', autoSend: 'Auto' });
eq('a snippet takes no switch', [r.status, auto(5)], [400, '']);
r = await call('POST', '/admin/set-text-template', { key: 'status_change', autoSend: 'yes' });
eq('only Auto, Approve or Off is saved', [r.status, auto(3)], [400, '']);
moveColumn(sheet.tabs[TPL], 5, 0);
r = await call('POST', '/admin/set-text-template', { key: 'status_change', autoSend: 'Approve' });
eq('follows the column tag when the column moves', [r.status, auto(3)], [200, 'Approve']);
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);

// Trello "Shown in person" checklist -> Shown Properties (Aaron, 2026-11-18).
// Run: node tests/trello-shown-test.mjs   (scripts/deploy-worker.sh runs it too)
// The endpoint must add only an exact PROPERTIES address, only to the row
// whose phone matches, only with its own secret, and never remove anything.
import { generateKeyPairSync } from 'node:crypto';
import worker from '../admin/worker.js';
import { makeSheet, cell, LOGINS_GID } from './iah-fixture.mjs';
import { moveColumn } from './fake-sheets.mjs';
import { _resetLayoutForTest } from '../admin/layout.js';

let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const SECRET = 'trello-writeback-test-secret';
const env = { INTERNAL_TOOLS_SECRET: 'other-secret', TRELLO_WRITEBACK_SECRET: SECRET, GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM, TELEGRAM_BOT_TOKEN: 'fake' };
const sheet = makeSheet({
  loginRows: [
    { phone: '+15555550101', name: 'Ann', shown: '12 X St, Peoria, IL' },
    { phone: '(555) 555-0102', name: 'Bo' },
  ],
  propRows: [{ address: '12 X St, Peoria, IL' }, { address: '9 Y Ave, Peoria, IL' }],
});
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'fake' }));
  if (url.hostname === 'api.telegram.org') return new Response('{}');
  if (url.hostname === 'sheets.googleapis.com') return sheet.handle(url, init);
  throw new Error(`test: refused ${url.hostname}${url.pathname}`);
};
const post = async (body, secret = SECRET) => {
  _resetLayoutForTest();
  const res = await worker.fetch(new Request('https://w.example.com/internal/trello-add-shown', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Trello-Writeback': secret } : {}) }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  return res.status;
};
const shown = (row) => cell(sheet, LOGINS_GID, row, 'Shown Properties');

eq('no secret: refused', await post({ row: 2, phone: '+15555550101', address: '9 Y Ave, Peoria, IL' }, ''), 403);
eq('the internal-tools secret is not enough', await post({ row: 2, phone: '+15555550101', address: '9 Y Ave, Peoria, IL' }, 'other-secret'), 403);
eq('nothing written by refused calls', shown(2), '12 X St, Peoria, IL');
eq('adds an exact PROPERTIES address', await post({ row: 2, phone: '+15555550101', address: '9 Y Ave, Peoria, IL' }), 200);
eq('appended, existing kept', shown(2), '12 X St, Peoria, IL | 9 Y Ave, Peoria, IL');
eq('same address again: no duplicate', [await post({ row: 2, phone: '+15555550101', address: '9 Y Ave, Peoria, IL' }), shown(2)], [200, '12 X St, Peoria, IL | 9 Y Ave, Peoria, IL']);
eq('an address not on PROPERTIES is refused', [await post({ row: 3, phone: '+15555550102', address: '9 Y Ave' }), shown(3)], [422, '']);
eq('phone does not match the row: refused (row shifted)', [await post({ row: 3, phone: '+15555550101', address: '9 Y Ave, Peoria, IL' }), shown(3)], [409, '']);
eq("a differently formatted phone in the Sheet still matches", [await post({ row: 3, phone: '+15555550102', address: '12 X St, Peoria, IL' }), shown(3)], [200, '12 X St, Peoria, IL']);
moveColumn(sheet.tabs[LOGINS_GID], sheet.tabs[LOGINS_GID].rows[0].indexOf('Shown Properties'), 2);
eq('follows the column tag when Aaron moves the column', [await post({ row: 3, phone: '+15555550102', address: '9 Y Ave, Peoria, IL' }), shown(3)], [200, '12 X St, Peoria, IL | 9 Y Ave, Peoria, IL']);
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);

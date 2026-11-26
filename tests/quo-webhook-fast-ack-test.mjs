// Guard (2026-11-26): Quo disabled the "instant-approval-phone-confirm" webhook
// after one 11/25 text timed out 8 times (~9.9s each; Quo's limit is 10s). A
// text from a number with no Quo contact made syncBuyerToSheet walk every
// contact page before the reply. The webhook must answer at once and do the
// work in ctx.waitUntil. Here Sheets and Quo never answer at all: the reply
// must still come back fast, signed requests only.
import worker from '../admin/worker.js';
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++; };
globalThis.fetch = () => new Promise(() => {}); // every outside call hangs forever
const secret = Buffer.from('test-secret-bytes').toString('base64');
async function signed(body) {
  const ts = String(Date.now());
  const key = await crypto.subtle.importKey('raw', Buffer.from(secret, 'base64'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${JSON.stringify(body)}`))).toString('base64');
  return new Request('https://x.workers.dev/quo-webhook', { method: 'POST', headers: { 'openphone-signature': `hmac;1;${ts};${sig}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const env = { QUO_WEBHOOK_SECRET: secret, TELEGRAM_BOT_TOKEN: '' };
const body = { type: 'message.received', data: { object: { from: '+15555550123', text: 'YES' } } };
const waited = [];
const ctx = { waitUntil: (p) => waited.push(p), passThroughOnException() {} };
const t0 = Date.now();
const res = await Promise.race([worker.fetch(await signed(body), env, ctx), new Promise((r) => setTimeout(() => r(null), 2000))]);
const ms = Date.now() - t0;
check(res && res.status === 200, `answers 200 while Sheets/Quo hang (status ${res?.status})`);
check(ms < 500, `answers in ${ms}ms (Quo allows 10,000)`);
check(waited.length >= 1, 'the work is handed to ctx.waitUntil');
const bad = await worker.fetch(new Request('https://x.workers.dev/quo-webhook', { method: 'POST', headers: { 'openphone-signature': 'hmac;1;1;nope' }, body: JSON.stringify(body) }), env, ctx);
check(bad.status === 401, `unsigned request still refused (${bad.status})`);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

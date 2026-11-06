// Offline tests for the site's sign-in gate: /send-login-code,
// /verify-login-code and the visitor session (lessons L69, 2026-10-26).
// Run: node tests/login-gate-test.mjs   (scripts/deploy-worker.sh runs it too)
//
// Drives the real admin/worker.js through its default export. Nothing here can
// reach a real service: every env value is fake, and the fetch below THROWS on
// any host it doesn't know. No Sheet is read, no buyer is texted.
// This repo is public: fake data only (555 numbers, example.com addresses).
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker from '../admin/worker.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const ON_FILE = '+16185550101'; // Pat's real number, in this story
const TYPO = '+17435550101'; // what a mistyped first sign-in looks like
const OTHER_TYPO = '+17435550102';
const STRANGER = '+16185550199';
const EMAIL = 'pat@example.com';

const HEADERS = ['Row', 'Email', 'Unused', 'Phone', 'Name'];

// A fresh fake world per test: App: Logins, Login Codes, and what got sent.
function world({ logins, telegramDown = false, kvDown = false } = {}) {
  const w = {
    // Columns B:E of App: Logins: Email, (C), Phone, Name.
    logins: logins || [[EMAIL, '', ON_FILE, 'Pat Example']],
    codes: [['Phone', 'Code Hash', 'Expires At', 'Attempts', 'Last Sent At', 'Sends In Window', 'Window Start']],
    texts: [],
    pings: [],
    sheetWrites: [],
    kv: new Map(),
  };
  w.env = {
    INTERNAL_TOOLS_SECRET: 'fake-secret-for-tests',
    GCP_SA_EMAIL: 'fake@example.com',
    GCP_SA_PRIVATE_KEY: PEM,
    TELEGRAM_BOT_TOKEN: 'fake-bot',
    QUO_API_KEY: 'fake-quo',
    BUYERS_KV: {
      get: async (k) => { if (kvDown) throw new Error('kv down'); return w.kv.get(k) ?? null; },
      put: async (k, v) => { if (kvDown) throw new Error('kv down'); w.kv.set(k, v); },
    },
  };
  w.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'fake-access' });
    if (url.hostname === 'api.telegram.org') {
      if (telegramDown) throw new Error('telegram down');
      w.pings.push(JSON.parse(init.body).text);
      return json({ ok: true });
    }
    if (url.hostname === 'api.quo.com' && url.pathname === '/v1/messages' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      w.texts.push({ to: body.to, content: body.content });
      return json({ data: { id: 'fake' } });
    }
    if (url.hostname === 'sheets.googleapis.com') {
      const range = decodeURIComponent(url.pathname.split('/values/')[1] || '');
      if ((init.method || 'GET') === 'PUT') {
        w.sheetWrites.push(range);
        const m = range.match(/^Login Codes!A(\d+):G\d+$/);
        if (!m) throw new Error(`test: unexpected Sheet write to ${range}`);
        w.codes[Number(m[1]) - 1] = JSON.parse(init.body).values[0];
        return json({});
      }
      if (range === 'App: Logins!D:D') return json({ values: [[HEADERS[3]], ...w.logins.map((r) => [r[2]])] });
      if (range === 'App: Logins!B:E') return json({ values: [HEADERS.slice(1), ...w.logins] });
      if (range === 'Login Codes!A:G') return json({ values: w.codes });
      throw new Error(`test: unexpected Sheet read of ${range}`);
    }
    throw new Error(`test: refused network call to ${url.hostname}${url.pathname}`);
  };
  return w;
}

async function post(w, path, body, headers = {}) {
  globalThis.fetch = w.fetch;
  const res = await worker.fetch(new Request(`https://worker.example.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }), w.env);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const sendCode = (w, phone, email) => post(w, '/send-login-code', { phone, email });
const verify = (w, phone, code) => post(w, '/verify-login-code', { phone, code });
const codeIn = (text) => text.content.match(/\b(\d{6})\b/)[1];
const wrong = (code) => (code === '000000' ? '000001' : '000000');

// --- The harness itself (a test only counts if it can fail) ---
{
  const w = world();
  let refused = false;
  try { await w.fetch('https://real-service.example.org/anything'); } catch (e) { refused = /refused network call/.test(e.message); }
  check('harness: an unknown host is refused, not reached', refused);
}

// --- Phone mismatch (L69) ---
{
  const w = world();
  const before = JSON.stringify(w.logins);
  const r = await sendCode(w, TYPO, EMAIL);
  eq('mismatch: 409', r.status, 409);
  eq('mismatch: its own error, not the generic one', r.body.error, 'phone mismatch');
  check('mismatch: tells them the email is on a different number', /on file with a different phone number/.test(r.body.message || ''), r.body.message);
  check('mismatch: never says "fill in the form" (the 10/26 loop)', !/fill in the form/i.test(r.body.message || ''), r.body.message);
  check('mismatch: the message never reveals the number on file', !(r.body.message || '').includes('0101') && !JSON.stringify(r.body).includes(ON_FILE));
  eq('mismatch: one ping to Aaron', w.pings.length, 1);
  check('mismatch: the ping names both numbers', w.pings[0]?.includes(TYPO) && w.pings[0]?.includes(ON_FILE), w.pings[0]);
  eq('mismatch: nobody is texted', w.texts.length, 0);
  eq('mismatch: nothing written to the Sheet', w.sheetWrites.length, 0);
  eq('mismatch: the phone on file is not swapped', JSON.stringify(w.logins), before);

  const again = await sendCode(w, TYPO, EMAIL);
  eq('mismatch retry: still the clear 409', again.status, 409);
  eq('mismatch retry: no second ping for the same number', w.pings.length, 1);

  await sendCode(w, OTHER_TYPO, EMAIL);
  eq('mismatch: a different typed number pings once more', w.pings.length, 2);
}
{
  const w = world();
  const r = await sendCode(w, TYPO, '  PAT@Example.COM ');
  eq('mismatch: email match ignores case and spaces', r.status, 409);
}
{
  const w = world({ telegramDown: true });
  const r = await sendCode(w, TYPO, EMAIL);
  eq('mismatch: Telegram down, the visitor still gets the clear message', r.status, 409);
}
{
  const w = world({ kvDown: true });
  const r = await sendCode(w, TYPO, EMAIL);
  eq('mismatch: KV down, the visitor still gets the clear message', r.status, 409);
}

// --- Controls: the same path must NOT call these a mismatch ---
{
  const w = world();
  const r = await sendCode(w, STRANGER, 'nobody@example.com');
  eq('control: unknown phone and email -> 404', r.status, 404);
  check('control: unknown visitor is told to fill in the form', /fill in the form/i.test(r.body.message || ''), r.body.message);
  eq('control: unknown visitor pings nobody', w.pings.length, 0);
  eq('control: unknown visitor texts nobody', w.texts.length, 0);
}
{
  const w = world();
  eq('control: no email sent -> 404, not a mismatch', (await sendCode(w, TYPO, '')).status, 404);
  eq('control: no email sent pings nobody', w.pings.length, 0);
}
{
  const w = world({ logins: [[EMAIL, '', '', 'Pat Example']] });
  eq('control: email on a row with no phone -> 404', (await sendCode(w, TYPO, EMAIL)).status, 404);
  eq('control: blank phone on file pings nobody', w.pings.length, 0);
}
{
  const w = world();
  const r = await sendCode(w, ON_FILE, EMAIL);
  eq('control: the right phone -> 200', r.status, 200);
  eq('control: the right phone gets exactly one text', w.texts.length, 1);
  eq('control: the text goes to the number on file', w.texts[0]?.to, [ON_FILE]);
  eq('control: the right phone pings nobody', w.pings.length, 0);
}
{
  const w = world();
  const r = await sendCode(w, '(618) 555-0101', 'someone-else@example.com');
  eq('a phone on file wins, whatever email came with it', r.status, 200);
  eq('...and the code goes only to that phone', w.texts[0]?.to, [ON_FILE]);
}

// --- The code itself ---
{
  const w = world();
  await sendCode(w, ON_FILE, EMAIL);
  const code = codeIn(w.texts[0]);
  check('the code is stored only as a hash', !JSON.stringify(w.codes).includes(code));
  const r = await verify(w, ON_FILE, code);
  eq('right code -> 200', r.status, 200);
  check('right code -> a session token', !!r.body.token);
  eq('the hash is cleared after use (the real proof of entry)', w.codes[1][1], '');
  eq('a code works only once', (await verify(w, ON_FILE, code)).status, 400);
}
{
  const w = world();
  await sendCode(w, ON_FILE, EMAIL);
  const code = codeIn(w.texts[0]);
  eq('wrong code -> 400', (await verify(w, ON_FILE, wrong(code))).status, 400);
  eq('wrong code counts one attempt', w.codes[1][3], '1');
  eq('the right code still works after one miss', (await verify(w, ON_FILE, code)).status, 200);
}
{
  const w = world();
  await sendCode(w, ON_FILE, EMAIL);
  const code = codeIn(w.texts[0]);
  for (let i = 0; i < 5; i++) await verify(w, ON_FILE, wrong(code));
  const r = await verify(w, ON_FILE, code);
  eq('after 5 misses even the right code is refused', r.body.error, 'too many attempts');
}
{
  const w = world();
  await sendCode(w, ON_FILE, EMAIL);
  const code = codeIn(w.texts[0]);
  w.codes[1][2] = new Date(Date.now() - 1000).toISOString();
  eq('an expired code is refused', (await verify(w, ON_FILE, code)).body.error, 'expired');
}
{
  const w = world({ logins: [[EMAIL, '', ON_FILE, 'Pat Example'], ['lee@example.com', '', STRANGER, 'Lee Example']] });
  await sendCode(w, ON_FILE, EMAIL);
  const code = codeIn(w.texts[0]);
  // Lee's row holds Pat's exact hash, so only the phone inside the hash can
  // tell them apart. Without a code row this would fail for the wrong reason.
  w.codes.push([STRANGER, ...w.codes[1].slice(1)]);
  eq("one phone's code doesn't open another phone", (await verify(w, STRANGER, code)).body.error, 'wrong code');
}

// --- Send limits ---
{
  const w = world();
  await sendCode(w, ON_FILE, EMAIL);
  const r = await sendCode(w, ON_FILE, EMAIL);
  eq('a second request within 30 seconds -> 429', r.status, 429);
  eq('...and no second text', w.texts.length, 1);
}
{
  const w = world();
  await sendCode(w, ON_FILE, EMAIL);
  w.codes[1][4] = new Date(Date.now() - 60 * 1000).toISOString();
  eq('after the 30 second gap a resend works (control)', (await sendCode(w, ON_FILE, EMAIL)).status, 200);
  eq('...and texts again', w.texts.length, 2);
  w.codes[1][4] = new Date(Date.now() - 60 * 1000).toISOString();
  w.codes[1][5] = '5';
  const r = await sendCode(w, ON_FILE, EMAIL);
  eq('the 6th send in an hour -> refused', r.body.error, 'too many codes');
  eq('...and no text', w.texts.length, 2);
}

// --- Visitor session ---
{
  // Lee is a real second buyer, so a forged session for Lee can only be stopped
  // by the signature. The blank-phone row is there so an empty session phone
  // can't quietly match it.
  const w = world({ logins: [[EMAIL, '', ON_FILE, 'Pat Example'], ['lee@example.com', '', STRANGER, 'Lee Example'], ['old@example.com', '', '', 'No Phone Yet']] });
  await sendCode(w, ON_FILE, EMAIL);
  const { body } = await verify(w, ON_FILE, codeIn(w.texts[0]));
  const session = (token) => ({ 'X-IAH-Session': token });

  eq('a personal endpoint with no session -> 401', (await post(w, '/id-photo', { phone: ON_FILE })).status, 401);
  eq('a made-up session -> 401', (await post(w, '/id-photo', { phone: ON_FILE }, session('abc.def'))).status, 401);

  const [payload, sig] = body.token.split('.');
  const forged = Buffer.from(JSON.stringify({ p: STRANGER, exp: Date.now() + 1e9 })).toString('base64url');
  const stillGate = (r) => r.body.error === 'session required';
  const gated = (headers) => post(w, '/id-photo', { phone: STRANGER }, headers).catch((e) => ({ status: 'past gate', body: { error: e.message } }));
  check("a session rewritten to another buyer's phone is stopped by the gate", stillGate(await gated(session(`${forged}.${sig}`))));
  check('no session, with a blank-phone row on the sheet: stopped by the gate', stillGate(await gated({})));
  check('(the forged payload really differs)', forged !== payload);

  // Control: a real session gets past the gate. Whatever /id-photo does next,
  // it isn't the gate's 401.
  const passed = await post(w, '/id-photo', { phone: ON_FILE }, session(body.token)).catch((e) => ({ status: 'past gate', body: { error: e.message } }));
  check('control: a real session passes the gate', passed.body.error !== 'session required', JSON.stringify(passed));

  w.logins[0][2] = '+16185550150';
  check('a session whose row no longer has that phone: stopped by the gate', stillGate(await gated(session(body.token))));
}

// --- The site really sends what the guard needs ---
// The Worker can only spot a mismatch if the page sends the email, and the
// page reads it back from storage, so it must be stored before the send.
{
  const app = readFileSync(fileURLToPath(new URL('../docs/js/app.js', import.meta.url)), 'utf8');
  const fn = app.slice(app.indexOf('async function sendLoginCode'), app.indexOf('function initLoginGate'));
  check('site: sendLoginCode posts the email', /JSON\.stringify\(\{\s*phone,\s*email:\s*localStorage\.getItem\(GATE_EMAIL_STORAGE_KEY\)/.test(fn));
  check("site: the server's message is what the visitor sees", /statusEl\.textContent = data\.message/.test(fn));
  const stored = app.indexOf('localStorage.setItem(GATE_EMAIL_STORAGE_KEY, email)');
  const sent = app.indexOf('await sendLoginCode(phone, status)');
  check('site: the email is stored before the first send', stored !== -1 && sent !== -1 && stored < sent);
}

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

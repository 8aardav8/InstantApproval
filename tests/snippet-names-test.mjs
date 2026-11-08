// Saving a snippet's name on the Text Templates page (/admin/set-text-template).
// Run: node tests/snippet-names-test.mjs   (scripts/deploy-worker.sh runs it too)
// 2026-11-08, Aaron: "I also wanted to be able to update the names of the
// snippets". Only snippet_ rows get a name write; appointment templates'
// labels never change. Fake services only; any unknown host throws.
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../admin/worker.js';

let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const src = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
const ADMIN = /const AARON_EMAIL = "([^"]+)"/.exec(src)[1];
const CLIENT = /const OAUTH_CLIENT_ID = "([^"]+)"/.exec(src)[1];
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM };

async function save(body) {
  const writes = {};
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/tokeninfo') return json({ aud: CLIENT, email: ADMIN, email_verified: 'true' });
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'fake' });
    if (url.hostname === 'sheets.googleapis.com') {
      const range = decodeURIComponent(url.pathname.split('/values/')[1] || '');
      if (init.method === 'PUT') { writes[range] = JSON.parse(init.body).values[0][0]; return json({}); }
      if (range === "'Text Templates'!A:A") return json({ values: [['Key'], ['day_of_reminder'], ['snippet_checking-in']] });
    }
    throw new Error(`test: refused ${url.hostname}${url.pathname}`);
  };
  const res = await worker.fetch(new Request('https://worker.example.com/admin/set-text-template', { method: 'POST', headers: { Authorization: 'Bearer fake', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json(), writes };
}

let r = await save({ key: 'snippet_checking-in', text: 'Hi {{name}}', label: 'Snippet: Quick hello' });
eq('snippet: name and text saved', [r.status, r.body.labelSaved, r.writes["'Text Templates'!B3:B3"], r.writes["'Text Templates'!C3:C3"]], [200, true, 'Snippet: Quick hello', 'Hi {{name}}']);
r = await save({ key: 'snippet_checking-in', text: 'x', label: 'Quick hello' });
eq('name without the prefix still gets it', r.writes["'Text Templates'!B3:B3"], 'Snippet: Quick hello');
r = await save({ key: 'snippet_checking-in', text: 'x', label: 'Snippet:  ' });
eq('blank name refused, nothing written', [r.status, Object.keys(r.writes).length], [400, 0]);
r = await save({ key: 'day_of_reminder', text: 'Reminder', label: 'Snippet: Hijack' });
eq('appointment template label never changes', [r.status, r.body.labelSaved, "'Text Templates'!B2:B2" in r.writes], [200, false, false]);
r = await save({ key: 'snippet_checking-in', text: 'only text' });
eq('text-only save leaves the name alone', [r.status, r.body.labelSaved, Object.keys(r.writes).some((k) => k.includes('!B'))], [200, false, false]);

console.log(`\n${fail} failed`);
process.exit(fail ? 1 : 0);

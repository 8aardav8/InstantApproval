// Offline test for "Browse existing IDs" (/admin/browse-id-photos).
// Run: node tests/browse-ids-test.mjs   (scripts/deploy-worker.sh runs it too)
//
// Real incident, 2026-11-08: the browse panel showed "Couldn't load: server
// error". The ID Link column read included its own header cell ("ID Link"),
// which isn't a file-id ref, so the handler believed old share-link refs
// still existed and made one Dropbox call per unlinked file -- 65 of them,
// past the Workers free plan's 50-subrequest cap.
//
// Drives the real admin/worker.js with fake services only. Any unknown host
// throws. This repo is public: fake data only.
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../admin/worker.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); }
}

const src = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
const ADMIN = /const AARON_EMAIL = "([^"]+)"/.exec(src)[1];
const CLIENT = /const OAUTH_CLIENT_ID = "([^"]+)"/.exec(src)[1];
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const CAP = 50; // Workers free plan: subrequests per invocation

function world({ linked = 55, total = 120, legacyRefs = 0 } = {}) {
  const files = Array.from({ length: total }, (_, i) => ({ '.tag': 'file', id: `id:file${i}`, name: `Example, Pat${i} - 0101.jpg`, path_display: `/ids/Example, Pat${i} - 0101.jpg` }));
  const refs = files.slice(0, linked).map((f) => [f.id]);
  for (let i = 0; i < legacyRefs; i++) refs.push([`https://links.example.com/scl/fi/legacy${i}/x.jpg?rlkey=fake`]);
  const w = { calls: 0, sharedLinkCalls: 0 };
  w.env = {
    GCP_SA_EMAIL: 'fake@example.com', GCP_SA_PRIVATE_KEY: PEM,
    DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's', DROPBOX_REFRESH_TOKEN: 'r',
  };
  w.fetch = async (input, init = {}) => {
    w.calls++;
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/tokeninfo') return json({ aud: CLIENT, email: ADMIN, email_verified: 'true' });
    if (url.hostname === 'oauth2.googleapis.com' || url.hostname === 'api.dropboxapi.com' && url.pathname === '/oauth2/token') return json({ access_token: 'fake' });
    if (url.hostname === 'sheets.googleapis.com') {
      const range = decodeURIComponent(url.pathname.split('/values/')[1] || '');
      if (range === 'App: Logins!F:F') return json({ values: [['ID Link'], ...refs] });
      if (range === "'ID OCR Cache'!A:D") return json({ values: [['File ID', 'File Name', 'OCR Text', 'ID Name']] });
      throw new Error(`test: unexpected Sheet read of ${range}`);
    }
    if (url.hostname === 'api.dropboxapi.com' && url.pathname === '/2/files/list_folder') return json({ entries: files.slice(0, 100), has_more: true, cursor: 'c' });
    if (url.hostname === 'api.dropboxapi.com' && url.pathname === '/2/files/list_folder/continue') return json({ entries: files.slice(100), has_more: false });
    if (url.hostname === 'api.dropboxapi.com' && url.pathname === '/2/sharing/list_shared_links') { w.sharedLinkCalls++; return json({ links: [] }); }
    throw new Error(`test: refused network call to ${url.hostname}${url.pathname}`);
  };
  return w;
}

async function browse(w) {
  globalThis.fetch = w.fetch;
  const res = await worker.fetch(new Request('https://worker.example.com/admin/browse-id-photos', { headers: { Authorization: 'Bearer fake-id-token' } }), w.env);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

{
  const w = world();
  const r = await browse(w);
  check('120 files, 55 linked: browse succeeds', r.status === 200, `status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  check('lists exactly the 65 unlinked files', (r.body.files || []).length === 65, `got ${(r.body.files || []).length}`);
  check('header cell is not mistaken for an old share link', w.sharedLinkCalls === 0, `${w.sharedLinkCalls} share-link calls`);
  check(`stays under the ${CAP}-call cap`, w.calls < CAP, `${w.calls} calls`);
}
{
  const w = world({ total: 300, linked: 100 });
  const r = await browse(w);
  check('a much bigger folder still stays under the cap', r.status === 200 && w.calls < CAP, `status ${r.status}, ${w.calls} calls`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

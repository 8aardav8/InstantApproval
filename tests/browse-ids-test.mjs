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
  const files = Array.from({ length: total }, (_, i) => ({ '.tag': 'file', id: `id:file${i}`, name: `Example, Pat${i} - 0101.jpg`, path_display: `/ids/Example, Pat${i} - 0101.jpg`, server_modified: new Date(Date.UTC(2026, 0, 1) + ((i * 37) % total) * 86400000).toISOString() }));
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
  const dates = (r.body.files || []).map((f) => f.date);
  check('newest first (2026-11-19)', dates.length > 1 && dates.every((d, i) => i === 0 || dates[i - 1] >= d), dates.slice(0, 4).join(', '));
}
{
  const w = world({ total: 300, linked: 100 });
  const r = await browse(w);
  check('a much bigger folder still stays under the cap', r.status === 200 && w.calls < CAP, `status ${r.status}, ${w.calls} calls`);
}

// Linking from the browse panel reuses the OCR watcher's name for the file
// (2026-11-08: Velvia Foree's ID Name stayed blank after a manual link).
{
  const writes = [];
  const w = world();
  const base = w.fetch;
  w.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'sheets.googleapis.com') {
      const range = decodeURIComponent(url.pathname.split('/values/')[1] || '');
      if (range === "'ID OCR Cache'!A:D") return json({ values: [['File ID', 'File Name', 'OCR Text', 'ID Name'], ['id:file7', 'x.jpg', '1 EXAMPLE', 'Pat Example']] });
      if (range === 'App: Logins!D:D') return json({ values: [['Phone'], ['+16185550123']] });
      if (url.pathname.endsWith(':batchGet')) return json({ valueRanges: [{}, {}, {}, {}] });
      if (init.method === 'PUT' || url.pathname.includes(':batchUpdate')) { writes.push(`${range} ${init.body || ''}`); return json({}); }
      return json({ values: [] });
    }
    if (url.hostname === 'api.dropboxapi.com' && url.pathname === '/2/files/get_metadata') return json({ id: 'id:file7' });
    if (url.hostname === 'api.dropboxapi.com' && url.pathname === '/2/files/move_v2') return json({ metadata: { path_display: '/ids/Example, Pat - 0123.jpg' } });
    if (url.hostname === 'api.quo.com') return json({ data: [] });
    return base(input, init);
  };
  globalThis.fetch = w.fetch;
  const res = await worker.fetch(new Request('https://worker.example.com/confirm-id-match', { method: 'POST', headers: { Authorization: 'Bearer fake', 'Content-Type': 'application/json' }, body: JSON.stringify({ dropboxPath: '/ids/Example, Pat0 - 0101.jpg', buyerPhone: '+16185550123', buyerName: 'Pat Example ESTL TB' }) }), { ...w.env, QUO_API_KEY: 'fake' });
  const body = await res.json().catch(() => ({}));
  check('manual link succeeds', res.status === 200 && body.ok, `status ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  check('manual link fills ID Name from the OCR cache', writes.some((x) => x.includes('Pat Example') && /AG|ID Name/.test(x)), writes.join(' || ').slice(0, 300));
  check('renamed without the area tag', (body.renamedTo || '').endsWith('/Example, Pat - 0123.jpg'), body.renamedTo);
}

// Edit name / expiration from the ID panel (2026-11-19).
const IDS = /const DROPBOX_IDS_FOLDER = "([^"]+)"/.exec(src)[1];
function editWorld({ linkedTo = null, conflict = false } = {}) {
  const w = world(); const base = w.fetch; w.moves = []; w.writes = [];
  w.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'api.dropboxapi.com' && url.pathname === '/2/files/get_metadata') return json({ id: 'id:file9' });
    if (url.hostname === 'api.dropboxapi.com' && url.pathname === '/2/files/move_v2') {
      if (conflict) return json({ error_summary: 'to/conflict/file/' }, 409);
      const b = JSON.parse(init.body); w.moves.push(b); return json({ metadata: { path_display: b.to_path } });
    }
    if (url.hostname === 'sheets.googleapis.com') {
      const range = decodeURIComponent(url.pathname.split('/values/')[1] || '');
      if (range === "'ID OCR Cache'!A:A") return json({ values: [['File ID'], ['id:file3'], ['id:file9']] });
      if (range === 'App: Logins!F:F') return json({ values: [['ID Link'], ['id:x'], [linkedTo || 'id:y']] });
      if (url.pathname.endsWith('/values:batchUpdate')) { w.writes.push(JSON.parse(init.body).data); return json({}); }
    }
    return base(input, init);
  };
  return w;
}
async function edit(w, body) {
  globalThis.fetch = w.fetch;
  const res = await worker.fetch(new Request('https://worker.example.com/admin/edit-id-file', { method: 'POST', headers: { Authorization: 'Bearer fake', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), w.env);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
{
  const w = editWorld();
  const r = await edit(w, { path: `${IDS}/IMG_4411 - 0123.jpg`, name: 'Pat Q Example', exp: '2030-05-07' });
  check('edit succeeds', r.status === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 200));
  check('file renamed to "Last, First - 1234 - exp date"', w.moves[0] && w.moves[0].to_path === `${IDS}/Example, Pat Q - 0123 - exp 2030-05-07.jpg`, JSON.stringify(w.moves[0]));
  check('renamed by file id (stable)', w.moves[0] && w.moves[0].from_path === 'id:file9');
  const ocr = (w.writes[0] || []).map((d) => `${d.range}=${JSON.stringify(d.values)}`).join(' ');
  check('OCR record name updated in its own row', /'ID OCR Cache'!D3:E3=\[\["Pat Q Example"/.test(ocr), ocr);
  check('no buyer linked: no buyer row written', w.writes.length === 1 && r.body.linkedRows.length === 0, JSON.stringify(w.writes).slice(0, 200));
}
{
  const w = editWorld({ linkedTo: 'id:file9' });
  const r = await edit(w, { path: `${IDS}/Example, P - 0123.jpg`, name: 'Example, Pat', exp: 'lifetime' });
  const buyer = JSON.stringify(w.writes[1] || []);
  check('linked buyer gets the new ID Name and ID Exp', r.body.linkedRows?.[0] === 3 && buyer.includes('"Pat Example"') && buyer.includes('"lifetime"'), buyer.slice(0, 300));
}
{
  const r1 = await edit(editWorld(), { path: '/Other/folder/x.jpg', name: 'Pat Example', exp: '' });
  check('refuses a file outside Buyer IDs', r1.status === 400);
  const r2 = await edit(editWorld(), { path: `${IDS}/x.jpg`, name: 'a/b', exp: '' });
  check('refuses a name with a slash', r2.status === 400);
  const r3 = await edit(editWorld(), { path: `${IDS}/x.jpg`, name: 'Pat Example', exp: '05/07/2030' });
  check('refuses a non-date expiry', r3.status === 400);
  const r4 = await edit(editWorld({ conflict: true }), { path: `${IDS}/x.jpg`, name: 'Pat Example', exp: '' });
  check('name already taken: clear message, nothing else written', r4.status === 409 && /already named/.test(r4.body.error));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

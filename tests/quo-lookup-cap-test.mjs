// Guard (2026-11-19): Quo contact lookups must be able to walk the whole contact list.
// The old 40-page (2,000 contact) stop was a free-plan workaround; with 2,919 contacts it
// left ~900 unfindable, and quoUpsertContact made duplicates for them. Runs the real
// quoFindContactByPhone against a fake Quo with 3,000 contacts, the match on the last page.
import { readFileSync } from 'fs';
const src = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const cap = Number(src.match(/const QUO_CONTACT_MAX_PAGES = (\d+);/)?.[1]);
check(cap >= 100, `QUO_CONTACT_MAX_PAGES is ${cap} (needs >= 100)`);
check(!/quoMaxPages = \d+|maxPages = \d+|MAX_PAGES_PER_CALL = \d+/.test(src), 'no lookup has its own hard-coded page limit');
// Pull the two functions out and run them against a fake Quo.
const grab = (name) => { const i = src.indexOf(`async function ${name}(`); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } };
const N = 3000, target = '+15550002999';
let calls = 0;
globalThis.fetch = async (url) => { calls++; const u = new URL(url); const start = Number(u.searchParams.get('pageToken') || 0);
  const data = Array.from({ length: Math.min(50, N - start) }, (_, i) => ({ id: `c${start + i}`, defaultFields: { phoneNumbers: [{ value: `+1555000${String(start + i).padStart(4, '0')}` }] } }));
  return { status: 200, ok: true, json: async () => ({ data, nextPageToken: start + 50 < N ? String(start + 50) : null }) }; };
const fn = new Function('QUO_CONTACT_MAX_PAGES', `const QUO_BASE = 'https://api.openphone.com/v1'; ${grab('quoCall')} ${grab('quoFindContactByPhone')} return quoFindContactByPhone;`)(cap);
const found = await fn({ QUO_API_KEY: 'x' }, target);
check(found?.id === 'c2999', `contact #3,000 found (got ${found?.id}, ${calls} pages)`);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

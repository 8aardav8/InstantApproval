// Buyer-page message snippets: which ones are suggested, and how they fill in.
// Run: node tests/snippets-test.mjs. Fake buyers only (public repo).
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const block = (start, end) => { const i = src.indexOf(start); return src.slice(i, src.indexOf(end, i) + end.length); };
const code = [block('const MESSAGE_SNIPPETS = [', '\n];\n'), block('function buyerSnippetContext(', '\n}\n'), block('function fillSnippet(', '\n}\n')].join('\n');
const { MESSAGE_SNIPPETS, buyerSnippetContext, fillSnippet } = new Function(`${code}; return { MESSAGE_SNIPPETS, buyerSnippetContext, fillSnippet };`)();
let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };
const TODAY = '2026-11-08';
const ids = (buyer, lm) => { const c = buyerSnippetContext(buyer, lm, TODAY); return MESSAGE_SNIPPETS.filter((s) => s.when(c)).map((s) => s.id); };
eq('brand-new lead: ID + see homes', ids({}, null), ['send-id', 'see-homes']);
eq('texted a photo, no ID linked', ids({ possibleIdImages: ['x'] }, { lastLogin: '2026-11-01' }), ['id-photo-again', 'want-a-viewing']);
eq('ID expiring in 10 days', ids({}, { idLink: 'id:x', idExp: '2026-11-18', lastLogin: 'x' }), ['new-id', 'want-a-viewing']);
eq('ID expired already', ids({}, { idLink: 'id:x', idExp: '2026-10-01', lastLogin: 'x' }).includes('new-id'), true);
eq('ID fine, viewing booked', ids({}, { idLink: 'id:x', idExp: '2029-01-01', lastLogin: 'x', appointments: [{ date: '2026-11-10', address: '1 Example St', status: 'Scheduled' }] }), ['viewing-reminder']);
eq('past or canceled viewing is not "next"', ids({}, { idLink: 'id:x', lastLogin: 'x', appointments: [{ date: '2026-11-01', status: 'Completed' }, { date: '2026-11-12', status: 'Canceled' }] }), ['want-a-viewing']);
const c = buyerSnippetContext({}, { idLink: 'id:x', idExp: '2026-11-18', appointments: [{ date: '2026-11-10', address: '1 Example St', status: 'Scheduled' }] }, TODAY);
eq('fills name, expiry, address, date', fillSnippet('{name}|{exp}|{address}|{date}', 'Pat', c), 'Pat|Wed, Nov 18|1 Example St|Tue, Nov 10');
eq('unknown name falls back', fillSnippet('Hi {name}', '', c), 'Hi there');
eq('every snippet fills with no leftover tokens', MESSAGE_SNIPPETS.every((s) => !/\{[a-z]+\}/.test(fillSnippet(s.text, 'Pat', c))), true);
eq('Text Templates style {{name}} works too', fillSnippet('Hi {{name}}, see {{address}}', 'Pat', c), 'Hi Pat, see 1 Example St');
console.log(`\n${fail} failed`);
process.exit(fail ? 1 : 0);

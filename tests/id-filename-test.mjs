// ID photo filenames: person's name only, never a Quo area tag.
// Run: node tests/id-filename-test.mjs   (scripts/deploy-worker.sh runs it too)
// Real incident 2026-11-08: "Velvia S Foree ESTL TB" produced "ESTL, Velvia Foree".
// Fake people only (public repo).
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
const grab = (start) => { const i = src.indexOf(start); const j = src.indexOf('\n}\n', i); return src.slice(i, j + 3); };
const code = [grab('const ID_NAME_TAG_WORDS'), grab('function personNameFromQuoName'), grab('function buildIdFilename')].join('\n');
const { buildIdFilename } = new Function(`${code}; return { buildIdFilename };`)();
let fail = 0;
const eq = (name, got, want) => { if (got === want) console.log(`PASS ${name}`); else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };
const P = '+16185550123';
eq('area + TB tags', buildIdFilename('Pat Q Example ESTL TB', P, 'x.jpg'), 'Example, Pat Q - 0123.jpg');
eq('STL TB', buildIdFilename('Pat Example STL TB', P, 'x.jpeg'), 'Example, Pat - 0123.jpeg');
eq('two-word area', buildIdFilename('Pat Example Little Rock TB', P, 'x.png'), 'Example, Pat - 0123.png');
eq('East St Louis spelled out', buildIdFilename('Pat Example East St Louis TB', P, 'x.jpg'), 'Example, Pat - 0123.jpg');
eq('Filler label', buildIdFilename('Pat Example Filler FAM1', P, 'x.jpg'), 'Example, Pat - 0123.jpg');
eq('plain name untouched', buildIdFilename('Pat Example', P, 'x.jpg'), 'Example, Pat - 0123.jpg');
eq('suffix stays with first name', buildIdFilename('Pat Example 3rd STL TB', P, 'x.jpg'), 'Example, Pat 3rd - 0123.jpg');
eq('Jr suffix', buildIdFilename('Pat Example Jr', P, 'x.jpg'), 'Example, Pat Jr - 0123.jpg');
eq('all-caps name keeps two words', buildIdFilename('PAT EXAMPLE TB', P, 'x.jpg'), 'EXAMPLE, PAT - 0123.jpg');
eq('never empties a name', buildIdFilename('ESTL TB', P, 'x.jpg'), 'TB, ESTL - 0123.jpg');
console.log(`\n${fail} failed`);
process.exit(fail ? 1 : 0);

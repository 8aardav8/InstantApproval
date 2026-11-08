// Static guard: only a real Quo message may stamp "Last Activity (Quo)".
// Run: node tests/activity-stamp-test.mjs   (scripts/deploy-worker.sh runs it too)
//
// Real incident, 2026-11-08: admin edits (stage, areas, ID link...) called
// syncBuyerToSheet with touchActivity left at true, so the Buyers list said
// two buyers were last texted at 1:04am, when Aaron had only clicked on them.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
let fail = 0;
const lines = src.split('\n');
let fn = '';
const calls = [];
lines.forEach((l, i) => {
  const m = /^async function (\w+)/.exec(l);
  if (m) fn = m[1];
  if (/syncBuyerToSheet\(/.test(l) && !/^async function syncBuyerToSheet/.test(l)) calls.push({ fn, line: i + 1, text: l.trim() });
});
const def = /async function syncBuyerToSheet\([^)]*touchActivity = (\w+)/.exec(src);
if (!def || def[1] !== 'false') { fail++; console.log('FAIL touchActivity must default to false'); } else console.log('PASS touchActivity defaults to false');
for (const c of calls) {
  const args = c.text.slice(c.text.indexOf('syncBuyerToSheet(') + 17);
  const touches = /^[^,]+,[^,]+,[^,]+,\s*true\b/.test(args);
  const allowed = c.fn === 'handleQuoMessageWebhook';
  if (touches && !allowed) { fail++; console.log(`FAIL line ${c.line} (${c.fn}) stamps activity but isn't a Quo message`); }
  else if (allowed && !touches) { fail++; console.log(`FAIL line ${c.line} the Quo message webhook must stamp activity`); }
  else console.log(`PASS line ${c.line} (${c.fn})`);
}
if (calls.length < 5) { fail++; console.log(`FAIL found only ${calls.length} calls -- the scan is broken`); }
console.log(`\n${calls.length} calls checked, ${fail} failed`);
process.exit(fail ? 1 : 0);

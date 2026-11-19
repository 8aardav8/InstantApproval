// Guard (2026-11-19, lesson L125): App: Logins and other tagged tabs are never
// written with values:append. Google guesses where an appended row starts, and
// on 11/19 it put three buyers' phones 3 columns further right each time, so
// they never reached the Buyers page. New rows go to an explicit row instead.
// Run: node tests/no-append-logins-test.mjs   (scripts/deploy-worker.sh runs it)
import { readFileSync } from 'node:fs';
let fail = 0;
for (const f of ['../admin/worker.js', '../admin/reserve.js']) {
  let src = ''; try { src = readFileSync(new URL(f, import.meta.url), 'utf8'); } catch { continue; }
  src.split('\n').forEach((l, i) => {
    if (!/:append\b/.test(l) || /^\s*\/\//.test(l)) return;
    const tagged = /TABS\.logins|TABS\.props|loginsRowsRange|propsRowsRange|sysRowsRange|span\b/.test(l);
    if (tagged) { fail++; console.log(`FAIL ${f}:${i + 1} appends to a tagged tab: ${l.trim().slice(0, 120)}`); }
  });
}
const src = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('async function appendLoginsRow'), src.indexOf('async function handleSyncVisitor'));
if (/:append/.test(fn.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'))) { fail++; console.log('FAIL appendLoginsRow still uses :append'); } else console.log('PASS appendLoginsRow writes an explicit row');
if (/if \(!row\) return;\s*\/\/ shouldn't happen/.test(src)) { fail++; console.log('FAIL syncBuyerToSheet still reports success when the new row is missing'); } else console.log('PASS a missing new row is an error');
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);

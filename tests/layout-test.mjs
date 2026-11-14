// TASK-000844 guards: columns follow their tags; nothing addresses App: Logins
// or PROPERTIES by a fixed letter or header text. Run: node tests/layout-test.mjs
import { readFileSync } from 'node:fs';
import { resolveLayout, LOGINS_GID, PROPS_GID, LC, PC, APPT, _resetLayoutForTest, refreshLayout, TABS } from '../admin/layout.js';
import { makeSheet } from './iah-fixture.mjs';
import { moveColumn } from './fake-sheets.mjs';
let fail = 0; const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : `: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`}`); };
const metaOf = (sheet) => { const m = []; for (const [gid, t] of Object.entries(sheet.tabs)) for (const [i, ks] of Object.entries(t.tags || {})) for (const k of ks) m.push({ developerMetadata: { metadataKey: k, location: { dimensionRange: { sheetId: +gid, startIndex: +i } } } }); return m; };
const titles = { [LOGINS_GID]: 'App: Logins', [PROPS_GID]: 'PROPERTIES' };

_resetLayoutForTest();
{ const s = makeSheet(); const r = resolveLayout(metaOf(s), titles);
  eq('today: no problems', r.problems, []); eq('today: Stage at AF (31)', r.logins.stage, 31); eq('today: appointments O..X', r.appts, [14,15,16,17,18,19,20,21,22,23]); eq('today: Row ID at 33', r.props.rowid, 33); }
{ const s = makeSheet(); moveColumn(s.tabs[LOGINS_GID], 31, 2); moveColumn(s.tabs[PROPS_GID], 33, 0); const r = resolveLayout(metaOf(s), titles);
  eq('moved: Stage followed to C (2)', r.logins.stage, 2); eq('moved: Email shifted right to 1', r.logins.email, 1); eq('moved: Agreed pushed to 3', r.logins.agreed, 3); eq('moved: Row ID now first', r.props.rowid, 0); eq('moved: Address shifted to 4', r.props.address, 4); }
{ const s = makeSheet(); delete s.tabs[LOGINS_GID].tags[31]; const r = resolveLayout(metaOf(s), titles, { logins: { ...LC, stage: 31 }, appts: APPT.cols, props: PC });
  eq('deleted Stage column: reported', r.problems.some((p) => p.includes('logins.stage')), true); eq('deleted Stage column: keeps last good position', r.logins.stage, 31); }
{ const s = makeSheet(); s.tabs[LOGINS_GID].tags[45] = ['iah.login.phone']; const r = resolveLayout(metaOf(s), titles);
  eq('copied Phone tag: reported', r.problems.some((p) => p.includes('logins.phone tag found 2')), true); }
{ const r = resolveLayout(metaOf(makeSheet()), { [PROPS_GID]: 'PROPERTIES' }); eq('missing Logins tab: reported', r.problems.some((p) => p.includes('App: Logins tab')), true); }
// Renamed tab is followed by gid, end to end through refreshLayout.
{ _resetLayoutForTest(); const s = makeSheet(); s.tabs[LOGINS_GID].title = 'Buyer Logins'; moveColumn(s.tabs[LOGINS_GID], 3, 10);
  globalThis.fetch = async (u, init) => s.handle(new URL(u), init); const alerts = [];
  await refreshLayout({ sheetId: 'x', getToken: async () => 't', alert: async (t) => alerts.push(t) });
  eq('renamed tab followed by gid', TABS.logins, 'Buyer Logins'); eq('moved Phone followed', LC.phone, 10); eq('no alert when all is well', alerts, []); }
// Lookup failure: keep last good layout and alert, never throw.
{ _resetLayoutForTest(); const alerts = [];
  globalThis.fetch = async () => { throw new Error('network down'); };
  await refreshLayout({ sheetId: 'x', getToken: async () => 't', alert: async (t) => alerts.push(t) });
  eq('lookup failure: defaults kept', LC.phone, 3); eq('lookup failure: one alert', alerts.length, 1); }
_resetLayoutForTest();

// Static scan: no fixed letters or header-text lookups for the two tabs.
const src = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8').split('\n');
const bad = src.map((l, i) => [i + 1, l]).filter(([, l]) =>
  /TABS\.(logins|props)\}'?!(?!A\$\{|A:\$\{|A1:BZ1|1:1|\$\{)[A-Z]/.test(l)            // a fixed letter after the tab
  || /\b(LOGINS_TAB|SHEET_TAB)\b/.test(l)                                                // old title constants
  || /headers\.indexOf\("(Address|Deposit Property|Name|Phone|Email|Stage)"\)/.test(l)); // header-text lookups
eq('worker.js: no fixed letters or header lookups for App: Logins / PROPERTIES', bad.map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`), []);
console.log(`\n${fail} failed`); process.exit(fail ? 1 : 0);

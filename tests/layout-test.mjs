// TASK-000844 guards: columns follow their tags; nothing addresses App: Logins
// or PROPERTIES by a fixed letter or header text. Run: node tests/layout-test.mjs
import { readFileSync } from 'node:fs';
import { resolveLayout, LOGINS_GID, PROPS_GID, LC, PC, APPT, _resetLayoutForTest, refreshLayout, TABS, SYS, resolveSys, sysRowsRange, sysRow, sysCellsData, sysAppendRow, sysColRange, sysCell } from '../admin/layout.js';
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

// TASK-000867: system tabs follow their tags and gids too.
{ const s = makeSheet(); const allTitles = Object.fromEntries(Object.entries(s.tabs).map(([g, t]) => [g, t.title]));
  eq('system tabs today: no problems', resolveSys(metaOf(s), allTitles).problems, []); }
{ _resetLayoutForTest(); const s = makeSheet(); const codes = s.tabs[SYS.loginCodes.gid];
  codes.title = 'Codes (system)'; moveColumn(codes, 1, 6); moveColumn(codes, 0, 3);       // Code Hash to the end, Phone to D
  const gate = s.tabs[SYS.gateLog.gid]; moveColumn(gate, 6, 0);                          // Reconciled? first
  s.tabs[SYS.templates.gid].title = 'Templates'; moveColumn(s.tabs[SYS.templates.gid], 2, 0); // Template Text first
  globalThis.fetch = async (u, init) => s.handle(new URL(u), init); const alerts = [];
  await refreshLayout({ sheetId: 'x', getToken: async () => 't', alert: async (t) => alerts.push(t) });
  eq('system tabs moved: no alert', alerts, []);
  eq('renamed Login Codes followed by gid', sysRowsRange('loginCodes'), "'Codes (system)'!A1:G");
  const vals = ['+16185550100', 'HASH', '2026-11-19T08:00:00Z', '0', '2026-11-19T07:50:00Z', '1', '2026-11-19T07:50:00Z'];
  for (const d of sysCellsData('loginCodes', 2, vals)) s.read(d.range); // ranges parse
  const r = await fetch(`https://x/v4/spreadsheets/x/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ data: sysCellsData('loginCodes', 2, vals) }) });
  const back = s.read(sysRowsRange('loginCodes'))[1];
  eq('login code row round trip after moves', sysRow('loginCodes', back), vals);
  eq('Phone landed in the moved Phone column', codes.rows[1][codes.rows[0].indexOf('Phone')], '+16185550100');
  eq('Code Hash landed in the moved Code Hash column', codes.rows[1][codes.rows[0].indexOf('Code Hash')], 'HASH');
  const gateRow = ['2026-11-19T07:00:00Z', 'Pat', 'p@x.com', '6185550100', 'TRUE', 'UA', ''];
  const laid = sysAppendRow('gateLog', gateRow);
  eq('gate log row laid out by tag', [laid[gate.rows[0].indexOf('Name')], laid[gate.rows[0].indexOf('Phone')], laid[gate.rows[0].indexOf('Reconciled?')]], ['Pat', '6185550100', '']);
  eq('templates key column followed', sysColRange('templates', 'key'), "'Templates'!B:B");
  eq('templates text cell followed', sysCell('templates', 'text', 3), "'Templates'!A3:A3");
  void r; }
_resetLayoutForTest();
{ const s = makeSheet(); delete s.tabs[SYS.pendingPhone.gid].tags[2]; const allTitles = Object.fromEntries(Object.entries(s.tabs).map(([g, t]) => [g, t.title]));
  eq('deleted New Phone column: reported', resolveSys(metaOf(s), allTitles).problems.some((p) => p.includes('pendingPhone.newPhone')), true); }

// Static scan: no fixed letters or header-text lookups for the two tabs.
const src = readFileSync(new URL('../admin/worker.js', import.meta.url), 'utf8').split('\n');
const bad = src.map((l, i) => [i + 1, l]).filter(([, l]) =>
  /TABS\.(logins|props)\}'?!(?!A\$\{|A:\$\{|A1:BZ1|1:1|\$\{)[A-Z]/.test(l)            // a fixed letter after the tab
  || /\b(LOGINS_TAB|SHEET_TAB)\b/.test(l)                                                // old title constants
  || /headers\.indexOf\("(Address|Deposit Property|Name|Phone|Email|Stage)"\)/.test(l)  // header-text lookups
  || /(Login Codes|Pending (Phone|Email) Changes|Gate Capture Log|Text Templates)'?!/.test(l)          // TASK-000867: fixed system-tab ranges
  || /\b(LOGIN_CODES_TAB|PENDING_PHONE_TAB|PENDING_EMAIL_TAB|TEXT_TEMPLATES_TAB)\b/.test(l));
eq('worker.js: no fixed letters or header lookups for App: Logins / PROPERTIES / system tabs', bad.map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`), []);
console.log(`\n${fail} failed`); process.exit(fail ? 1 : 0);

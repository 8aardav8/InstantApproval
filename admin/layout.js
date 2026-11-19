// Column positions and tab titles from immutable handles (RULE-000155,
// TASK-000844, Aaron 2026-11-07: "let's default to code using the immutable
// aspects. Sheets rows or columns come to mind").
//
// Every App: Logins and PROPERTIES column carries developer metadata
// (iah.login.<key> / iah.prop.<key>, tagged 2026-11-13). Metadata moves with
// its column, so Aaron can insert, move or rename columns and tabs and the
// code still finds them. Tabs are found by gid, never by title.
//
// One refresh per isolate per minute (refreshLayout, called once at the top
// of fetch() and scheduled()). Everything else reads the module-level
// LC / LL / PC / PL / tab titles synchronously.
//
// Failure policy (RULE-000072, the sign-in gate must survive): if the
// metadata lookup itself fails, keep the last good layout (or the 2026-11-13
// positions on a cold start) and alert Aaron. If a needed tag is missing or
// duplicated (a tagged column was deleted or copied), alert and keep that
// key's last good position.

export const LOGINS_GID = 5432432;
export const PROPS_GID = 1440969658;

// Positions on 2026-11-13, used only until the first successful lookup.
const LOGINS_DEFAULT = {
  firstLogin: 0, email: 1, agreed: 2, phone: 3, name: 4, idLink: 5, lastLogin: 6, filterSort: 7, filterMaxDown: 8,
  filterMaxMonthly: 9, filterMinBeds: 10, filterAreas: 11, lastSearch: 12, quoLink: 13, favorites: 24, coBuyer1: 25,
  coBuyer2: 26, shown: 27, viewed: 28, manualAreaOverride: 29, sentiment: 30, stage: 31, idName: 32, hidden: 33, dnc: 34,
  quoName: 35, lastActivity: 36, firstContact: 37, idExp: 38, depositProperty: 39,
};
const APPOINTMENTS_DEFAULT = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
const PROPS_DEFAULT = {
  status: 0, livability: 1, photoError: 2, address: 3, quickSummary: 4, pics1: 5, lockbox: 6, onMarketDate: 7, lastUpdate: 8,
  area: 9, marketing: 10, notes: 11, down: 12, monthly: 13, total: 14, seller: 15, skool: 16, ttOurLink: 17, ttBuyerLink: 18,
  zillow: 19, years: 20, includesTaxes: 21, includesInsurance: 22, shareLink: 23, pics2: 24, pics3: 25, beds: 26, baths: 27,
  sqft: 28, type: 29, basement: 30, garage: 31, driveway: 32, rowid: 33,
};

export function colLetter(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
const letters = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, colLetter(v)]));

// Live state. LC/PC = 0-based index, LL/PL = column letter.
export const LC = { ...LOGINS_DEFAULT };
export const LL = letters(LC);
export const PC = { ...PROPS_DEFAULT };
export const PL = letters(PC);
export const APPT = { cols: [...APPOINTMENTS_DEFAULT] }; // indexes of Appointment 1..10, left to right
export const TABS = { logins: "App: Logins", props: "PROPERTIES" };
// Rightmost column the code uses on each tab (for whole-row reads A:<last>).
export const LAST = { logins: colLetter(Math.max(...Object.values(LC), ...APPT.cols)), props: colLetter(Math.max(...Object.values(PC))) };

let lastOk = 0;
let lastAlert = 0;

// Pure: apply metadata to the defaults. Returns { logins, appts, props, problems }.
export function resolveLayout(matched, titlesByGid, prev = { logins: LC, appts: APPT.cols, props: PC }) {
  const problems = [];
  const found = { logins: {}, props: {}, appts: [] };
  for (const m of matched) {
    const d = m.developerMetadata || m;
    const r = d.location && d.location.dimensionRange;
    if (!r || !d.metadataKey) continue;
    if (r.sheetId === LOGINS_GID && d.metadataKey === "iah.login.appointment") { found.appts.push(r.startIndex); continue; }
    const [ns, key] = d.metadataKey.startsWith("iah.login.") && r.sheetId === LOGINS_GID ? ["logins", d.metadataKey.slice(10)]
      : d.metadataKey.startsWith("iah.prop.") && r.sheetId === PROPS_GID ? ["props", d.metadataKey.slice(9)] : [null, null];
    if (!ns) continue;
    (found[ns][key] = found[ns][key] || []).push(r.startIndex);
  }
  const pick = (ns, defaults, prevMap) => {
    const out = {};
    for (const key of Object.keys(defaults)) {
      const hits = found[ns][key] || [];
      if (hits.length === 1) out[key] = hits[0];
      else { out[key] = prevMap[key]; problems.push(`${ns}.${key} tag found ${hits.length} times`); }
    }
    return out;
  };
  const logins = pick("logins", LOGINS_DEFAULT, prev.logins);
  const props = pick("props", PROPS_DEFAULT, prev.props);
  let appts = found.appts.sort((a, b) => a - b);
  if (appts.length !== APPOINTMENTS_DEFAULT.length) { problems.push(`logins.appointment tag found ${appts.length} times (want 10)`); appts = [...prev.appts]; }
  if (!titlesByGid[LOGINS_GID]) problems.push(`App: Logins tab (gid ${LOGINS_GID}) not found`);
  if (!titlesByGid[PROPS_GID]) problems.push(`PROPERTIES tab (gid ${PROPS_GID}) not found`);
  return { logins, appts, props, problems };
}

function apply(res, titles) {
  Object.assign(LC, res.logins); Object.assign(LL, letters(res.logins));
  Object.assign(PC, res.props); Object.assign(PL, letters(res.props));
  APPT.cols = res.appts;
  if (titles[LOGINS_GID]) TABS.logins = titles[LOGINS_GID];
  if (titles[PROPS_GID]) TABS.props = titles[PROPS_GID];
  LAST.logins = colLetter(Math.max(...Object.values(LC), ...APPT.cols));
  LAST.props = colLetter(Math.max(...Object.values(PC)));
}

// deps: { sheetId, getToken: () => Promise<string>, alert: (text) => Promise<void>, kv? }
// Shared cache (2026-11-19, after "layout lookup failed: 429/429"): every
// isolate used to ask Sheets twice a minute, which could exhaust the
// per-minute read quota the sign-in path shares. Now one lookup per
// KV_TTL is stored in KV and every isolate reads that. A failed lookup only
// alerts once nothing has succeeded for STALE_ALERT (a short 429 is normal).
const KV_KEY = "layout-cache-v1";
const KV_TTL = 10 * 60_000;
const STALE_ALERT = 30 * 60_000;
function applyMeta(matched, titles) {
  const res = resolveLayout(matched, titles);
  apply(res, titles);
  const sys = resolveSys(matched, titles); // TASK-000867
  applySys(sys);
  return [...res.problems, ...sys.problems];
}
export async function refreshLayout({ sheetId, getToken, alert, kv }, now = Date.now()) {
  if (now - lastOk < 60_000) return;
  let cached = null;
  if (kv) { try { cached = JSON.parse((await kv.get(KV_KEY)) || "null"); } catch { cached = null; } }
  if (cached && now - cached.at < KV_TTL) { applyMeta(cached.matched, cached.titles); lastOk = now; return; }
  try {
    const token = await getToken();
    const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;
    const [mr, ir] = await Promise.all([
      fetch(`${base}/developerMetadata:search`, { method: "POST", headers: H, body: JSON.stringify({ dataFilters: [{ developerMetadataLookup: { locationType: "COLUMN" } }] }) }),
      fetch(`${base}?fields=sheets.properties(sheetId,title)`, { headers: H }),
    ]);
    if (!mr.ok || !ir.ok) throw new Error(`layout lookup failed: ${mr.status}/${ir.status}`);
    const meta = await mr.json(); const info = await ir.json();
    const titles = {};
    for (const s of info.sheets || []) titles[s.properties.sheetId] = s.properties.title;
    const matched = (meta.matchedDeveloperMetadata || []).map((m) => { const d = m.developerMetadata || m; const r = d.location && d.location.dimensionRange; return r ? { metadataKey: d.metadataKey, location: { dimensionRange: { sheetId: r.sheetId, startIndex: r.startIndex } } } : null; }).filter(Boolean);
    const problems = applyMeta(matched, titles);
    lastOk = now;
    if (kv) { try { await kv.put(KV_KEY, JSON.stringify({ at: now, matched, titles })); } catch { /* cache is best-effort */ } }
    if (problems.length) await maybeAlert(alert, now, `Sheet column tags need attention (site still running on last known positions for these): ${problems.join("; ")}. Usually a tagged column was deleted or copied. Tell Claude Code (TASK-000844).`);
  } catch (e) {
    // Fall back to the last shared copy, however old, before the built-in defaults.
    if (cached) { applyMeta(cached.matched, cached.titles); }
    const lastGood = Math.max(lastOk, cached ? cached.at : 0);
    if (now - lastGood > STALE_ALERT) await maybeAlert(alert, now, `Site hasn't been able to read the Sheet's column tags for over 30 minutes, so it is using the last known column positions: ${String(e).slice(0, 200)}`);
  }
}

async function maybeAlert(alert, now, text) {
  if (now - lastAlert < 60 * 60_000) return;
  lastAlert = now;
  try { await alert(text); } catch { /* alerting must never break a request */ }
}

// For tests only.
export function _resetLayoutForTest() {
  lastOk = 0; lastAlert = 0;
  Object.assign(LC, LOGINS_DEFAULT); Object.assign(LL, letters(LOGINS_DEFAULT));
  Object.assign(PC, PROPS_DEFAULT); Object.assign(PL, letters(PROPS_DEFAULT));
  APPT.cols = [...APPOINTMENTS_DEFAULT]; TABS.logins = "App: Logins"; TABS.props = "PROPERTIES";
  if (typeof _resetSysForTest === "function") _resetSysForTest();
  LAST.logins = colLetter(Math.max(...Object.values(LC), ...APPT.cols)); LAST.props = colLetter(Math.max(...Object.values(PC)));
}

// ---- helpers for multi-column work (TASK-000844) ----
// A1 range for one whole App: Logins row (A through the rightmost tagged column).
export const loginsRowRange = (row) => `${TABS.logins}!A${row}:${LAST.logins}${row}`;
// A1 range for whole App: Logins rows from `fromRow` down (e.g. 1 or 2).
export const loginsRowsRange = (fromRow = 1) => `${TABS.logins}!A${fromRow}:${LAST.logins}`;
// Every column, for finding the next empty row: data past the last tagged
// column still counts as a used row (2026-11-19, lesson L125).
export const loginsFullWidthRange = () => `${TABS.logins}!A1:ZZ`;
// One cell's A1 range on App: Logins by tag key (or a raw 0-based index).
export const loginsCell = (keyOrIdx, row) => {
  const c = typeof keyOrIdx === "number" ? colLetter(keyOrIdx) : LL[keyOrIdx];
  if (!c) throw new Error(`unknown App: Logins column key ${keyOrIdx}`);
  return `${TABS.logins}!${c}${row}:${c}${row}`;
};
// Pick a cell from a whole-row array read from column A.
export const cellOf = (rowArr, key) => ((rowArr || [])[LC[key]] ?? "");
// Build values:batchUpdate data for several App: Logins cells: [[keyOrIdx, value], ...].
export const loginsCellsData = (row, pairs) => pairs.map(([k, v]) => ({ range: loginsCell(k, row), values: [[v]] }));
// Whole PROPERTIES rows from `fromRow` down, A through the rightmost tagged column.
export const propsRowsRange = (fromRow = 1) => `${TABS.props}!A${fromRow}:${LAST.props}`;
export const propOf = (rowArr, key) => ((rowArr || [])[PC[key]] ?? "");

// ---- system-written tabs (TASK-000867, RULE-000155) ----
// Only the system writes these, but they get the same protection: found by
// gid, columns by tag (iah.code.* / iah.pphone.* / iah.pemail.* / iah.gate.*
// tagged 2026-11-19; iah.tpl.* since 2026-11-13). Code keeps working with
// rows in the canonical key order below; sysRow() / sysCellsData() /
// sysAppendRow() translate to wherever each tagged column sits now.
export const SYS = {
  loginCodes: { gid: 205900326, prefix: "iah.code.", title: "Login Codes", keys: ["phone", "codeHash", "expiresAt", "attempts", "lastSentAt", "sendsInWindow", "windowStart"] },
  pendingPhone: { gid: 572834982, prefix: "iah.pphone.", title: "Pending Phone Changes", keys: ["email", "oldPhone", "newPhone", "requestedAt", "expiresAt", "status", "targetRow"] },
  pendingEmail: { gid: 726319051, prefix: "iah.pemail.", title: "Pending Email Changes", keys: ["oldEmail", "newEmail", "phone", "requestedAt", "expiresAt", "status", "targetRow"] },
  gateLog: { gid: 1768423850, prefix: "iah.gate.", title: "Gate Capture Log", keys: ["timestamp", "name", "email", "phone", "agreed", "userAgent", "reconciled"] },
  templates: { gid: 870288652, prefix: "iah.tpl.", title: "Text Templates", keys: ["key", "label", "text", "mergeFields", "lastUpdated"] },
};
const SYS_DEFAULT_TITLES = Object.fromEntries(Object.entries(SYS).map(([t, d]) => [t, d.title]));
for (const d of Object.values(SYS)) d.pos = Object.fromEntries(d.keys.map((k, i) => [k, i]));

// Pure: positions for each system tab from the metadata; missing or doubled
// tags keep the previous position and are reported.
export function resolveSys(matched, titlesByGid) {
  const problems = []; const out = {};
  for (const [t, d] of Object.entries(SYS)) {
    const hits = {};
    for (const m of matched) {
      const md = m.developerMetadata || m; const r = md.location && md.location.dimensionRange;
      if (!r || r.sheetId !== d.gid || !md.metadataKey || !md.metadataKey.startsWith(d.prefix)) continue;
      (hits[md.metadataKey.slice(d.prefix.length)] = hits[md.metadataKey.slice(d.prefix.length)] || []).push(r.startIndex);
    }
    const pos = {};
    for (const k of d.keys) {
      const h = hits[k] || [];
      if (h.length === 1) pos[k] = h[0]; else { pos[k] = d.pos[k]; problems.push(`${t}.${k} tag found ${h.length} times`); }
    }
    out[t] = { pos, title: titlesByGid[d.gid] || null };
    if (!titlesByGid[d.gid]) problems.push(`${d.title} tab (gid ${d.gid}) not found`);
  }
  return { sys: out, problems };
}
export function applySys(res) {
  for (const [t, v] of Object.entries(res.sys)) { Object.assign(SYS[t].pos, v.pos); if (v.title) SYS[t].title = v.title; }
}
export function _resetSysForTest() {
  for (const [t, d] of Object.entries(SYS)) { d.title = SYS_DEFAULT_TITLES[t]; d.pos = Object.fromEntries(d.keys.map((k, i) => [k, i])); }
}

const sysQ = (t) => `'${SYS[t].title.replace(/'/g, "''")}'`;
const sysLastIdx = (t) => Math.max(...Object.values(SYS[t].pos));
// Whole rows from `fromRow` down, column A through the rightmost tagged column.
export const sysRowsRange = (t, fromRow = 1) => `${sysQ(t)}!A${fromRow}:${colLetter(sysLastIdx(t))}`;
// One whole column by key (e.g. the Key column of Text Templates).
export const sysColRange = (t, key) => { const c = colLetter(SYS[t].pos[key]); return `${sysQ(t)}!${c}:${c}`; };
// One cell by key.
export const sysCell = (t, key, row) => { const c = colLetter(SYS[t].pos[key]); return `${sysQ(t)}!${c}${row}:${c}${row}`; };
// A row read from column A, as values in the canonical key order.
export const sysRow = (t, arr) => SYS[t].keys.map((k) => ((arr || [])[SYS[t].pos[k]] ?? ""));
// values:batchUpdate data writing canonical-order values into a row. Only the
// slots given are written, like the old A:G PUT with a shorter array.
export const sysCellsData = (t, row, values) => values.map((v, i) => ({ range: sysCell(t, SYS[t].keys[i], row), values: [[v ?? ""]] }));
// A canonical-order row laid out at the tagged positions, for :append.
export const sysAppendRow = (t, values) => { const out = Array(sysLastIdx(t) + 1).fill(""); SYS[t].keys.forEach((k, i) => { out[SYS[t].pos[k]] = values[i] ?? ""; }); return out; };

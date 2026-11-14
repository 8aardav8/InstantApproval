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

// deps: { sheetId, getToken: () => Promise<string>, alert: (text) => Promise<void> }
export async function refreshLayout({ sheetId, getToken, alert }, now = Date.now()) {
  if (now - lastOk < 60_000) return;
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
    const res = resolveLayout(meta.matchedDeveloperMetadata || [], titles);
    apply(res, titles);
    lastOk = now;
    if (res.problems.length) await maybeAlert(alert, now, `Sheet column tags need attention (site still running on last known positions for these): ${res.problems.join("; ")}. Usually a tagged column was deleted or copied. Tell Claude Code (TASK-000844).`);
  } catch (e) {
    await maybeAlert(alert, now, `Site couldn't read the Sheet's column tags, so it is using the last known column positions: ${String(e).slice(0, 200)}`);
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
  LAST.logins = colLetter(Math.max(...Object.values(LC), ...APPT.cols)); LAST.props = colLetter(Math.max(...Object.values(PC)));
}

// ---- helpers for multi-column work (TASK-000844) ----
// A1 range for one whole App: Logins row (A through the rightmost tagged column).
export const loginsRowRange = (row) => `${TABS.logins}!A${row}:${LAST.logins}${row}`;
// A1 range for whole App: Logins rows from `fromRow` down (e.g. 1 or 2).
export const loginsRowsRange = (fromRow = 1) => `${TABS.logins}!A${fromRow}:${LAST.logins}`;
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

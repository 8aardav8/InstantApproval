// A small in-memory Google Sheets for tests (TASK-000844).
// Understands A1 ranges (open-ended, multi-letter columns, quoted tab names),
// values GET / PUT / :append / :batchUpdate / :batchGet, spreadsheet info
// (tab gids and titles) and developerMetadata:search for column tags.
// Tabs are grids of strings. `layout` decides where each tagged column sits,
// so a test can move columns and check the code follows its tags.

export function colIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
export function colLetter(i) { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }

function parseA1(a1) {
  const m = a1.match(/^(?:'((?:[^']|'')+)'|([^!]+))!([A-Z]*)(\d*)(?::([A-Z]*)(\d*))?$/);
  if (!m) throw new Error(`fake-sheets: bad range ${a1}`);
  const tab = (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]);
  const c1 = m[3] ? colIndex(m[3]) : 0, r1 = m[4] ? +m[4] : 1;
  const c2 = m[5] !== undefined ? (m[5] ? colIndex(m[5]) : null) : (m[3] ? c1 : null);
  const r2 = m[6] !== undefined ? (m[6] ? +m[6] : null) : (m[4] ? r1 : null);
  return { tab, c1, r1, c2, r2 };
}

// tabs: { gid: { title, rows: string[][], tags?: { [colIndex]: string[] } } }
export function createFakeSheets(tabs) {
  const writes = [];
  const byTitle = (t) => { const e = Object.entries(tabs).find(([, v]) => v.title === t); if (!e) throw new Error(`fake-sheets: no tab ${t}`); return e[1]; };
  const read = (a1) => {
    const { tab, c1, r1, c2, r2 } = parseA1(a1); const t = byTitle(tab);
    const lastRow = r2 ?? t.rows.length; const out = [];
    for (let r = r1; r <= lastRow; r++) {
      const row = t.rows[r - 1] || []; const end = c2 ?? Math.max(row.length - 1, c1);
      const vals = []; for (let c = c1; c <= end; c++) vals.push(row[c] ?? "");
      while (vals.length && vals[vals.length - 1] === "") vals.pop();
      out.push(vals);
    }
    while (out.length && !out[out.length - 1].length) out.pop();
    return out;
  };
  const write = (a1, values) => {
    const { tab, c1, r1 } = parseA1(a1); const t = byTitle(tab);
    values.forEach((vals, i) => { const r = r1 + i; t.rows[r - 1] = t.rows[r - 1] || []; vals.forEach((v, j) => { t.rows[r - 1][c1 + j] = String(v ?? ""); }); });
    writes.push({ range: a1, values });
  };
  const append = (a1, values) => {
    const { tab } = parseA1(a1); const t = byTitle(tab);
    let last = t.rows.length; while (last > 0 && !(t.rows[last - 1] || []).some((x) => x)) last--;
    const { c1 } = parseA1(a1);
    write(`${tab}!${colLetter(c1)}${last + 1}`, values);
  };
  async function handle(url, init = {}) {
    const json = (b) => new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });
    const path = url.pathname;
    if (path.endsWith("/developerMetadata:search")) {
      const matched = [];
      for (const [gid, t] of Object.entries(tabs)) for (const [idx, keys] of Object.entries(t.tags || {})) for (const k of keys)
        matched.push({ developerMetadata: { metadataKey: k, location: { dimensionRange: { sheetId: +gid, dimension: "COLUMNS", startIndex: +idx, endIndex: +idx + 1 } } } });
      return json({ matchedDeveloperMetadata: matched });
    }
    if (/\/spreadsheets\/[^/]+$/.test(path) && (!init.method || init.method === "GET"))
      return json({ sheets: Object.entries(tabs).map(([gid, t]) => ({ properties: { sheetId: +gid, title: t.title, gridProperties: { columnCount: 60, rowCount: 5000 } } })) });
    if (path.endsWith("/values:batchUpdate")) { for (const d of JSON.parse(init.body).data) write(d.range, d.values); return json({}); }
    if (path.endsWith("/values:batchGet")) return json({ valueRanges: url.searchParams.getAll("ranges").map((r) => ({ range: r, values: read(r) })) });
    const vi = path.indexOf("/values/");
    if (vi >= 0) {
      let a1 = decodeURIComponent(path.slice(vi + 8));
      if (a1.endsWith(":append")) { append(a1.slice(0, -7), JSON.parse(init.body).values); return json({}); }
      if (init.method === "PUT") { write(a1, JSON.parse(init.body).values); return json({}); }
      return json({ values: read(a1) });
    }
    throw new Error(`fake-sheets: unhandled ${init.method || "GET"} ${path}`);
  }
  return { tabs, writes, handle, read };
}

// Moves column `from` to position `to` in a tab (rows and tags move together),
// like Aaron dragging a column in the Sheets UI.
export function moveColumn(tab, from, to) {
  for (const row of tab.rows) { while (row.length <= Math.max(from, to)) row.push(""); const [v] = row.splice(from, 1); row.splice(to, 0, v); }
  const width = Math.max(...Object.keys(tab.tags || {}).map(Number), from, to) + 1;
  const order = [...Array(width).keys()]; const [m] = order.splice(from, 1); order.splice(to, 0, m);
  const newTags = {}; order.forEach((oldIdx, newIdx) => { if (tab.tags[oldIdx]) newTags[newIdx] = tab.tags[oldIdx]; });
  tab.tags = newTags;
}

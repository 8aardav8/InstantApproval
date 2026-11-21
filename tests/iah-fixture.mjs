// Standard fake Filling Sheet for tests: App: Logins and PROPERTIES with the
// real 2026-11-13 headers and column tags (TASK-000844).
import { createFakeSheets } from './fake-sheets.mjs';
export const LOGINS_HEADERS = ['First Login','Email','Agreed','Phone','Name','ID Link','Last Login','Filter: Sort','Filter: Max Down','Filter: Max Monthly','Filter: Min Beds','Filter: Area(s)','Last Search','Quo Link','Appointment 1','Appointment 2','Appointment 3','Appointment 4','Appointment 5','Appointment 6','Appointment 7','Appointment 8','Appointment 9','Appointment 10','Favorites','Co-Buyer 1','Co-Buyer 2','Shown Properties','Viewed Properties','Manual Area Override','Sentiment','Stage','ID Name (OCR)','Hidden','DNC','Quo Name','Last Activity (Quo)','First Contact Date','ID Exp','Deposit Property'];
const LOGIN_KEYS = ['firstLogin','email','agreed','phone','name','idLink','lastLogin','filterSort','filterMaxDown','filterMaxMonthly','filterMinBeds','filterAreas','lastSearch','quoLink',...Array(10).fill('appointment'),'favorites','coBuyer1','coBuyer2','shown','viewed','manualAreaOverride','sentiment','stage','idName','hidden','dnc','quoName','lastActivity','firstContact','idExp','depositProperty'];
export const PROPS_HEADERS = ['Available?','Livability','PHOTO Error','Address','Quick Summary','Pics 1','Lock box ','On Market Date','Last Update','Area',"We're Marketing",'Additional Notes','Down','Monthly','Total Price','Seller name and link','Skool Link','TT Our Link','TT Buyer Link','Zillow Link','Years','Includes Taxes','Includes Insurance','Share Link','Pics 2','Pics 3','Beds','Baths','Sq Ft','Type','Basement','Garage','Driveway','🔒 Row ID','Featured','Card Banner'];
const PROP_KEYS = ['status','livability','photoError','address','quickSummary','pics1','lockbox','onMarketDate','lastUpdate','area','marketing','notes','down','monthly','total','seller','skool','ttOurLink','ttBuyerLink','zillow','years','includesTaxes','includesInsurance','shareLink','pics2','pics3','beds','baths','sqft','type','basement','garage','driveway','rowid','featured','banner'];
export const LOGINS_GID = 5432432, PROPS_GID = 1440969658;
export const SYS_TABS = [
  { gid: 205900326, title: 'Login Codes', prefix: 'iah.code.', keys: ['phone','codeHash','expiresAt','attempts','lastSentAt','sendsInWindow','windowStart'], headers: ['Phone','Code Hash','Expires At','Attempts','Last Sent At','Sends In Window','Window Start'] },
  { gid: 572834982, title: 'Pending Phone Changes', prefix: 'iah.pphone.', keys: ['email','oldPhone','newPhone','requestedAt','expiresAt','status','targetRow'], headers: ['Email','Old Phone','New Phone','Requested At','Expires At','Status','Target Row'] },
  { gid: 726319051, title: 'Pending Email Changes', prefix: 'iah.pemail.', keys: ['oldEmail','newEmail','phone','requestedAt','expiresAt','status','targetRow'], headers: ['Old Email','New Email','Phone','Requested At','Expires At','Status','Target Row'] },
  { gid: 1768423850, title: 'Gate Capture Log', prefix: 'iah.gate.', keys: ['timestamp','name','email','phone','agreed','userAgent','reconciled'], headers: ['Timestamp','Name','Email','Phone','Agreed','User Agent','Reconciled?'] },
  { gid: 870288652, title: 'Text Templates', prefix: 'iah.tpl.', keys: ['key','label','text','mergeFields','lastUpdated','autoSend'], headers: ['Key','Label','Template Text','Available Merge Fields','Last Updated','Auto Send'] },
];
// loginRows: array of { key: value } objects (row 2 onward).
export function makeSheet({ loginRows = [], propRows = [], extraTabs = {} } = {}) {
  const lrow = (o) => LOGIN_KEYS.map((k, i) => (k === 'appointment' ? (o.appointments || [])[i - 14] ?? '' : o[k] ?? ''));
  const prow = (o) => PROP_KEYS.map((k) => o[k] ?? '');
  const tabs = {
    [LOGINS_GID]: { title: 'App: Logins', rows: [LOGINS_HEADERS.slice(), ...loginRows.map(lrow)], tags: Object.fromEntries(LOGIN_KEYS.map((k, i) => [i, [`iah.login.${k}`]])) },
    [PROPS_GID]: { title: 'PROPERTIES', rows: [PROPS_HEADERS.slice(), ...propRows.map(prow)], tags: Object.fromEntries(PROP_KEYS.map((k, i) => [i, [`iah.prop.${k}`]])) },
    // TASK-000867: the system tabs, found by gid with tagged columns.
    ...Object.fromEntries(SYS_TABS.map((t) => [t.gid, { title: t.title, rows: [t.headers.slice()], tags: Object.fromEntries(t.keys.map((k, i) => [i, [`${t.prefix}${k}`]])) }])),
    ...extraTabs,
  };
  // A test that supplies its own system tab gets the standard tags unless it set its own.
  for (const t of SYS_TABS) if (extraTabs[t.gid] && !extraTabs[t.gid].tags) tabs[t.gid].tags = Object.fromEntries(t.keys.map((k, i) => [i, [`${t.prefix}${k}`]]));
  return createFakeSheets(tabs);
}
// Read a cell by header text from the fake (tests only: headers are fine here).
export function cell(sheet, gid, row, header) { const t = sheet.tabs[gid]; return (t.rows[row - 1] || [])[t.rows[0].indexOf(header)] ?? ''; }

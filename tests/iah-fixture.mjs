// Standard fake Filling Sheet for tests: App: Logins and PROPERTIES with the
// real 2026-11-13 headers and column tags (TASK-000844).
import { createFakeSheets } from './fake-sheets.mjs';
export const LOGINS_HEADERS = ['First Login','Email','Agreed','Phone','Name','ID Link','Last Login','Filter: Sort','Filter: Max Down','Filter: Max Monthly','Filter: Min Beds','Filter: Area(s)','Last Search','Quo Link','Appointment 1','Appointment 2','Appointment 3','Appointment 4','Appointment 5','Appointment 6','Appointment 7','Appointment 8','Appointment 9','Appointment 10','Favorites','Co-Buyer 1','Co-Buyer 2','Shown Properties','Viewed Properties','Manual Area Override','Sentiment','Stage','ID Name (OCR)','Hidden','DNC','Quo Name','Last Activity (Quo)','First Contact Date','ID Exp','Deposit Property'];
const LOGIN_KEYS = ['firstLogin','email','agreed','phone','name','idLink','lastLogin','filterSort','filterMaxDown','filterMaxMonthly','filterMinBeds','filterAreas','lastSearch','quoLink',...Array(10).fill('appointment'),'favorites','coBuyer1','coBuyer2','shown','viewed','manualAreaOverride','sentiment','stage','idName','hidden','dnc','quoName','lastActivity','firstContact','idExp','depositProperty'];
export const PROPS_HEADERS = ['Available?','Livability','PHOTO Error','Address','Quick Summary','Pics 1','Lock box ','On Market Date','Last Update','Area',"We're Marketing",'Additional Notes','Down','Monthly','Total Price','Seller name and link','Skool Link','TT Our Link','TT Buyer Link','Zillow Link','Years','Includes Taxes','Includes Insurance','Share Link','Pics 2','Pics 3','Beds','Baths','Sq Ft','Type','Basement','Garage','Driveway','🔒 Row ID'];
const PROP_KEYS = ['status','livability','photoError','address','quickSummary','pics1','lockbox','onMarketDate','lastUpdate','area','marketing','notes','down','monthly','total','seller','skool','ttOurLink','ttBuyerLink','zillow','years','includesTaxes','includesInsurance','shareLink','pics2','pics3','beds','baths','sqft','type','basement','garage','driveway','rowid'];
export const LOGINS_GID = 5432432, PROPS_GID = 1440969658;
// loginRows: array of { key: value } objects (row 2 onward).
export function makeSheet({ loginRows = [], propRows = [], extraTabs = {} } = {}) {
  const lrow = (o) => LOGIN_KEYS.map((k, i) => (k === 'appointment' ? (o.appointments || [])[i - 14] ?? '' : o[k] ?? ''));
  const prow = (o) => PROP_KEYS.map((k) => o[k] ?? '');
  const tabs = {
    [LOGINS_GID]: { title: 'App: Logins', rows: [LOGINS_HEADERS.slice(), ...loginRows.map(lrow)], tags: Object.fromEntries(LOGIN_KEYS.map((k, i) => [i, [`iah.login.${k}`]])) },
    [PROPS_GID]: { title: 'PROPERTIES', rows: [PROPS_HEADERS.slice(), ...propRows.map(prow)], tags: Object.fromEntries(PROP_KEYS.map((k, i) => [i, [`iah.prop.${k}`]])) },
    ...extraTabs,
  };
  return createFakeSheets(tabs);
}
// Read a cell by header text from the fake (tests only: headers are fine here).
export function cell(sheet, gid, row, header) { const t = sheet.tabs[gid]; return (t.rows[row - 1] || [])[t.rows[0].indexOf(header)] ?? ''; }

// Instant-Approval Home Financing -- front end
// Reads docs/data/properties.json (regenerated automatically whenever the
// source Sheet changes -- see scripts/generate_properties.py). No login,
// no cookies, no tracking.

// Wired in 2026-08-21. This is Aaron's "browser key" -- restricted by HTTP
// referrer (https://8aardav8.github.io/*) and by API (Maps JavaScript API +
// Street View Static API only). Safe to be public/embedded by design, same
// as any site that embeds Google Maps -- the referrer restriction, not
// secrecy, is what keeps it from being usable elsewhere. A SEPARATE
// Geocoding-only key (never embedded here) is used server-side in
// .github/workflows/_publish.yml, since a referrer-restricted key can't be
// used from a server-to-server call (no browser, no Referer header).
const GOOGLE_MAPS_API_KEY = "AIzaSyDopPbLVJJXmv5kj8piuRv0W1tZlSDUBG0";

const AARON_PHONE = "6184184180"; // digits only, for sms:/tel: links

// TODO(kickoff): once the small serverless backend is deployed, point this
// at its real URL (e.g. https://<worker>.<account>.workers.dev/buyer-info).
const BUYER_INFO_ENDPOINT = "";

let ALL_LISTINGS = [];
let GENERATED_AT = null;
// Availability defaults to "Available" again (2026-08-22) -- briefly
// changed to "Any" on 2026-08-21, reverted per Aaron's direct request the
// next day. area is a checkbox multi-select (array), not free-text.
let filterState = { status: "Available", sort: "recent", down: null, monthly: null, beds: null, area: [] };

// ---------- data load ----------
async function loadData() {
  const res = await fetch("data/properties.json", { cache: "no-store" });
  const data = await res.json();
  ALL_LISTINGS = data.listings;
  GENERATED_AT = data.generatedAt;
  renderAreaCheckboxes(); // must run before restoreFilterStateFromUrl(), which checks boxes by value
  restoreFilterStateFromUrl();
  renderFreshness();
  renderStatsStrip();
  updateFilterBadge();
  renderCardGrid();
}

// Area is now a checkbox list, not free text -- populated live from the
// real Area values in the data (never hardcoded, so it can't drift from
// what's actually in the Sheet). All start unchecked; unchecked = no area
// restriction, same meaning as the old blank text field.
function renderAreaCheckboxes() {
  const container = document.getElementById("area-checkboxes");
  const areas = [...new Set(ALL_LISTINGS.map((l) => l.area).filter(Boolean))].sort();
  container.innerHTML = areas.map((area) => `
    <label class="area-checkbox">
      <input type="checkbox" value="${escapeHtml(area)}">
      <span>${escapeHtml(area)}</span>
    </label>
  `).join("");
}

function renderFreshness() {
  const el = document.getElementById("freshness");
  if (!GENERATED_AT) return;
  const d = new Date(GENERATED_AT);
  el.textContent = `Data last refreshed: ${d.toLocaleString()}`;
}

function renderStatsStrip() {
  const el = document.getElementById("stats-strip");
  const available = ALL_LISTINGS.filter((l) => l.status === "Available");
  const areas = new Set(available.map((l) => l.area).filter(Boolean));
  el.innerHTML = `
    <div class="stat-pill"><strong>${available.length}</strong>Homes available</div>
    <div class="stat-pill"><strong>${areas.size || "—"}</strong>Areas</div>
    <div class="stat-pill"><strong>No</strong>Bank or credit check</div>
  `;
}

// ---------- filtering ----------
function matchesFilters(listing) {
  if (filterState.status !== "Any" && listing.status !== filterState.status) return false;
  const down = parseMoney(listing.down);
  const monthly = parseMoney(listing.monthly);
  if (filterState.down && down !== null && down > filterState.down) return false;
  if (filterState.monthly && monthly !== null && monthly > filterState.monthly) return false;
  if (filterState.beds && (parseInt(listing.beds, 10) || 0) < filterState.beds) return false;
  if (filterState.area.length > 0 && !filterState.area.includes(listing.area)) return false;
  const q = document.getElementById("search-box").value.trim().toLowerCase();
  if (q && !listing.address.toLowerCase().includes(q)) return false;
  return true;
}

function parseMoney(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

// Sheet dates are stored as bare "M/D" with no year (confirmed against real
// data). Assumed to mean the current year -- these are live/recently-touched
// listings, not multi-year archival records, so year ambiguity in practice
// isn't a real concern. Returns null (sorts last) if unparseable.
function parseListingDate(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const [, month, day, year] = m;
  const y = year ? (year.length === 2 ? 2000 + parseInt(year, 10) : parseInt(year, 10)) : new Date().getFullYear();
  const d = new Date(y, parseInt(month, 10) - 1, parseInt(day, 10));
  return isNaN(d.getTime()) ? null : d;
}

function sortListings(listings) {
  const sorted = [...listings];
  if (filterState.sort === "monthly-asc") {
    sorted.sort((a, b) => (parseMoney(a.monthly) ?? Infinity) - (parseMoney(b.monthly) ?? Infinity));
  } else if (filterState.sort === "down-asc") {
    sorted.sort((a, b) => (parseMoney(a.down) ?? Infinity) - (parseMoney(b.down) ?? Infinity));
  } else {
    // Default: most recently updated first. Listings with an unparseable
    // date sort to the end rather than silently to the top/bottom at random.
    sorted.sort((a, b) => {
      const da = parseListingDate(a.lastUpdate);
      const db = parseListingDate(b.lastUpdate);
      if (da && db) return db - da;
      if (da) return -1;
      if (db) return 1;
      return 0;
    });
  }
  return sorted;
}

// ---------- card grid ----------
function renderCardGrid() {
  const grid = document.getElementById("card-grid");
  const empty = document.getElementById("empty-state");
  const filtered = sortListings(ALL_LISTINGS.filter(matchesFilters));
  grid.innerHTML = "";
  empty.classList.toggle("hidden", filtered.length > 0);

  for (const listing of filtered) {
    const card = document.createElement("div");
    card.className = "card";
    card.addEventListener("click", () => showDetail(listing.id));

    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = streetViewUrl(listing.address, 400, 300);
    img.alt = listing.address;
    card.appendChild(img);

    const body = document.createElement("div");
    body.className = "card-body";
    // Card status line shows the LATEST UPDATE date, not first-available --
    // per Aaron's explicit correction (default sort is also by this same
    // field, so the visible date and the sort order agree with each other).
    // Livability stays on the card only -- deliberately dropped from the
    // detail view per Aaron's 2026-08-21 request.
    // Livability display, per Aaron's explicit 2026-08-21 call: a 0 (or
    // missing) rating shows NOTHING -- no "(0)", not even empty "()" --
    // only a real 1-5 rating gets shown as "(N)". This is a deliberate
    // product decision for the new site, distinct from what the live Glide
    // app happens to render for the same data.
    const livabilitySuffix = listing.livability ? ` (${listing.livability})` : "";
    body.innerHTML = `
      <div class="card-status ${listing.status.toLowerCase()}">${listing.status.toUpperCase()} - ${escapeHtml(listing.lastUpdate)}${escapeHtml(livabilitySuffix)}</div>
      <div class="card-address">${escapeHtml(listing.address)}</div>
      <div class="card-meta">${escapeHtml(listing.beds || "?")} bed / ${escapeHtml(listing.baths || "?")} bath</div>
      <div class="card-money">${escapeHtml(listing.down)} down</div>
      <div class="card-money">${escapeHtml(listing.monthly)} a month</div>
    `;
    card.appendChild(body);
    grid.appendChild(card);
  }
}

function streetViewUrl(address, w, h) {
  if (!GOOGLE_MAPS_API_KEY) return "assets/placeholder-streetview.png";
  // fov (field of view, degrees) defaults to 90 if unset -- a fairly wide,
  // zoomed-out shot. Tightened 90 -> 60 -> 50 (2026-08-22, second request)
  // to better showcase the house itself.
  return `https://maps.googleapis.com/maps/api/streetview?size=${w}x${h}&fov=50&location=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Detail-view field row -- skips rendering entirely when the value is blank
// (e.g. a listing missing Sq Ft), per Aaron's explicit 2026-08-22 request,
// rather than showing a row with an empty value.
function detailField(label, value) {
  if (!value || !String(value).trim()) return "";
  return `<div class="detail-field"><span>${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`;
}

// ---------- SMS deep links ----------
// Real cross-platform wrinkle, confirmed in the approved plan: iOS wants
// `sms:<number>&body=<text>`, Android traditionally wants
// `sms:<number>?body=<text>`. Detected via UA, not assumed universal.
function isiOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}
function smsLink(number, body) {
  const sep = isiOS() ? "&" : "?";
  const dest = number || "";
  return `sms:${dest}${sep}body=${encodeURIComponent(body)}`;
}

function inquireLink(listing) {
  const body = `Hi. Please get back to me about the Available property at \n${listing.address}.\nThanks`;
  return smsLink(AARON_PHONE, body);
}
function photoNotWorkingLink(listing) {
  const body = `Hi. The photos don't seem to be working for this property at ${listing.address}. Please update, or send me a link when you can. Thanks.`;
  return smsLink(AARON_PHONE, body);
}
function shareLink(listing) {
  const body =
    `${listing.status}: ${listing.address}\n` +
    `${listing.beds} bed / ${listing.baths} bath.\n` +
    `For sale as is. ${listing.down} down, ${listing.monthly} a month.\n` +
    `Owner financed, no credit check.\n` +
    `${listing.picsLink}\n\n` +
    `https://InstantApprovalHomes.com\n\n` +
    `Contact Aaron \n${AARON_PHONE.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")}`;
  return smsLink("", body); // no destination pre-filled -- visitor picks who to share with
}

// ---------- detail view ----------
function showDetail(id) {
  const listing = ALL_LISTINGS.find((l) => l.id === id);
  if (!listing) return;
  // Note: #map-accordion is a child of #view-list, so hiding view-list below
  // already visually hides the map too if it was open -- no separate step
  // needed (it was a sibling "page" before the 2026-08-22 accordion rework).
  document.getElementById("view-list").classList.add("hidden");
  const detail = document.getElementById("view-detail");
  detail.classList.remove("hidden");
  window.location.hash = `listing/${id}`;

  const ICON_CHAT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px"><path d="M21 11.5a8.4 8.4 0 0 1-8.9 8.4A9 9 0 0 1 4 18l-2 1 1-3.2A8.4 8.4 0 1 1 21 11.5z"/></svg>';
  const ICON_LINK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1-1"/></svg>';
  const ICON_CAMERA = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  const ICON_DIRECTIONS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px"><polygon points="12 2 19 21 12 17 5 21 12 2"/></svg>';
  const ICON_BACK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 5 8 12 15 19"/></svg>';

  const availableOnly = listing.status === "Available";
  const inquireBtn = availableOnly
    ? `<a class="btn-primary" href="${inquireLink(listing)}">${ICON_CHAT}Inquire</a>` : "";
  // Fixed 2026-08-21: this used to be a <button onclick="window.location.href=...">,
  // inconsistent with Inquire/Share (both plain <a href>) -- Aaron flagged it as
  // "didn't work like the others did." Same <a> pattern now, all three.
  const photoBtn = availableOnly
    ? `<a class="btn-outline btn-full" href="${photoNotWorkingLink(listing)}">${ICON_CAMERA}Photo link not working?</a>` : "";
  // Livability deliberately NOT shown here -- per Aaron's 2026-08-21 request,
  // it stays on the card only, not on the detail/properties page.

  detail.innerHTML = `
    <button class="detail-back" onclick="backToList()">${ICON_BACK}</button>
    <img class="detail-photo" src="${streetViewUrl(listing.address, 800, 500)}" alt="${escapeHtml(listing.address)}">
    <div class="detail-body">
      <div class="detail-status">${escapeHtml(listing.status)}</div>
      <div class="detail-address">${escapeHtml(listing.address)}</div>
      <div class="action-row">
        ${inquireBtn}
        <a class="btn-outline" href="${shareLink(listing)}">${ICON_LINK}Share</a>
      </div>
      <a class="btn-outline btn-full" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(listing.address)}" target="_blank" rel="noopener">${ICON_DIRECTIONS}Get Directions</a>
      ${detailField("First Available", listing.onMarketDate)}
      ${listing.picsLink && listing.picsLink.trim()
        ? `<div class="detail-field"><span>Photo Link</span><span class="value"><a href="${escapeHtml(listing.picsLink)}" target="_blank" rel="noopener">${escapeHtml(listing.picsLink)}</a></span></div>`
        : ""}
      ${photoBtn}
      ${detailField("Down Payment", listing.down)}
      ${detailField("Monthly Payment", listing.monthly)}
      ${detailField("Beds", listing.beds)}
      ${detailField("Baths", listing.baths)}
      ${detailField("Sq Ft", listing.sqft)}
      ${detailField("Last Updated", listing.lastUpdate)}
      <div id="admin-info-section" class="admin-info-section hidden"></div>
    </div>
  `;

  renderAdminSection(listing);
}

function backToList() {
  document.getElementById("view-detail").classList.add("hidden");
  document.getElementById("view-list").classList.remove("hidden");
  history.replaceState(null, "", window.location.pathname);
}

// ---------- map (Available-only, always, regardless of the list filter) ----------
let mapInstance = null;
let mapsScriptLoading = null;
let mapMarkers = []; // tracked so re-entering the map view doesn't stack duplicate markers
let mapInfoWindow = null;

function loadMapsScript() {
  if (mapsScriptLoading) return mapsScriptLoading;
  mapsScriptLoading = new Promise((resolve, reject) => {
    if (!GOOGLE_MAPS_API_KEY) {
      reject(new Error("no-api-key"));
      return;
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}`;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return mapsScriptLoading;
}

// Custom light-blue house marker (instead of Google's default red pin) with
// the down payment shown as a label right next to it, per Aaron's explicit
// 2026-08-22 requests. Google Marker.label only centers text ON TOP of an
// icon, not beside it, and Symbol paths are vector-only (no embedded text)
// -- so this builds one composite SVG (house glyph + a price pill) per
// listing and uses it as a data-URI image icon instead. House path is a
// standard 24x24 "home" glyph.
// Status -> color, per Aaron's 2026-08-22 request: blue for Available,
// orange for Pending, gray for Sold. Applied to both the house glyph and
// the price pill's border/text, so each marker reads as one consistent
// color-coded unit rather than a colored house with an always-blue label.
const MAP_STATUS_COLORS = {
  available: { fill: "#7dd3fc", stroke: "#0369a1" },
  pending: { fill: "#fdba74", stroke: "#c2410c" },
  sold: { fill: "#d1d5db", stroke: "#4b5563" },
};

function houseIconWithPrice(downText, status) {
  const label = (downText || "").trim();
  const colors = MAP_STATUS_COLORS[(status || "").toLowerCase()] || MAP_STATUS_COLORS.available;
  const houseW = 24, gap = 4, totalH = 24;
  // Real data check (2026-08-22): only 1 of 307 available listings has a
  // blank Down value -- skip the label pill entirely for those rather than
  // showing an empty tag next to the house.
  const labelGroup = label
    ? (() => {
        const labelWidth = Math.max(30, label.length * 7 + 14); // rough char-width estimate + padding
        return {
          width: labelWidth,
          markup: `
      <g transform="translate(${houseW + gap}, 2)">
        <rect width="${labelWidth}" height="20" rx="10" fill="#ffffff" stroke="${colors.stroke}" stroke-width="1"/>
        <text x="${labelWidth / 2}" y="14" text-anchor="middle" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="11" font-weight="700" fill="${colors.stroke}">${escapeHtml(label)}</text>
      </g>`,
        };
      })()
    : { width: 0, markup: "" };
  const totalW = label ? houseW + gap + labelGroup.width : houseW;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">
      <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="1"/>${labelGroup.markup}
    </svg>
  `.trim();
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(totalW, totalH),
    anchor: new google.maps.Point(12, 20), // house's own bottom-center, matching where a pin's point would sit
  };
}

// Map accordion open/close, 2026-08-22 rework: the map now lives inline on
// the home page (toggled by the same button, no separate page/back button
// needed) and its pins reflect whatever filters are currently applied to
// the card grid -- this deliberately supersedes the original plan's "map
// always shows Available only" rule, per Aaron's explicit request.
async function toggleMapAccordion() {
  const accordion = document.getElementById("map-accordion");
  const label = document.getElementById("show-map-btn-label");
  const isOpen = !accordion.classList.contains("hidden");

  if (isOpen) {
    accordion.classList.add("hidden");
    label.textContent = "View Map of Homes Meeting Filter Criteria";
    return;
  }

  accordion.classList.remove("hidden");
  label.textContent = "Hide map";
  const canvas = document.getElementById("map-canvas");

  try {
    await loadMapsScript();
  } catch (e) {
    canvas.innerHTML = `<p style="padding:20px;color:#6b7280">Map isn't configured yet (missing API key).</p>`;
    return;
  }

  if (!mapInstance) {
    mapInstance = new google.maps.Map(canvas, {
      zoom: 6,
      center: { lat: 39.5, lng: -89.5 }, // rough Illinois-area default; auto-fits below anyway
    });
  } else {
    // Google Maps doesn't redraw correctly if its container was hidden
    // (display:none) at the time it was sized -- nudge it once the
    // accordion (and therefore the canvas) is actually visible again.
    google.maps.event.trigger(mapInstance, "resize");
  }
  if (!mapInfoWindow) {
    // Fixed 2026-08-22: without an explicit maxWidth, Google's InfoWindow
    // auto-sizing could clip/scroll our content rather than sizing cleanly
    // to it (Aaron reported real cutoff). 200 gives the 168px-wide
    // .map-popup a little breathing room inside Google's own chrome/padding.
    mapInfoWindow = new google.maps.InfoWindow({ maxWidth: 200 });
  }

  renderMapMarkers();
}

// Redraws markers from the CURRENT filter/search state (same matchesFilters
// used by the card grid), restricted to listings that actually have
// coordinates. Called on open, and again any time filters/search/sort
// change while the accordion is already open, so the map always mirrors
// what's showing in the card grid below it.
function renderMapMarkers() {
  if (!mapInstance) return; // map not initialized yet (accordion never opened) -- nothing to redraw
  const filtered = ALL_LISTINGS.filter((l) => matchesFilters(l) && l.lat != null && l.lng != null);

  for (const m of mapMarkers) m.setMap(null);
  mapMarkers = [];

  const bounds = new google.maps.LatLngBounds();
  for (const listing of filtered) {
    const pos = { lat: listing.lat, lng: listing.lng };
    const marker = new google.maps.Marker({
      position: pos, map: mapInstance, title: listing.address,
      icon: houseIconWithPrice(listing.down, listing.status),
    });
    // Click opens a popup with a condensed property card + a button through
    // to the full detail page, rather than jumping straight to the detail
    // page -- per Aaron's explicit 2026-08-22 request.
    marker.addListener("click", () => {
      mapInfoWindow.setContent(mapPopupContent(listing));
      mapInfoWindow.open({ anchor: marker, map: mapInstance });
    });
    mapMarkers.push(marker);
    bounds.extend(pos);
  }
  if (filtered.length > 0) mapInstance.fitBounds(bounds);
}

// True only when the map accordion is both rendered and actually open --
// used to decide whether a filter/search/sort change should bother
// redrawing map markers at all.
function isMapAccordionOpen() {
  const accordion = document.getElementById("map-accordion");
  return accordion && !accordion.classList.contains("hidden");
}

function mapPopupContent(listing) {
  const livabilitySuffix = listing.livability ? ` (${listing.livability})` : "";
  return `
    <div class="map-popup">
      <img class="map-popup-photo" src="${streetViewUrl(listing.address, 168, 96)}" alt="${escapeHtml(listing.address)}">
      <div class="map-popup-body">
        <div class="map-popup-status ${listing.status.toLowerCase()}">${listing.status.toUpperCase()}${escapeHtml(livabilitySuffix)}</div>
        <div class="map-popup-address">${escapeHtml(listing.address)}</div>
        <div class="map-popup-meta">${escapeHtml(listing.beds || "?")} bed / ${escapeHtml(listing.baths || "?")} bath</div>
        <div class="map-popup-money">${escapeHtml(listing.down)} down &middot; ${escapeHtml(listing.monthly)} a month</div>
        <button class="btn-primary map-popup-btn" onclick="showDetail('${listing.id}')">View Full Listing</button>
      </div>
    </div>
  `;
}

// ---------- 5 Easy Steps ----------
function initStepTabs() {
  document.querySelectorAll(".step-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".step-tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".step-content").forEach((c) => c.classList.add("hidden"));
      btn.classList.add("active");
      document.querySelector(`.step-content[data-step="${btn.dataset.step}"]`).classList.remove("hidden");
    });
  });
}

// ---------- Buyer Info form ----------
function initBuyerForm() {
  const form = document.getElementById("buyer-form");
  const status = document.getElementById("buyer-form-status");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!BUYER_INFO_ENDPOINT) {
      status.textContent = "Form isn't connected to a backend yet -- this is a UI preview.";
      return;
    }
    status.textContent = "Submitting...";
    try {
      const res = await fetch(BUYER_INFO_ENDPOINT, { method: "POST", body: new FormData(form) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      status.textContent = "Thanks! We've received your info.";
      form.reset();
    } catch (err) {
      status.textContent = "Something went wrong submitting your info -- please call or text us instead.";
    }
  });
}

// ---------- tab nav ----------
// Three separate nav instances now share the same tab set (top-tabs on wide
// screens, bottom-nav always, drawer on narrow screens) -- see the
// responsive-masthead rework, 2026-08-21. All three use the same .nav-btn
// class/data-tab convention, so switching tabs has to sync "active" across
// ALL instances with a matching data-tab, not just whichever one was
// physically clicked (otherwise e.g. a bottom-nav tap wouldn't be reflected
// if the viewport is later resized wide enough to show the top-tabs row).
const TAB_LABELS = {
  properties: "HOMES", steps: "NEXT STEPS", approved: "APPROVED!",
  buyer: "MY PROFILE",
};

function activateTab(tabName) {
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
  const panel = document.getElementById(`tab-${tabName}`);
  if (panel) panel.classList.remove("hidden");
  document.getElementById("mobile-current-tab").textContent = TAB_LABELS[tabName] || tabName.toUpperCase();
  if (tabName === "properties") backToList();
  closeDrawer();
}

function initNav() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });
}

// ---------- mobile drawer ----------
function openDrawer() {
  document.getElementById("nav-drawer").classList.remove("hidden");
  document.getElementById("nav-drawer-backdrop").classList.remove("hidden");
}
function closeDrawer() {
  document.getElementById("nav-drawer").classList.add("hidden");
  document.getElementById("nav-drawer-backdrop").classList.add("hidden");
}
function initDrawer() {
  document.getElementById("hamburger-btn").addEventListener("click", openDrawer);
  document.getElementById("nav-drawer-backdrop").addEventListener("click", closeDrawer);
}

// ---------- filter count badge ----------
// Counts active FILTER dimensions only (status/down/monthly/beds/area) --
// sort is an ordering preference, not a filter, and deliberately excluded
// per the same "sort is separate from filter" split as the UI itself.
function activeFilterCount() {
  let n = 0;
  if (filterState.status !== "Available") n++; // "Available" is the default/baseline again, not "Any"
  if (filterState.down) n++;
  if (filterState.monthly) n++;
  if (filterState.beds) n++;
  if (filterState.area.length > 0) n++;
  return n;
}
function updateFilterBadge() {
  const n = activeFilterCount();
  const badge = document.getElementById("filter-badge");
  badge.textContent = n;
  badge.classList.toggle("hidden", n === 0);
}

// ---------- shareable filter links ----------
// Encodes filterState (+ the free-text search box) into the URL query string
// so "Copy link to these results" produces a link that reproduces the same
// view when opened fresh, without needing any backend/state storage.
function applyFilterStateToControls() {
  document.getElementById("f-status").value = filterState.status;
  document.getElementById("f-sort").value = filterState.sort;
  document.getElementById("f-down").value = filterState.down || "";
  document.getElementById("f-monthly").value = filterState.monthly || "";
  document.getElementById("f-beds").value = filterState.beds || "";
  document.querySelectorAll("#area-checkboxes input[type=checkbox]").forEach((cb) => {
    cb.checked = filterState.area.includes(cb.value);
  });
}

function restoreFilterStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  if ([...params.keys()].length === 0) return;
  filterState = {
    status: params.get("status") || "Available",
    sort: params.get("sort") || "recent",
    down: parseFloat(params.get("down")) || null,
    monthly: parseFloat(params.get("monthly")) || null,
    beds: parseInt(params.get("beds"), 10) || null,
    area: params.get("area") ? params.get("area").split(",") : [],
  };
  if (params.get("q")) document.getElementById("search-box").value = params.get("q");
  applyFilterStateToControls();
}

function copyResultsLink() {
  const params = new URLSearchParams();
  if (filterState.status && filterState.status !== "Available") params.set("status", filterState.status);
  if (filterState.sort && filterState.sort !== "recent") params.set("sort", filterState.sort);
  if (filterState.down) params.set("down", filterState.down);
  if (filterState.monthly) params.set("monthly", filterState.monthly);
  if (filterState.beds) params.set("beds", filterState.beds);
  if (filterState.area.length > 0) params.set("area", filterState.area.join(","));
  const q = document.getElementById("search-box").value.trim();
  if (q) params.set("q", q);
  const qs = params.toString();
  const url = `${window.location.origin}${window.location.pathname}${qs ? "?" + qs : ""}`;
  const btn = document.getElementById("copy-link-btn");
  const done = () => {
    const original = btn.innerHTML;
    btn.textContent = "✓ Link copied!";
    setTimeout(() => { btn.innerHTML = original; }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => window.prompt("Copy this link:", url));
  } else {
    window.prompt("Copy this link:", url);
  }
}

// ---------- wiring ----------
// Filter and Sort are deliberately separate buttons/panels, per Aaron's
// explicit 2026-08-21 request -- opening one closes the other so only one
// dropdown-style panel is ever open at a time.
document.getElementById("filter-toggle").addEventListener("click", () => {
  document.getElementById("sort-panel").classList.add("hidden");
  document.getElementById("filter-panel").classList.toggle("hidden");
});
document.getElementById("sort-toggle").addEventListener("click", () => {
  document.getElementById("filter-panel").classList.add("hidden");
  document.getElementById("sort-panel").classList.toggle("hidden");
});
// Re-renders the card grid, and -- if the map accordion is currently open --
// the map's markers too, so the two never show a different set of listings
// from each other. Used everywhere filterState/search changes.
function refreshCardGridAndMap() {
  renderCardGrid();
  if (isMapAccordionOpen()) renderMapMarkers();
}

document.getElementById("sort-apply").addEventListener("click", () => {
  filterState.sort = document.getElementById("f-sort").value;
  document.getElementById("sort-panel").classList.add("hidden");
  refreshCardGridAndMap();
});
// Filters apply live as each control changes, per Aaron's 2026-08-22
// request -- no separate Apply button/click anymore. Deliberately does NOT
// close filter-panel on each change (unlike the old Apply flow), so
// adjusting several filters in a row doesn't require reopening the panel
// each time.
function applyFiltersFromControls() {
  filterState.status = document.getElementById("f-status").value;
  filterState.down = parseFloat(document.getElementById("f-down").value) || null;
  filterState.monthly = parseFloat(document.getElementById("f-monthly").value) || null;
  filterState.beds = parseInt(document.getElementById("f-beds").value, 10) || null;
  filterState.area = [...document.querySelectorAll("#area-checkboxes input[type=checkbox]:checked")].map((cb) => cb.value);
  updateFilterBadge();
  refreshCardGridAndMap();
}
document.getElementById("f-status").addEventListener("change", applyFiltersFromControls);
document.getElementById("f-down").addEventListener("change", applyFiltersFromControls);
document.getElementById("f-monthly").addEventListener("change", applyFiltersFromControls);
document.getElementById("f-beds").addEventListener("change", applyFiltersFromControls);
// Event delegation -- area checkboxes are (re)created dynamically by
// renderAreaCheckboxes(), so listening on the container itself (rather than
// each checkbox individually) keeps working regardless of when they were
// (re)generated.
document.getElementById("area-checkboxes").addEventListener("change", applyFiltersFromControls);

document.getElementById("filter-clear").addEventListener("click", () => {
  filterState.status = "Available"; // matches the real default again, per Aaron's 2026-08-22 request
  filterState.down = null;
  filterState.monthly = null;
  filterState.beds = null;
  filterState.area = [];
  applyFilterStateToControls();
  updateFilterBadge();
  refreshCardGridAndMap();
});
document.getElementById("copy-link-btn").addEventListener("click", copyResultsLink);
document.getElementById("search-box").addEventListener("input", refreshCardGridAndMap);
document.getElementById("show-map-btn").addEventListener("click", toggleMapAccordion);

// ---------- admin sign-in (Aaron only) ----------
// A small, deliberately unbranded lock icon in the header, not a visible
// "Sign in with Google" button on the public site. Real security is
// enforced server-side (the Worker verifies the token itself on every
// request) -- this is purely UI: whether to show the 5 admin-only fields
// on a listing's detail page, and whether to bother calling the admin API
// at all for a given visitor.
const ADMIN_OAUTH_CLIENT_ID = "74546128016-r0b13a553shc79gae1hf8r42nkd47t3i.apps.googleusercontent.com";
const ADMIN_API_URL = "https://super-frost-1dbb.notactuallyit.workers.dev";
const ADMIN_TOKEN_STORAGE_KEY = "admin_id_token";

// ---------- Login gate (2026-08-27) ----------
// Same Worker as the admin API above, new route -- no auth needed, this is
// the public lead-capture gate (see admin/worker.js's handleGateLogin).
const GATE_LOGIN_ENDPOINT = `${ADMIN_API_URL}/gate-login`;
const GATE_STORAGE_KEY = "iah_gate_passed";

function initLoginGate() {
  const gate = document.getElementById("login-gate");
  if (localStorage.getItem(GATE_STORAGE_KEY) === "1") {
    gate.classList.add("hidden");
    return;
  }
  const form = document.getElementById("gate-form");
  const status = document.getElementById("gate-status");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("gate-email").value.trim();
    const phone = document.getElementById("gate-phone").value.trim();
    const agreed = document.getElementById("gate-agree").checked;
    const honeypot = document.getElementById("gate-hp").value;

    // Bot filled the field only a script would find -- let it "through"
    // without ever telling it it was caught, and without writing a fake
    // row to the Sheet.
    if (honeypot) {
      localStorage.setItem(GATE_STORAGE_KEY, "1");
      gate.classList.add("hidden");
      return;
    }

    status.textContent = "Continuing...";
    try {
      const res = await fetch(GATE_LOGIN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, phone, agreed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      localStorage.setItem(GATE_STORAGE_KEY, "1");
      gate.classList.add("hidden");
    } catch (err) {
      status.textContent = "Something went wrong -- please try again, or call/text us at 618-418-4180.";
    }
  });
}

function decodeJwtPayload(token) {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(b64).split("").map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
    );
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

// Client-side expiry check only -- purely for UI (don't bother calling the
// admin API with a token we can already tell is stale). The Worker itself
// re-verifies the token independently on every request regardless; this
// check is never the actual security boundary.
function getStoredAdminToken() {
  const raw = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
  if (!raw) return null;
  const payload = decodeJwtPayload(raw);
  if (!payload || !payload.exp || payload.exp * 1000 < Date.now()) {
    localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    return null;
  }
  return raw;
}

function updateAdminButtonState() {
  const btn = document.getElementById("admin-login-btn");
  const logoutBtn = document.getElementById("admin-logout-btn");
  const signedIn = !!getStoredAdminToken();
  btn.classList.toggle("signed-in", signedIn);
  logoutBtn.classList.toggle("hidden", !signedIn);
}

function handleAdminCredentialResponse(response) {
  localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, response.credential);
  updateAdminButtonState();
  document.getElementById("admin-login-popover").classList.add("hidden");
  // If a listing detail page is already open, refresh it so the admin
  // fields appear immediately without needing to navigate away and back.
  if (!document.getElementById("view-detail").classList.contains("hidden")) {
    const match = window.location.hash.match(/^#listing\/(.+)$/);
    if (match) showDetail(match[1]);
  }
}

// Headers already shown somewhere on the public page (card/detail view) --
// The 4 original named admin fields, with their own friendly labels. Real
// header names (note "Lock box " has a trailing space -- that's the actual
// Sheet column name, confirmed against the live header row).
// 2026-08-22: reverted back to JUST these 4 -- a generic "show every other
// column" version was tried the same day, but Aaron changed his mind and
// wants only the original fields back.
const ADMIN_HEADLINE_FIELDS = [
  ["Total Price", "Total Price"],
  ["Additional Notes", "Additional Notes"],
  ["Lock box ", "Lock Box"],
  ["Seller name and link", "Seller Name/Link"],
  ["Quick Summary", "Quick Summary"], // added 2026-08-22, per Aaron's direct request
];

// Base Sheet URL for the "open the sheet" half of the copy-link-and-open
// button below -- just the whole spreadsheet, landed on the PROPERTIES tab
// (no attempt at a specific-row deep link; that was tried twice and
// confirmed broken, see the button's own comment).
const SHEET_BASE_URL = "https://docs.google.com/spreadsheets/d/1qDdTcKg2-myJVZkazVOneAAjMlFlMaGKKXlRK518WMk/edit#gid=1440969658";

function copyPhotoLinkAndOpenSheet(btn) {
  // Read the URL from a data attribute rather than inlining it into the
  // onclick string directly -- a photo link containing a stray quote
  // character could otherwise break out of the HTML attribute. Same
  // pattern already proven safe elsewhere in this file (copyResultsLink).
  const picsLink = btn.dataset.picsLink;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(picsLink).catch(() => {});
  }
  window.open(SHEET_BASE_URL, "_blank", "noopener");
}

async function renderAdminSection(listing) {
  const container = document.getElementById("admin-info-section");
  const token = getStoredAdminToken();
  if (!container) return;
  if (!token) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  container.classList.remove("hidden");
  container.innerHTML = `<div class="admin-info-title">Admin Info (only visible to you)</div><div class="admin-info-status">Loading...</div>`;
  try {
    const res = await fetch(`${ADMIN_API_URL}/?id=${encodeURIComponent(listing.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      container.innerHTML = `<div class="admin-info-title">Admin Info (only visible to you)</div><div class="admin-info-status">Unavailable (${res.status}).</div>`;
      return;
    }
    const data = await res.json();
    const fields = data.fields || {};

    let html = `<div class="admin-info-title">Admin Info (only visible to you)</div>`;
    for (const [header, label] of ADMIN_HEADLINE_FIELDS) {
      html += detailField(label, fields[header]);
    }
    // "Open the row" links/deep-links were confirmed broken twice (iOS app
    // handoff, and the app has no way to jump to a cell at all). This
    // instead copies the Photo Link -- already unique per listing, since
    // it's a real per-property share URL -- to the clipboard and opens the
    // whole Sheet, so Aaron can paste it into the Sheet's own in-app search
    // and land on exactly one row himself.
    if (listing.picsLink && listing.picsLink.trim()) {
      html += `<button class="btn-outline btn-full" type="button" onclick="copyPhotoLinkAndOpenSheet(this)" data-pics-link="${escapeHtml(listing.picsLink)}">Copy Photo Link &amp; Open Sheet</button>`;
    }
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="admin-info-title">Admin Info (only visible to you)</div><div class="admin-info-status">Request failed.</div>`;
  }
}

function initAdminUI() {
  document.getElementById("admin-login-btn").addEventListener("click", () => {
    document.getElementById("admin-login-popover").classList.toggle("hidden");
  });
  document.getElementById("admin-logout-btn").addEventListener("click", () => {
    localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    updateAdminButtonState();
    document.getElementById("admin-login-popover").classList.add("hidden");
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
  });
  // Google Identity Services' script loads async -- poll briefly rather
  // than assume it's ready by the time this runs.
  const tryInit = () => {
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.initialize({ client_id: ADMIN_OAUTH_CLIENT_ID, callback: handleAdminCredentialResponse });
      google.accounts.id.renderButton(document.getElementById("g_id_signin"), { theme: "outline", size: "medium" });
      updateAdminButtonState();
    } else {
      setTimeout(tryInit, 200);
    }
  };
  tryInit();
}

initNav();
initDrawer();
initStepTabs();
initBuyerForm();
initAdminUI();
initLoginGate();
loadData();

// PWA install support (2026-08-27) -- minimal service worker, exists mainly
// to satisfy Chrome/Android's "installable" criteria for a real Add-to-
// Home-Screen prompt. iOS has no equivalent auto-prompt regardless (Apple
// restriction, not something any site including Glide's can change) -- the
// manifest + apple-touch-icon + meta tags in index.html are what make
// iOS's manual Share > Add to Home Screen produce a proper full-screen icon.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

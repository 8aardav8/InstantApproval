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

let ALL_LISTINGS = [];
let GENERATED_AT = null;
// Redesigned 2026-08-29, per Aaron's direct request: appointments used to
// render as a standalone list at the bottom of Get Started; now they're
// embedded directly into the shared card component (buildListingCard), so
// a property with an active appointment shows it on its card wherever that
// card appears -- Homes, Favorites, and a new "Your Appointments" section
// at the top of Get Started. MY_APPOINTMENTS is this visitor's own
// (matched by their gate email, refreshed via refreshMyAppointments()).
// ADMIN_APPOINTMENTS_BY_ADDRESS and ADMIN_FAVORITES_BY_ADDRESS are the
// admin-only bulk views across ALL visitors (both refreshed together via
// refreshAdminActivity(), only ever populated once a verified admin token
// exists) -- entirely separate data, never conflated: a regular visitor
// only ever sees their OWN appointment/favorite on a card, never anyone
// else's. Favorites themselves stay real-time synced per visitor (see
// toggleFavorite()) so Aaron's bulk view stays accurate without needing a
// separate visitor-side mechanism.
let MY_APPOINTMENTS = [];
let ADMIN_APPOINTMENTS_BY_ADDRESS = {};
let ADMIN_FAVORITES_BY_ADDRESS = {};
// Public "most popular" sort support, added 2026-08-29 per Aaron's direct
// request. Deliberately NOT the same data as ADMIN_FAVORITES_BY_ADDRESS
// above -- that one carries real visitor names/emails/phones and is
// correctly gated behind an admin token; FAVORITE_COUNTS is a bare
// per-address count with zero visitor identity in it, fetched from its own
// public /favorite-counts endpoint, so every visitor can sort by it without
// crossing the privacy line the rest of this build has drawn everywhere
// else (counts are fine, identities are gated).
let FAVORITE_COUNTS = {};
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
  // Appointment data is an enhancement on top of already-complete cards,
  // not core content -- fetched AFTER the first render rather than
  // blocking it, then everything re-renders once each resolves. A visitor
  // with an active appointment (or an admin with the bulk view) briefly
  // sees plain cards before the banners/badges appear a moment later,
  // rather than a blank grid waiting on two extra network round trips.
  refreshMyAppointments().then(() => {
    renderMyAppointmentCards();
    renderCardGrid();
    renderFavoritesGrid();
  });
  refreshAdminActivity().then(() => {
    renderCardGrid();
    renderFavoritesGrid();
  });
  refreshFavoriteCounts().then(() => {
    // Only worth a re-render if "Most popular" is the active sort --
    // otherwise this data doesn't affect what's currently on screen.
    if (filterState.sort === "popular") {
      renderCardGrid();
      renderFavoritesGrid();
    }
  });
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
  } else if (filterState.sort === "popular") {
    // Most favorites first (FAVORITE_COUNTS -- public, count-only, see its
    // own comment). A listing with no favorites at all is simply absent
    // from FAVORITE_COUNTS, not an explicit 0 -- `|| 0` covers that. Ties
    // (including the common "0 vs 0" case) fall back to the same
    // recency ordering as the default sort, so the whole list still reads
    // sensibly below whatever few listings actually have real favorites.
    sorted.sort((a, b) => {
      const diff = (FAVORITE_COUNTS[b.address] || 0) - (FAVORITE_COUNTS[a.address] || 0);
      if (diff !== 0) return diff;
      const da = parseListingDate(a.lastUpdate);
      const db = parseListingDate(b.lastUpdate);
      if (da && db) return db - da;
      if (da) return -1;
      if (db) return 1;
      return 0;
    });
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
// Pulled out as its own function 2026-08-29 so both the Homes grid and the
// new Favorites grid render cards identically -- one implementation, not
// two copies that could drift apart.
function buildListingCard(listing) {
  const card = document.createElement("div");
  card.className = "card";
  card.addEventListener("click", () => showDetail(listing.id));

  // Photo-only positioning context, added 2026-08-29 -- real reported bug:
  // the heart/badges below were absolutely positioned relative to .card as
  // a whole, which happened to look right for the heart (the photo sits
  // first, at the card's own top edge) but put the appointments badge at
  // the bottom of the WHOLE card (including the price/beds text below the
  // photo), not the bottom of the photo itself, per Aaron's explicit ask.
  // Wrapping just the image gives these an anchor scoped to the photo only
  // -- same pattern already used for the detail view's .detail-photo-wrap.
  const photoWrap = document.createElement("div");
  photoWrap.className = "card-photo-wrap";
  card.appendChild(photoWrap);

  const img = document.createElement("img");
  img.loading = "lazy";
  img.src = streetViewUrl(listing.address, 400, 300);
  img.alt = listing.address;
  photoWrap.appendChild(img);

  // Heart/favorite toggle, added 2026-08-29. stopPropagation so tapping the
  // heart doesn't also trigger the card's own click-to-detail handler above.
  // data-listing-id + syncFavoriteHearts (below) fixed a real reported bug:
  // the Properties grid and Favorites grid each build their OWN independent
  // card for the same listing, so toggling a heart on one never touched the
  // other's separate DOM element -- unfavoriting from the Favorites tab
  // correctly removed the card there, but the same listing's heart on the
  // main Properties page stayed stuck red. Fixed by tagging every heart
  // button with the listing id it belongs to and, on any toggle, updating
  // every element sharing that id across the whole page in one pass.
  const heartBtn = document.createElement("button");
  heartBtn.type = "button";
  heartBtn.className = "card-heart" + (isFavorited(listing.id) ? " favorited" : "");
  heartBtn.dataset.listingId = listing.id;
  heartBtn.setAttribute("aria-label", "Save to favorites");
  heartBtn.innerHTML = ICON_HEART;
  heartBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(listing.id);
    syncFavoriteHearts(listing.id);
    // A class sync alone won't remove a now-unfavorited card from the
    // Favorites grid (that grid needs the DOM node actually gone, not just
    // unstyled) -- only rebuild it when it's the visible tab and this
    // listing just dropped out of favorites.
    const favTab = document.getElementById("tab-favorites");
    if (favTab && !favTab.classList.contains("hidden") && !isFavorited(listing.id)) {
      renderFavoritesGrid();
    }
  });
  photoWrap.appendChild(heartBtn);

  // Admin-only badges. Rearranged twice now: first (2026-08-29) to favorites
  // under the heart + appointments at the card's own bottom-right; then
  // (same day, real reported bug) moved into photoWrap above so BOTH anchor
  // to the bottom-right of the PHOTO specifically, not the whole card, and
  // restacked so appointments (blue) sits directly below favorites (red) --
  // see .admin-favorite-badge/.admin-appointment-badge in style.css for the
  // actual bottom offsets. Read from ADMIN_APPOINTMENTS_BY_ADDRESS /
  // ADMIN_FAVORITES_BY_ADDRESS (the bulk, all-visitors views, both
  // refreshed together via refreshAdminActivity()) -- completely separate
  // from MY_APPOINTMENTS below, which is this visitor's own and is all a
  // regular (non-admin) visitor ever sees on a card. getStoredAdminToken()
  // returning falsy for anyone who isn't Aaron, signed in, is what keeps
  // these invisible to everyone else -- the data itself is also never even
  // fetched unless a verified admin token exists (see refreshAdminActivity),
  // so there's nothing to leak either way. Each badge only renders at all
  // when its own count is actually > 0.
  if (getStoredAdminToken()) {
    const adminFavs = ADMIN_FAVORITES_BY_ADDRESS[listing.address] || [];
    if (adminFavs.length > 0) {
      const favBadge = document.createElement("span");
      favBadge.className = "admin-favorite-badge";
      favBadge.textContent = String(adminFavs.length);
      favBadge.title = `Favorited by ${adminFavs.length} visitor${adminFavs.length === 1 ? "" : "s"} (admin only)`;
      photoWrap.appendChild(favBadge);
    }
    const adminAppts = ADMIN_APPOINTMENTS_BY_ADDRESS[listing.address] || [];
    if (adminAppts.length > 0) {
      const badge = document.createElement("span");
      badge.className = "admin-appointment-badge";
      badge.textContent = String(adminAppts.length);
      badge.title = `${adminAppts.length} scheduled appointment${adminAppts.length === 1 ? "" : "s"} (admin only)`;
      photoWrap.appendChild(badge);
    }
  }

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

  // Embedded appointment banner(s), redesigned 2026-08-29 from a separate
  // list at the bottom of Get Started into part of the shared card itself,
  // per Aaron's direct request -- surfaces automatically on whichever
  // grid(s) this listing's card appears in (Homes, Favorites, and the
  // "Your Appointments" section at the top of Get Started), since they
  // all render through this same function. Only ever this visitor's OWN
  // appointment(s) (matched by their own gate email) -- never another
  // visitor's, which is exactly why this reads MY_APPOINTMENTS (this
  // browser's own fetch), not the admin-only bulk map above.
  for (const appt of appointmentsForAddress(listing.address)) {
    card.appendChild(buildAppointmentBanner(appt, localStorage.getItem(GATE_EMAIL_STORAGE_KEY)));
  }

  return card;
}

function renderCardGrid() {
  const grid = document.getElementById("card-grid");
  const empty = document.getElementById("empty-state");
  const filtered = sortListings(ALL_LISTINGS.filter(matchesFilters));
  grid.innerHTML = "";
  empty.classList.toggle("hidden", filtered.length > 0);
  for (const listing of filtered) grid.appendChild(buildListingCard(listing));
}

// ---------- Favorites (2026-08-29) ----------
// Local-to-this-device only (localStorage), same simplicity level as the
// gate itself -- not synced to the Sheet. A JSON array of listing ids.
const FAVORITES_STORAGE_KEY = "iah_favorites";
const ICON_HEART = '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>';

function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || "[]");
  } catch (e) {
    return [];
  }
}
function isFavorited(id) {
  return getFavorites().includes(id);
}
function toggleFavorite(id) {
  const favs = getFavorites();
  const i = favs.indexOf(id);
  if (i === -1) favs.push(id); else favs.splice(i, 1);
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favs));
  // Sync to the Sheet, added 2026-08-29 per Aaron's direct request (admin
  // visibility into who's favorited a property, with contact info) --
  // immediate, not debounced like the filter/search sync, since toggling a
  // heart is one deliberate action, not rapid-fire typing. Rides along in
  // the SAME /sync-visitor endpoint/payload as filters now (see
  // currentFilterSyncPayload) rather than a separate mechanism -- silently
  // a no-op if this browser never passed the gate, same as the filter sync.
  if (typeof syncVisitorNow === "function") syncVisitorNow();
}
// Converts this device's favorited listing IDs into real addresses for the
// Sheet sync -- IDs are a client-side slug (see slugify()), meaningless to
// Aaron/Nathan reading the Sheet directly; the address is what the
// appointments feature already stores there too, kept consistent.
function getFavoriteAddresses() {
  return getFavorites()
    .map((id) => ALL_LISTINGS.find((l) => l.id === id))
    .filter(Boolean)
    .map((l) => l.address);
}
// Added 2026-08-29 alongside the stale-heart bug fix -- a listing can have
// up to three separate heart-button DOM elements alive at once (its
// Properties-grid card, its Favorites-grid card if favorited, and the
// detail view if open on that listing). Call this after every
// toggleFavorite() so all of them agree with the new state in one pass,
// via the data-listing-id attribute every heart button now carries.
function syncFavoriteHearts(id) {
  const favored = isFavorited(id);
  document.querySelectorAll(`[data-listing-id="${id}"]`).forEach((el) => {
    el.classList.toggle("favorited", favored);
  });
}
function renderFavoritesGrid() {
  const grid = document.getElementById("favorites-grid");
  const empty = document.getElementById("favorites-empty-state");
  const favIds = getFavorites();
  const favListings = ALL_LISTINGS.filter((l) => favIds.includes(l.id));
  grid.innerHTML = "";
  empty.classList.toggle("hidden", favListings.length > 0);
  for (const listing of favListings) grid.appendChild(buildListingCard(listing));
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

  // Fixed 2026-08-29, real reported bug: #view-detail lives INSIDE
  // #tab-properties's own section, not as a top-level element -- clicking
  // a card from any OTHER tab that reuses buildListingCard (Favorites)
  // correctly called this function and correctly unhid #view-detail, but
  // #tab-properties itself was still hidden by activateTab()'s own
  // tab-switching, so nothing ever became visible. Ensure the Properties
  // tab-panel is the active one first, whichever tab this was actually
  // called from. activateTab("properties") also calls backToList()
  // internally, but that's harmless here -- it runs and completes before
  // the view-list/view-detail toggle immediately below, so the final state
  // still ends up correct (detail shown, not the list).
  if (document.getElementById("tab-properties").classList.contains("hidden")) {
    activateTab("properties");
  }

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
  const ICON_CALENDAR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="16" y1="3" x2="16" y2="7"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';

  const availableOnly = listing.status === "Available";
  const inquireBtn = availableOnly
    ? `<a class="btn-primary" href="${inquireLink(listing)}">${ICON_CHAT}Inquire</a>` : "";
  // Fixed 2026-08-21: this used to be a <button onclick="window.location.href=...">,
  // inconsistent with Inquire/Share (both plain <a href>) -- Aaron flagged it as
  // "didn't work like the others did." Same <a> pattern now, all three.
  const photoBtn = availableOnly
    ? `<a class="btn-outline btn-full" href="${photoNotWorkingLink(listing)}">${ICON_CAMERA}Photo link not working?</a>` : "";
  // "Schedule to Inspect" added 2026-08-29, Available-only (same rule as
  // Inquire/Photo-not-working) -- jumps to Get Started with this property
  // pre-selected. onclick calls goToGetStartedFor(id) rather than a plain
  // <a href="#tab-get-started">, since the property still needs to be
  // pre-selected in that form, not just the tab switched.
  const scheduleBtn = availableOnly
    ? `<button type="button" class="btn-outline btn-full" onclick="goToGetStartedFor('${listing.id}')">${ICON_CALENDAR}Schedule to Inspect</button>` : "";
  // Livability deliberately NOT shown here -- per Aaron's 2026-08-21 request,
  // it stays on the card only, not on the detail/properties page.

  detail.innerHTML = `
    <div class="detail-photo-wrap">
      <img class="detail-photo" src="${streetViewUrl(listing.address, 800, 500)}" alt="${escapeHtml(listing.address)}">
      <!-- Moved INSIDE .detail-photo-wrap 2026-08-29, real reported bug:
           this used to be a SIBLING of .detail-photo-wrap, so its
           "position: absolute; top: 0; left: 0" never actually anchored
           to the photo's own position: relative container -- it anchored
           to whatever ancestor further up the tree happened to have
           positioning context instead, landing it inside the fixed navy
           header bar rather than floating over the photo like it used to.
           Same container the heart button already correctly floats in. -->
      <button class="detail-back" onclick="backToList()">${ICON_BACK}</button>
      <button type="button" class="detail-heart${isFavorited(listing.id) ? " favorited" : ""}" data-listing-id="${listing.id}" aria-label="Save to favorites" onclick="toggleFavorite('${listing.id}'); syncFavoriteHearts('${listing.id}')">${ICON_HEART}</button>
    </div>
    <div class="detail-body">
      <div class="detail-status">${escapeHtml(listing.status)}</div>
      <div class="detail-address">${escapeHtml(listing.address)}</div>
      <div class="action-row">
        ${inquireBtn}
        <a class="btn-outline" href="${shareLink(listing)}">${ICON_LINK}Share</a>
      </div>
      <a class="btn-outline btn-full" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(listing.address)}" target="_blank" rel="noopener">${ICON_DIRECTIONS}Get Directions</a>
      ${scheduleBtn}
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

// ---------- Get Started form (rebuilt 2026-08-29 -- real backend now, was
// UI-only as "Buyer Info" before) ----------
// NOTE: UPLOAD_ID_ENDPOINT itself is declared down near ADMIN_API_URL (see
// below) -- it used to be declared right here, which was a real bug: this
// section runs before ADMIN_API_URL's own `const` is reached further down
// the file, so referencing it here threw "Cannot access 'ADMIN_API_URL'
// before initialization" on every page load. That's a synchronous,
// uncaught top-level error, which aborted the ENTIRE rest of this script
// -- including the call to initLoginGate() at the bottom of the file --
// which is why the gate's submit button never got its JS handler and fell
// through to a native form submission (page "reload", fields cleared,
// visitor never let in). Fixed 2026-08-28 by moving the declaration to
// after ADMIN_API_URL actually exists.
// Set by goToGetStartedFor() (called from the detail page's "Schedule to
// Inspect" button) -- read once by populateGetStartedPropertyDropdown()
// the next time it runs, then cleared, so it doesn't stick around and
// wrongly re-apply on some later, unrelated visit to this tab.
let pendingGetStartedPropertyId = null;

function goToGetStartedFor(listingId) {
  pendingGetStartedPropertyId = listingId;
  activateTab("get-started");
}

// Rebuilt 2026-08-29 as a type-to-filter autocomplete -- real reported
// request: the plain <select> listed every Available property in one long
// native dropdown, painful to scroll through against a real inventory.
// The visible text input (#get-started-property-input) is what the user
// types into; the hidden input (#get-started-property, name="property")
// is what actually submits -- same field/value shape (an address string)
// admin/worker.js already expected, so the backend needed no changes.
let getStartedAutocompleteWired = false;

function getStartedAvailableListings() {
  // Available-only, per Aaron's explicit instruction -- matches the
  // filter the old <select> already applied; preserved deliberately, not
  // just carried over by accident, while rebuilding this control.
  return ALL_LISTINGS.filter((l) => l.status === "Available")
    .sort((a, b) => a.address.localeCompare(b.address));
}

function populateGetStartedPropertyDropdown() {
  const input = document.getElementById("get-started-property-input");
  const hidden = document.getElementById("get-started-property");
  const list = document.getElementById("get-started-property-options");
  if (!input || !hidden || !list) return;

  // Wire event listeners exactly once -- this function runs on every visit
  // to this tab (see activateTab), but re-adding listeners each time would
  // stack duplicates.
  if (!getStartedAutocompleteWired) {
    getStartedAutocompleteWired = true;
    let activeIndex = -1;

    function selectAddress(address) {
      input.value = address;
      hidden.value = address;
      input.setCustomValidity("");
      list.classList.add("hidden");
    }

    function renderOptions(query) {
      const q = query.trim().toLowerCase();
      // Cap at 8 -- "drastically reduce options," per Aaron's own wording,
      // not just "filter." An untyped focus (query "") still shows the
      // first 8 alphabetically rather than nothing, so the field doesn't
      // look broken/empty the moment it's focused.
      const matches = getStartedAvailableListings()
        .filter((l) => !q || l.address.toLowerCase().includes(q))
        .slice(0, 8);
      list.innerHTML = "";
      activeIndex = -1;
      if (matches.length === 0) {
        const li = document.createElement("li");
        li.className = "no-results";
        li.textContent = "No matching properties";
        list.appendChild(li);
      } else {
        matches.forEach((listing) => {
          const li = document.createElement("li");
          li.textContent = listing.address;
          li.dataset.address = listing.address;
          // mousedown, not click -- fires before the input's blur handler
          // below would otherwise close the list first and swallow the tap.
          li.addEventListener("mousedown", (e) => {
            e.preventDefault();
            selectAddress(listing.address);
          });
          list.appendChild(li);
        });
      }
      list.classList.remove("hidden");
    }

    input.addEventListener("input", () => {
      // Any manual retyping invalidates a previously-confirmed selection --
      // require picking an option again (native validation, via
      // setCustomValidity below) rather than letting free-typed text that
      // never matched a real listing slip through as the submitted value.
      hidden.value = "";
      input.setCustomValidity(input.value.trim() ? "Please choose a property from the list." : "");
      renderOptions(input.value);
    });
    input.addEventListener("focus", () => renderOptions(input.value));
    input.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 150));
    input.addEventListener("keydown", (e) => {
      const items = Array.from(list.querySelectorAll("li:not(.no-results)"));
      if (list.classList.contains("hidden") || items.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
      } else if (e.key === "Enter") {
        if (activeIndex >= 0) { e.preventDefault(); selectAddress(items[activeIndex].dataset.address); }
        return;
      } else if (e.key === "Escape") {
        list.classList.add("hidden");
        return;
      } else {
        return;
      }
      items.forEach((li, i) => li.classList.toggle("active", i === activeIndex));
    });
  }

  if (pendingGetStartedPropertyId) {
    const listing = ALL_LISTINGS.find((l) => l.id === pendingGetStartedPropertyId);
    if (listing) {
      input.value = listing.address;
      hidden.value = listing.address;
      input.setCustomValidity("");
    }
    pendingGetStartedPropertyId = null;
  }
}

function prefillGetStartedContactFields() {
  document.getElementById("get-started-name").value = localStorage.getItem(GATE_NAME_STORAGE_KEY) || "";
  document.getElementById("get-started-email").value = localStorage.getItem(GATE_EMAIL_STORAGE_KEY) || "";
  document.getElementById("get-started-phone").value = localStorage.getItem(GATE_PHONE_STORAGE_KEY) || "";
}

// Extracted 2026-08-29 from the date-min fix into a shared top-level
// function -- the appointments banner (below) needs the exact same
// "visitor's own local calendar day" logic to decide which appointments
// still count as upcoming, and duplicating it risked the two definitions
// silently drifting apart later.
function localTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Added 2026-08-29 per Aaron's direct request ("Calendar for scheduling
// should only display today, and the following 10 days") -- generalizes
// localTodayISO() to compute an offset date, used for the date pickers'
// `max` attribute. Same local Y/M/D approach, not UTC, for the identical
// reason localTodayISO() itself exists.
function localDatePlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- Appointments (redesigned 2026-08-29) ----------
// Split into a data-only refresh (refreshMyAppointments) and a render step
// (renderMyAppointmentCards, used only for the "Your Appointments" section
// at the top of Get Started) -- the OTHER two places an appointment can now
// show, a card in the Homes grid or the Favorites grid, don't need a
// dedicated render function at all: buildListingCard() itself embeds the
// banner automatically for any listing with a match, so renderCardGrid()/
// renderFavoritesGrid() already pick it up as a side effect of their own
// normal rendering. MY_APPOINTMENTS is refreshed here; the Sheet stays the
// one source of truth throughout, same principle as the original design --
// Cancel/Change Date always re-fetch fresh afterward rather than trusting
// an optimistic local update.
async function refreshMyAppointments() {
  const email = localStorage.getItem(GATE_EMAIL_STORAGE_KEY);
  if (!email) {
    MY_APPOINTMENTS = [];
    return;
  }
  try {
    const res = await fetch(`${MY_APPOINTMENTS_ENDPOINT}?email=${encodeURIComponent(email)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const today = localTodayISO();
    MY_APPOINTMENTS = (data.appointments || [])
      .filter((a) => a.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch (err) {
    // Best-effort -- a failed fetch just means no banners show anywhere,
    // not a visitor-facing error (they can still submit a new appointment
    // via the form regardless).
    MY_APPOINTMENTS = [];
  }
}

function appointmentsForAddress(address) {
  return MY_APPOINTMENTS.filter((a) => a.address === address);
}

// "Your Appointments" section at the top of Get Started, replacing the old
// standalone banner list -- one property card per listing with an active
// appointment (via buildListingCard, same as Homes/Favorites, same grid
// sizing as the Homes page), so it's clickable through to the real detail
// page and gets the same photo/address/price context, not just a bare
// address string. Rebuilt 2026-08-29 into a collapsed-by-default accordion
// behind an "N viewings scheduled" toggle, per Aaron's direct request (the
// label wording itself was tightened once more the same day) -- the
// toggle click handler itself is wired once in
// initAppointmentsAccordionToggle() below, not here, since this function
// runs on every refresh/re-render and would otherwise stack duplicate
// listeners.
function renderMyAppointmentCards() {
  const accordion = document.getElementById("appointments-accordion");
  const wrap = document.getElementById("appointments-banner-wrap");
  const label = document.getElementById("appointments-accordion-label");
  const toggle = document.getElementById("appointments-accordion-toggle");
  if (!accordion || !wrap) return;
  const addresses = [...new Set(MY_APPOINTMENTS.map((a) => a.address))];
  const listings = addresses.map((addr) => ALL_LISTINGS.find((l) => l.address === addr)).filter(Boolean);
  wrap.innerHTML = "";
  if (listings.length === 0) {
    accordion.classList.add("hidden");
    return;
  }
  accordion.classList.remove("hidden");
  // Always starts collapsed on a fresh render (a new booking, a cancel, a
  // reschedule, or simply revisiting this tab) -- simpler and more
  // predictable than trying to preserve expand state across a rebuild.
  wrap.classList.add("hidden");
  if (toggle) toggle.classList.remove("expanded");
  if (label) label.textContent = `${listings.length} viewing${listings.length === 1 ? "" : "s"} scheduled`;
  for (const listing of listings) wrap.appendChild(buildListingCard(listing));
}

function initAppointmentsAccordionToggle() {
  const toggle = document.getElementById("appointments-accordion-toggle");
  const wrap = document.getElementById("appointments-banner-wrap");
  if (!toggle || !wrap) return;
  toggle.addEventListener("click", () => {
    const showing = !wrap.classList.contains("hidden");
    wrap.classList.toggle("hidden", showing);
    toggle.classList.toggle("expanded", !showing);
  });
}

// ---------- Pull-to-refresh (2026-08-29) ----------
// A custom gesture, not a free native browser feature -- see the HTML
// comment on #pull-refresh-indicator for why this had to be built rather
// than relied on (the footer-overscroll fix specifically disables the
// native rubber-band gesture Chrome/Android would otherwise use to trigger
// its own pull-to-refresh, and installed standalone PWAs don't reliably
// get a native one on either platform either way). A real full
// location.reload() on release past the threshold -- simplest way to
// guarantee EVERYTHING is genuinely fresh (listings, admin badges,
// appointments, favorites), matching Aaron's own explicit ask ("reload"),
// not a partial re-fetch of just one piece of state.
const PULL_REFRESH_THRESHOLD = 70; // px of downward drag needed to trigger a reload
const PULL_REFRESH_MAX = 100; // visual cap so the indicator can't be dragged indefinitely
function initPullToRefresh() {
  const indicator = document.getElementById("pull-refresh-indicator");
  const text = document.getElementById("pull-refresh-text");
  if (!indicator || !text) return;

  let startY = null;
  let pulling = false;
  let currentPull = 0;

  function setPull(px) {
    currentPull = px;
    indicator.style.marginTop = `${-50 + px}px`;
    text.textContent = px >= PULL_REFRESH_THRESHOLD ? "↑ Release to refresh" : "↓ Pull to refresh";
  }

  function reset() {
    indicator.classList.remove("dragging");
    indicator.style.marginTop = "";
    text.textContent = "↓ Pull to refresh";
    startY = null;
    pulling = false;
    currentPull = 0;
  }

  document.addEventListener(
    "touchstart",
    (e) => {
      // Single-touch only (ignore pinch-zoom), and only from the very top
      // of the page -- if there's room to scroll up first, a downward drag
      // should scroll normally, not trigger a refresh.
      if (e.touches.length !== 1 || window.scrollY > 0) return;
      startY = e.touches[0].clientY;
      pulling = true;
      indicator.classList.add("dragging");
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!pulling || startY === null || e.touches.length !== 1) return;
      const deltaY = e.touches[0].clientY - startY;
      // Genuinely pulling down from the top -- claim the gesture (prevents
      // any residual native scroll/selection behavior while dragging) and
      // move the indicator. A negative/zero delta (finger moving up, or a
      // normal scroll took over because more content exists) means this
      // isn't a pull-to-refresh drag -- let it go, don't fight the page.
      if (deltaY > 0 && window.scrollY <= 0) {
        e.preventDefault();
        setPull(Math.min(deltaY, PULL_REFRESH_MAX));
      } else if (currentPull > 0) {
        reset();
      }
    },
    { passive: false }
  );

  document.addEventListener("touchend", () => {
    if (!pulling) return;
    if (currentPull >= PULL_REFRESH_THRESHOLD) {
      text.textContent = "↻ Refreshing...";
      location.reload();
      return; // leave the indicator showing through the reload
    }
    reset();
  });
  document.addEventListener("touchcancel", reset);
}

function formatAppointmentDate(iso) {
  // "2026-09-05" -> "Fri, Sep 5, 2026". Parsed as local, not UTC -- new
  // Date("2026-09-05") would parse as UTC midnight, which can display as
  // the PREVIOUS day for anyone west of UTC. Same class of bug already
  // fixed once this session for the date min= logic.
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

// After every successful Cancel/Change Date, re-fetch and re-render
// everywhere an appointment-bearing card could be showing right now --
// cheap regardless of which tab is actually visible (matches this
// codebase's existing "always safe to re-render, even hidden panels"
// convention), and guarantees whichever tab the visitor looks at next is
// already correct without needing a reload.
async function refreshAndRerenderAppointments() {
  await refreshMyAppointments();
  renderMyAppointmentCards();
  renderCardGrid();
  renderFavoritesGrid();
}

// Embedded inside a card by buildListingCard() -- no longer a standalone
// element, so the address line was dropped (the card itself already shows
// it) and a single stopPropagation on the whole banner replaces needing it
// on every individual button, since any click here must never also
// trigger the card's own click-to-detail handler.
function buildAppointmentBanner(appt, email) {
  const banner = document.createElement("div");
  banner.className = "appointment-banner";
  banner.dataset.slot = appt.slot;
  banner.addEventListener("click", (e) => e.stopPropagation());

  const date = document.createElement("div");
  date.className = "appointment-date";
  date.textContent = `Your appointment: ${formatAppointmentDate(appt.date)}`;
  banner.appendChild(date);

  const actions = document.createElement("div");
  actions.className = "appointment-actions";

  const changeBtn = document.createElement("button");
  changeBtn.type = "button";
  changeBtn.className = "btn-small";
  changeBtn.textContent = "Change Date";

  const datePicker = document.createElement("input");
  datePicker.type = "date";
  datePicker.className = "appt-date-picker hidden";
  datePicker.min = localTodayISO();
  // Same 10-day upper bound as the initial booking date field, added
  // 2026-08-29 per Aaron's direct request -- rescheduling shouldn't be
  // able to reach further out than a fresh booking could.
  datePicker.max = localDatePlusDays(10);
  datePicker.value = appt.date;

  changeBtn.addEventListener("click", () => {
    const showing = !datePicker.classList.contains("hidden");
    datePicker.classList.toggle("hidden", showing);
    if (!showing) datePicker.focus();
  });

  datePicker.addEventListener("change", async () => {
    const newDate = datePicker.value;
    if (!newDate || newDate < localTodayISO() || newDate > localDatePlusDays(10)) return; // native min=/max= already guard this, belt-and-suspenders
    changeBtn.disabled = true;
    try {
      const res = await fetch(UPDATE_APPOINTMENT_DATE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, slot: appt.slot, newDate }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Fall through to the re-render below regardless -- it will just
      // show the OLD date again if the write actually failed, which is an
      // honest reflection of the Sheet's real state rather than a
      // silently-wrong optimistic update.
    }
    refreshAndRerenderAppointments();
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn-small btn-danger";
  cancelBtn.textContent = "Cancel Viewing";
  cancelBtn.addEventListener("click", async () => {
    if (!confirm(`Cancel your viewing at ${appt.address} on ${formatAppointmentDate(appt.date)}?`)) return;
    cancelBtn.disabled = true;
    try {
      const res = await fetch(CANCEL_APPOINTMENT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, slot: appt.slot }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Same honest-reflection reasoning as Change Date above.
    }
    refreshAndRerenderAppointments();
  });

  actions.appendChild(changeBtn);
  actions.appendChild(datePicker);
  actions.appendChild(cancelBtn);
  banner.appendChild(actions);
  return banner;
}

// ---------- Admin bulk activity: appointments + favorites (2026-08-29) ----------
// Aaron's own request, admin-only: small badges on every card (opposite
// the heart) showing how many people have scheduled a viewing and/or
// favorited it, plus who/when/contact-info on the detail page for both.
// Entirely separate from MY_APPOINTMENTS above -- this is the bulk,
// all-visitors view, only ever fetched once a verified admin token exists,
// never for a regular visitor. One request covers both datasets (see
// admin/worker.js job 6) since they come from the same underlying rows.
async function refreshAdminActivity() {
  const token = getStoredAdminToken();
  if (!token) {
    ADMIN_APPOINTMENTS_BY_ADDRESS = {};
    ADMIN_FAVORITES_BY_ADDRESS = {};
    return;
  }
  try {
    const res = await fetch(ADMIN_ACTIVITY_ENDPOINT, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const today = localTodayISO();

    const groupedAppts = {};
    for (const appt of data.appointments || []) {
      if (appt.date < today) continue; // only count/show upcoming, matching the visitor-facing definition
      (groupedAppts[appt.address] = groupedAppts[appt.address] || []).push(appt);
    }
    for (const list of Object.values(groupedAppts)) list.sort((a, b) => a.date.localeCompare(b.date));
    ADMIN_APPOINTMENTS_BY_ADDRESS = groupedAppts;

    // Favorites have no date to filter by -- an unfavorite just removes
    // the entry entirely, so everything returned is, by definition, a
    // currently-active favorite.
    const groupedFavs = {};
    for (const fav of data.favorites || []) {
      (groupedFavs[fav.address] = groupedFavs[fav.address] || []).push(fav);
    }
    ADMIN_FAVORITES_BY_ADDRESS = groupedFavs;
  } catch (err) {
    ADMIN_APPOINTMENTS_BY_ADDRESS = {};
    ADMIN_FAVORITES_BY_ADDRESS = {};
  }
}

// Public "most popular" sort data, added 2026-08-29 per Aaron's direct
// request -- fetched for EVERY visitor, not just admin (see
// FAVORITE_COUNTS_ENDPOINT's own comment for why this is safe/separate
// from the admin-only bulk view above: bare counts only, no identity).
async function refreshFavoriteCounts() {
  try {
    const res = await fetch(FAVORITE_COUNTS_ENDPOINT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    FAVORITE_COUNTS = data.counts || {};
  } catch (err) {
    // Best-effort -- a failed fetch just means "Most popular" sorts as if
    // every listing had 0 favorites (a stable, harmless fallback), not a
    // visitor-facing error.
    FAVORITE_COUNTS = {};
  }
}

// Added 2026-08-29 per Aaron's request -- once someone's uploaded an ID,
// they shouldn't have to re-upload the same file to book a second (or
// third...) appointment in the same visit. In-memory only (a plain JS
// variable, not localStorage -- File/Blob objects can't be serialized into
// storage anyway, and Aaron's own framing was specifically "without
// reloading," so losing this on an actual page reload is expected, not a
// gap). Re-applied to the file input via the DataTransfer API, which is
// the real, standards-based way to programmatically set an <input
// type="file">'s selected files -- legitimate here since the File object
// itself always originated from a genuine prior user gesture (they picked
// it once via the OS file/photo picker), not fabricated or read from disk
// without their action.
let lastUploadedIdPhoto = null;

function updateIdPhotoStatus() {
  const el = document.getElementById("get-started-id-status");
  if (!el) return;
  if (lastUploadedIdPhoto) {
    el.textContent = `✓ ID on file: ${lastUploadedIdPhoto.name}`;
    el.classList.remove("hidden");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
  }
}

function initGetStartedForm() {
  const form = document.getElementById("get-started-form");
  const status = document.getElementById("get-started-status");
  const idPhotoInput = document.getElementById("get-started-id-photo");

  // Track whatever the visitor actually picks, whether that's their first
  // upload or a deliberate swap to a different file for a second buyer --
  // a fresh manual selection always wins and becomes the new "remembered"
  // one going forward.
  idPhotoInput.addEventListener("change", () => {
    lastUploadedIdPhoto = idPhotoInput.files[0] || null;
    updateIdPhotoStatus();
  });

  // Prefill from whatever this browser already gave at the gate -- still
  // editable, in case something's wrong or a different buyer is using the
  // same device.
  prefillGetStartedContactFields();
  renderMyAppointmentCards();

  // Don't let anyone pick a date before today. Fixed 2026-08-29, real
  // reported bug: this previously used toISOString(), which reports the
  // UTC date, not the visitor's own local date -- for anyone west of UTC
  // (this site's whole US audience), UTC can already be "tomorrow" for
  // several hours of the local evening, which would wrongly compute
  // today's own local date as before the "min" and block it as if it were
  // in the past. Uses localTodayISO() (local Y/M/D components) instead so
  // "today" always means the visitor's own actual today -- shared with the
  // appointments banner below, not duplicated.
  const dateInput = document.getElementById("get-started-date");
  dateInput.min = localTodayISO();
  // Upper bound added 2026-08-29 per Aaron's direct request -- only today
  // plus the following 10 days are choosable at all (an 11-day window).
  dateInput.max = localDatePlusDays(10);
  // Belt-and-suspenders on top of the native min=/max= constraints -- some
  // mobile date pickers only grey out/block out-of-range dates in their
  // own picker UI without necessarily stopping every path to a manually-
  // typed out-of-range value from landing in the field. Explicitly
  // re-validate on change and clear anything that slips through anyway.
  dateInput.addEventListener("change", () => {
    if (dateInput.value && (dateInput.value < localTodayISO() || dateInput.value > localDatePlusDays(10))) {
      dateInput.value = "";
      dateInput.setCustomValidity("Please choose a date within the next 10 days.");
    } else {
      dateInput.setCustomValidity("");
    }
  });

  populateGetStartedPropertyDropdown();

  // "Booked!" confirmation popup, added 2026-08-29 per Aaron's direct
  // request -- wired once here (initGetStartedForm only ever runs once,
  // see the bottom init sequence), shown on every successful submission
  // via showBookingConfirmPopup() below.
  document.getElementById("booking-confirm-dismiss").addEventListener("click", () => {
    document.getElementById("booking-confirm-popup").classList.add("hidden");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.textContent = "Uploading...";
    try {
      const res = await fetch(UPLOAD_ID_ENDPOINT, { method: "POST", body: new FormData(form) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      status.textContent = "Thanks! We've got your info and ID on file.";
      document.getElementById("booking-confirm-popup").classList.remove("hidden");
      form.reset();
      prefillGetStartedContactFields(); // reset() above wipes the prefilled contact fields too -- put them back
      // reset() also clears the file input -- re-apply the same ID photo
      // via DataTransfer so the next appointment doesn't need it re-picked.
      if (lastUploadedIdPhoto) {
        const dt = new DataTransfer();
        dt.items.add(lastUploadedIdPhoto);
        idPhotoInput.files = dt.files;
      }
      updateIdPhotoStatus();
      refreshAndRerenderAppointments(); // show the just-created appointment immediately, on this card and everywhere else it appears
    } catch (err) {
      status.textContent = "Something went wrong -- please try again, or call/text us at 618-418-4180.";
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
  properties: "HOMES", steps: "HOW IT WORKS", approved: "APPROVED!",
  "get-started": "GET STARTED", favorites: "FAVORITES",
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
  // Re-render on every visit, not just once at load, so a heart tapped
  // from the Homes/detail views elsewhere in the app shows up immediately
  // -- and so a property picked via "Schedule to Inspect" (which calls
  // activateTab("get-started") itself) gets the dropdown pre-selected.
  if (tabName === "favorites") renderFavoritesGrid();
  // Also re-run the contact-field prefill here, not just from the gate's
  // own submit handler -- a cheap, idempotent defensive re-sync so this
  // tab always reflects the freshest gate values no matter how it was
  // reached, rather than depending on exactly one call site staying correct.
  if (tabName === "get-started") { populateGetStartedPropertyDropdown(); prefillGetStartedContactFields(); renderMyAppointmentCards(); }
  closeDrawer();
}

function initNav() {
  // [data-tab] added 2026-08-29 -- the new persistent "Download App" menu
  // items (see initInstallUI) reuse the .nav-btn class for visual
  // consistency but aren't tabs at all, and have no data-tab attribute.
  // Every real tab button already has one, so this scopes the selector
  // without changing behavior for any of them.
  document.querySelectorAll(".nav-btn[data-tab]").forEach((btn) => {
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
// Bulk admin activity (appointments + favorites across all visitors),
// added 2026-08-29 -- see admin/worker.js job 6 (handleAdminActivity).
const ADMIN_ACTIVITY_ENDPOINT = `${ADMIN_API_URL}/admin-activity`;
// Public per-address favorite COUNTS (no auth, no identity) -- see
// admin/worker.js's handleFavoriteCounts, added right alongside
// handleAdminActivity but deliberately a separate, unauthenticated route.
const FAVORITE_COUNTS_ENDPOINT = `${ADMIN_API_URL}/favorite-counts`;

// ---------- Login gate (2026-08-27) ----------
// Same Worker as the admin API above, new route -- no auth needed, this is
// the public lead-capture gate (see admin/worker.js's handleGateLogin).
const GATE_LOGIN_ENDPOINT = `${ADMIN_API_URL}/gate-login`;
const UPLOAD_ID_ENDPOINT = `${ADMIN_API_URL}/upload-id`;
// Appointment scheduling, added 2026-08-29 -- see admin/worker.js's job 5
// for the full design (slots stored as "<address> | <date>" in App:
// Logins columns O-X, read live on every visit, never cached locally).
const MY_APPOINTMENTS_ENDPOINT = `${ADMIN_API_URL}/my-appointments`;
const CANCEL_APPOINTMENT_ENDPOINT = `${ADMIN_API_URL}/cancel-appointment`;
const UPDATE_APPOINTMENT_DATE_ENDPOINT = `${ADMIN_API_URL}/update-appointment-date`;
const GATE_STORAGE_KEY = "iah_gate_passed";
// Added 2026-08-29 alongside visitor filter-sync -- the gate previously
// only stored a bare "passed" flag, with no way to attribute a later
// visit/filter-change back to a specific person. Storing the email too
// (already given voluntarily at gate time) is what makes that possible.
const GATE_EMAIL_STORAGE_KEY = "iah_gate_email";
// Added 2026-08-29 alongside the Get Started page -- that page prefills
// Name/Email/Phone from whatever the visitor already gave at the gate, so
// all three need to be persisted now, not just email.
const GATE_NAME_STORAGE_KEY = "iah_gate_name";
const GATE_PHONE_STORAGE_KEY = "iah_gate_phone";

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
    const name = document.getElementById("gate-name").value.trim();
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
        body: JSON.stringify({ name, email, phone, agreed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      localStorage.setItem(GATE_STORAGE_KEY, "1");
      localStorage.setItem(GATE_EMAIL_STORAGE_KEY, email);
      localStorage.setItem(GATE_NAME_STORAGE_KEY, name);
      localStorage.setItem(GATE_PHONE_STORAGE_KEY, phone);
      gate.classList.add("hidden");
      // Real reported bug, fixed 2026-08-29: prefillGetStartedContactFields()
      // was only ever called once, at initial page load, via
      // initGetStartedForm() -- for a first-time visitor who submits the
      // gate and THEN visits Get Started in that same page session (no
      // reload), that one-shot call already ran before this localStorage
      // write ever happened, so it read empty values and never re-ran.
      // Calling it again right here, the moment real values exist, closes
      // that gap. Guarded since this function is declared later in the
      // file but is a hoisted `function` declaration, not a `const`, so
      // this call is safe regardless of source order (see the ADMIN_API_URL
      // TDZ bug fixed the same day for why that distinction matters here).
      if (typeof prefillGetStartedContactFields === "function") prefillGetStartedContactFields();
      // Same timing-bug class, fixed 2026-08-29: a RETURNING visitor (real
      // existing appointments on the Sheet) who cleared localStorage and
      // re-gates on this device wouldn't see their own appointment cards
      // until a reload, since the initial refreshMyAppointments() in
      // loadData() already ran (and found no email) before this write ever
      // happened. Calling it again right here closes that gap too.
      if (typeof refreshAndRerenderAppointments === "function") refreshAndRerenderAppointments();
    } catch (err) {
      status.textContent = "Something went wrong -- please try again, or call/text us at 618-418-4180.";
    }
  });
}

// ---------- Visitor filter-sync (2026-08-29) ----------
// Keeps each returning visitor's row in App: Logins current -- Last Login
// plus their current search filters and free-text search term -- so Aaron
// can ask Nathan things like "who wants a 3-bed in East St. Louis" and get
// a real, live-queried answer. Writes directly via the Worker, no approval
// gate, no Nathan/LLM involved at all -- this is a routine, no-judgment
// refresh of an already-consented person's own preferences, not a new
// contact being created (that part still goes through the existing
// check-in-and-approve flow untouched). Silently a no-op if this browser
// never actually passed the gate (nothing to attribute the sync to).
const SYNC_VISITOR_ENDPOINT = `${ADMIN_API_URL}/sync-visitor`;

function currentFilterSyncPayload() {
  return {
    email: localStorage.getItem(GATE_EMAIL_STORAGE_KEY),
    filters: {
      sort: filterState.sort,
      down: filterState.down,
      monthly: filterState.monthly,
      beds: filterState.beds,
      area: filterState.area,
    },
    search: document.getElementById("search-box").value.trim(),
    // Added 2026-08-29 -- always the FULL current list, same "resend
    // everything, not a diff" approach already used for filters above.
    favorites: getFavoriteAddresses(),
  };
}

function syncVisitorNow() {
  const payload = currentFilterSyncPayload();
  if (!payload.email) return; // never passed the gate in this browser -- nothing to attribute this to
  // Best-effort, fire-and-forget -- a missed sync just means slightly
  // stale filter columns until the next one, never a broken page. Never
  // surfaced to the visitor either way.
  fetch(SYNC_VISITOR_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function initVisitorSync() {
  if (!localStorage.getItem(GATE_EMAIL_STORAGE_KEY)) return;

  // Once on load -- covers "just opened the app," updating Last Login even
  // if they don't touch a single filter this visit.
  syncVisitorNow();

  // Debounced on every filter/search change -- these already fire live per
  // keystroke/click (see applyFiltersFromControls and the search-box
  // "input" listener), which would mean a request per keystroke without
  // this. 1.5s of no further changes before actually sending.
  let debounceTimer = null;
  const scheduleSync = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(syncVisitorNow, 1500);
  };
  document.getElementById("f-sort").addEventListener("change", scheduleSync);
  document.getElementById("f-status").addEventListener("change", scheduleSync);
  document.getElementById("f-down").addEventListener("change", scheduleSync);
  document.getElementById("f-monthly").addEventListener("change", scheduleSync);
  document.getElementById("f-beds").addEventListener("change", scheduleSync);
  document.querySelectorAll("#area-checkboxes input[type=checkbox]").forEach((cb) => cb.addEventListener("change", scheduleSync));
  document.getElementById("search-box").addEventListener("input", scheduleSync);
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
  // Appointment/favorite badges, added 2026-08-29 -- fetch the bulk view
  // now that a real admin token exists, then re-render both grids so the
  // badges appear immediately rather than waiting for the next reload.
  refreshAdminActivity().then(() => {
    renderCardGrid();
    renderFavoritesGrid();
  });
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

    // Who's favorited this listing + scheduled appointments, added
    // 2026-08-29 per Aaron's direct request -- placed after the Copy Photo
    // Link button, favorites BEFORE appointments, both per his explicit
    // ordering ("put favs and then appointments AFTER the copy photo link
    // button"). Both reuse the SAME bulk-fetched
    // ADMIN_APPOINTMENTS_BY_ADDRESS/ADMIN_FAVORITES_BY_ADDRESS maps the
    // card badges already use (see refreshAdminActivity) -- no separate
    // network call needed per detail-page view.
    const favsForThis = ADMIN_FAVORITES_BY_ADDRESS[listing.address] || [];
    if (favsForThis.length > 0) {
      html += `<div class="admin-info-title" style="margin-top:14px">Favorited By (${favsForThis.length})</div>`;
      for (const f of favsForThis) {
        html += `<div class="admin-activity-row">
          <div><strong>${escapeHtml(f.name || "(no name)")}</strong></div>
          <div class="admin-activity-contact">${escapeHtml(f.email || "")}${f.email && f.phone ? " · " : ""}${escapeHtml(f.phone || "")}</div>
        </div>`;
      }
    }
    const apptsForThis = ADMIN_APPOINTMENTS_BY_ADDRESS[listing.address] || [];
    if (apptsForThis.length > 0) {
      html += `<div class="admin-info-title" style="margin-top:14px">Scheduled Appointments (${apptsForThis.length})</div>`;
      for (const a of apptsForThis) {
        html += `<div class="admin-activity-row">
          <div><strong>${escapeHtml(a.name || "(no name)")}</strong> — ${escapeHtml(formatAppointmentDate(a.date))}</div>
          <div class="admin-activity-contact">${escapeHtml(a.email || "")}${a.email && a.phone ? " · " : ""}${escapeHtml(a.phone || "")}</div>
        </div>`;
      }
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
    // Clear the bulk admin view and re-render immediately, added
    // 2026-08-29 -- the badges/detail-page info shouldn't linger visible
    // for even one more render after signing out.
    ADMIN_APPOINTMENTS_BY_ADDRESS = {};
    ADMIN_FAVORITES_BY_ADDRESS = {};
    renderCardGrid();
    renderFavoritesGrid();
  });
  // Google Identity Services' script loads async -- poll briefly rather
  // than assume it's ready by the time this runs.
  const tryInit = () => {
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.initialize({ client_id: ADMIN_OAUTH_CLIENT_ID, callback: handleAdminCredentialResponse });
      google.accounts.id.renderButton(document.getElementById("g_id_signin"), { theme: "outline", size: "medium" });
      updateAdminButtonState();
      // Already signed in from a previous visit (valid token still in
      // localStorage) -- fetch the bulk admin view now, added 2026-08-29,
      // so badges show up without needing to sign out/in again to trigger it.
      if (getStoredAdminToken()) {
        refreshAdminActivity().then(() => {
          renderCardGrid();
          renderFavoritesGrid();
        });
      }
    } else {
      setTimeout(tryInit, 200);
    }
  };
  tryInit();
}

// ---------- Install banner (rebuilt 2026-08-29) ----------
// Before this, "Add to Home Screen" relied entirely on the browser's own
// native, easy-to-miss affordance (a small address-bar icon or a buried
// 3-dot-menu item on Android; nothing at all visible on iOS unless a
// visitor already knew to check Share), then briefly a small icon tucked
// into the profile bar. Replaced with a real top-of-page banner per
// Aaron's direct request ("a new user should have a banner... urge them
// to install the site as an app").
const INSTALL_BANNER_DISMISSED_KEY = "iah_install_banner_dismissed";
// Cooldown, not a permanent hide -- added 2026-08-29, real question from
// Aaron ("if someone clicks the X and doesn't install can the banner come
// back later?"). A one-time dismissal shouldn't mean never being offered
// this again; it just means "not right now." Stores a timestamp (not a
// bare flag) so it can re-show once enough time has passed, same as most
// real install-banner implementations elsewhere on the web.
const INSTALL_BANNER_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// Rebuilt 2026-08-29, real request from Aaron: alongside the dismissible
// banner, a persistent "Download App" item should stay in the header menu
// (top-tabs + drawer) whenever the app isn't installed -- unlike the
// banner, this ignores the dismiss/cooldown state entirely, so someone who
// dismissed the banner still has an obvious, permanent way to install
// later. Both surfaces (banner + the two menu items) now share one
// mechanism for visibility and the actual install trigger, rather than
// duplicating the platform-detection logic per surface.
function initInstallUI() {
  const banner = document.getElementById("install-banner");
  const menuBtns = [
    document.getElementById("toptabs-install-btn"),
    document.getElementById("drawer-install-btn"),
  ].filter(Boolean);
  if (!banner && menuBtns.length === 0) return;

  // Already running installed (opened from the home-screen icon) -- never
  // show ANY of this, nothing to install, for the rest of this page's life.
  const alreadyInstalled =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true; // iOS's own older standalone flag
  if (alreadyInstalled) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let deferredPrompt = null;

  function bannerAllowedByCooldown() {
    const dismissedAt = parseInt(localStorage.getItem(INSTALL_BANNER_DISMISSED_KEY) || "0", 10);
    return !dismissedAt || Date.now() - dismissedAt >= INSTALL_BANNER_COOLDOWN_MS;
  }

  // The menu items are NOT gated by the banner's dismiss/cooldown at all --
  // that's the whole point of having them be the persistent fallback.
  function showInstallUI() {
    menuBtns.forEach((btn) => btn.classList.remove("hidden"));
    if (banner && bannerAllowedByCooldown()) banner.classList.remove("hidden");
  }
  function hideInstallUI() {
    menuBtns.forEach((btn) => btn.classList.add("hidden"));
    if (banner) banner.classList.add("hidden");
  }

  async function triggerInstall() {
    if (isIOS) {
      // iOS can never trigger a native install prompt programmatically --
      // Apple restriction, not a gap in this code. Show instructions
      // instead of doing nothing when any of the three buttons is tapped.
      document.getElementById("install-ios-popover").classList.remove("hidden");
      return;
    }
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (choice.outcome === "accepted") hideInstallUI(); // else leave everything showing -- they can still install later
  }

  if (banner) {
    document.getElementById("install-banner-dismiss").addEventListener("click", () => {
      localStorage.setItem(INSTALL_BANNER_DISMISSED_KEY, String(Date.now()));
      banner.classList.add("hidden"); // menu items deliberately stay visible regardless
    });
    document.getElementById("install-banner-btn").addEventListener("click", triggerInstall);
  }
  menuBtns.forEach((btn) => btn.addEventListener("click", triggerInstall));

  if (isIOS) {
    // No install-eligibility signal exists on iOS at all -- just show
    // everything now, and wire the popover's own dismiss once.
    showInstallUI();
    document.getElementById("install-ios-dismiss").addEventListener("click", () => {
      document.getElementById("install-ios-popover").classList.add("hidden");
    });
    return;
  }

  // Android/Chrome (and other Chromium browsers that support this) -- the
  // real native prompt. Only shown once the browser actually confirms the
  // site is installable by firing this event; there's no way to check in
  // advance, and on a visitor's very first action on the site this may not
  // have fired yet at all (Chrome's own engagement heuristics decide when).
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallUI();
  });
  window.addEventListener("appinstalled", hideInstallUI);
}

initNav();
initDrawer();
initStepTabs();
initAdminUI();
initLoginGate();
initInstallUI();
initAppointmentsAccordionToggle();
initPullToRefresh();
// initGetStartedForm() and initVisitorSync() both chained after loadData()
// resolves, not called alongside it -- both need ALL_LISTINGS (property
// dropdown / #area-checkboxes respectively) which only exist once
// loadData() has actually populated them.
loadData().then(() => {
  initGetStartedForm();
  initVisitorSync();
});

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

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
let ADMIN_ALL_APPOINTMENTS_BY_ADDRESS = {}; // added 2026-09-12, upcoming AND past, for the Appointments tab's own Past section
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
  // "Families housed" added 2026-08-29, per Aaron's direct request -- a
  // genuine count of Sold-status listings already present in the real
  // data (properties.json includes Sold rows precisely so the status
  // filter can show them; this just reads the same data for a trust
  // signal instead of a new fetch/endpoint). Placed right next to Areas,
  // per Aaron's own wording ("along with the 14 areas card").
  const sold = ALL_LISTINGS.filter((l) => l.status === "Sold");
  // Areas moved before Homes available 2026-08-29, per Aaron's direct
  // request -- pure reorder, values/logic unchanged. Label reworded
  // "Areas" -> "States" the same day, per Aaron's direct correction --
  // display text only, the underlying `area` field/variable name is left
  // as-is (matches the real Sheet column name), still just a distinct-
  // value count.
  el.innerHTML = `
    <div class="stat-pill"><strong>${areas.size || "—"}</strong>States</div>
    <div class="stat-pill"><strong>${available.length}</strong>Homes available</div>
    <div class="stat-pill"><strong>${sold.length}</strong>Families housed</div>
    <div class="stat-pill"><strong>No</strong>Bank or credit check</div>
  `;
  adjustStatsStripPeek();
}

// Guarantees a partial ("peek") pill is always visible when the strip
// doesn't fully fit, added 2026-08-29 per Aaron's direct request ("Always
// leave half a pill visible if scrolling is necessary, so it's obvious
// there's more to see"). Pure CSS/overflow alone can't promise this --
// whether the natural cutoff lands mid-pill, right at a clean pill
// boundary (no visible hint at all), or with only a near-invisible sliver
// showing depends entirely on how pill widths happen to divide the
// available width for a given screen/font -- confirmed live on a real
// iPhone SE width, where the natural cutoff left only an 8px sliver of
// the last pill, not a meaningful "half" anyone would actually notice.
//
// Real bug fixed while building this, not just a starting design: the
// first version picked whichever pill naturally straddled the viewport
// edge as the "reveal half of this one" target -- but if that pill's own
// midpoint falls PAST the container's natural width (as it did in the
// 8px-sliver case above), there is no way to reveal 50% of it without the
// container somehow being wider than it actually is; padding-right can
// only ever SHRINK what's visible, never grow it. The fix: find the LAST
// pill that fits ENTIRELY within the natural width, and deliberately
// reveal only half of THAT one instead -- its own right edge is by
// definition already within the natural width, so showing exactly half
// of it is always achievable by shrinking, never requires growing.
//
// getBoundingClientRect() is used for position, not offsetLeft/
// offsetWidth -- offsetLeft is relative to the nearest POSITIONED
// ancestor (often far up the tree, e.g. <body>, picking up unrelated
// ancestor padding along the way), not necessarily .stats-strip itself,
// confirmed live to produce nonsensical values here since nothing between
// this element and <body> is actually position:relative/absolute.
function adjustStatsStripPeek() {
  const strip = document.getElementById("stats-strip");
  if (!strip) return;
  strip.style.paddingRight = "0px"; // reset before measuring the TRUE natural layout
  const pills = Array.from(strip.children);
  if (pills.length === 0) return;
  const available = strip.clientWidth;
  if (strip.scrollWidth <= available + 1) return; // everything already fits -- nothing to peek at

  const stripLeft = strip.getBoundingClientRect().left;
  const positions = pills.map((pill) => {
    const rect = pill.getBoundingClientRect();
    return { left: rect.left - stripLeft, width: rect.width };
  });

  // Last pill that fits entirely within the natural (unpadded) width --
  // fall back to the very first pill if even that one alone overflows
  // (an extreme, unlikely case for 4 short pills on any real device).
  let target = positions[0];
  for (const pos of positions) {
    if (pos.left + pos.width <= available) target = pos;
    else break;
  }

  const revealWidth = target.left + target.width / 2;
  const extraPadding = Math.max(0, available - revealWidth);
  strip.style.paddingRight = `${extraPadding}px`;
}
window.addEventListener("resize", adjustStatsStripPeek);

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

// "Houses they've viewed," added 2026-09-11 per Aaron's direct request --
// same shape as favorites (local device list of IDs, synced to the Sheet
// as addresses), but tracks every property detail opened, not just
// hearted ones. See showDetail()'s own call site for where this gets
// recorded.
const VIEWED_STORAGE_KEY = "iah_viewed";
function getViewed() {
  try {
    return JSON.parse(localStorage.getItem(VIEWED_STORAGE_KEY) || "[]");
  } catch (e) {
    return [];
  }
}
function recordViewed(id) {
  const viewed = getViewed();
  if (viewed.includes(id)) return; // already recorded -- opening it again isn't a new signal
  viewed.push(id);
  localStorage.setItem(VIEWED_STORAGE_KEY, JSON.stringify(viewed));
  // Immediate, not debounced -- same reasoning as toggleFavorite: opening a
  // listing is one deliberate action, not rapid-fire typing. Silently a
  // no-op if this browser never passed the gate.
  if (typeof syncVisitorNow === "function") syncVisitorNow();
}
function getViewedAddresses() {
  return getViewed()
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
  recordViewed(id); // "houses they've viewed," added 2026-09-11 -- see recordViewed()'s own comment

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
  // "Schedule a Viewing" (originally "Schedule to Inspect," reworded the
  // same day per Aaron's direct request) added 2026-08-29, Available-only
  // (same rule as Inquire/Photo-not-working) -- jumps to Get Started with
  // this property pre-selected. onclick calls goToGetStartedFor(id) rather
  // than a plain <a href="#tab-get-started">, since the property still
  // needs to be pre-selected in that form, not just the tab switched.
  // Changed from btn-outline to btn-primary (blue) the same day, per
  // Aaron's direct request to match Inquire's own color. btn-full DROPPED
  // the same day too -- moved into the same .action-row as Get Directions
  // (see below), so it needs to flex to share the row rather than force
  // its own full-width block, same as Inquire/Share above it.
  const scheduleBtn = availableOnly
    ? `<button type="button" class="btn-primary" onclick="goToGetStartedFor('${listing.id}')">${ICON_CALENDAR}Schedule a Viewing</button>` : "";
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
      <!-- Get Directions + Schedule a Viewing share a row, added
           2026-08-29 per Aaron's direct request -- same .action-row flex
           pattern as Inquire/Share above (both dropped btn-full so they
           flex to share the space instead of each forcing its own
           full-width block). scheduleBtn can be an empty string for a
           Sold/Pending listing, in which case Get Directions alone just
           naturally fills the row via its own flex: 1. -->
      <div class="action-row">
        <a class="btn-outline" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(listing.address)}" target="_blank" rel="noopener">${ICON_DIRECTIONS}Get Directions</a>
        ${scheduleBtn}
      </div>
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
// Pulled the actual step-switching logic out into its own function,
// 2026-08-29, so both a tab click and a swipe gesture (added the same day,
// see initStepSwipe below) drive the exact same code path rather than
// duplicating the show/hide logic in two places.
function activateStep(stepNumber) {
  const target = document.querySelector(`.step-content[data-step="${stepNumber}"]`);
  if (!target) return; // out of range -- swipe past the first/last step, nothing to do
  document.querySelectorAll(".step-tab").forEach((b) => b.classList.toggle("active", b.dataset.step === String(stepNumber)));
  document.querySelectorAll(".step-content").forEach((c) => c.classList.add("hidden"));
  target.classList.remove("hidden");
}

function getCurrentStep() {
  const activeTab = document.querySelector(".step-tab.active");
  return activeTab ? parseInt(activeTab.dataset.step, 10) : 1;
}

function initStepTabs() {
  document.querySelectorAll(".step-tab").forEach((btn) => {
    btn.addEventListener("click", () => activateStep(parseInt(btn.dataset.step, 10)));
  });
}

// Swipe left/right to move between steps, added 2026-08-29 per Aaron's
// direct request. Scoped to #tab-steps as a whole (not just .step-content)
// so a swipe anywhere on the page -- not just precisely over the text --
// works, matching how a real swipeable card UI usually behaves. Requires
// the gesture to be predominantly horizontal (deltaX clearly bigger than
// deltaY) before claiming it, so an ordinary vertical scroll on a long
// step's text is never mistaken for a swipe. Clamps at the first/last
// step rather than wrapping around -- activateStep() itself already
// no-ops safely on an out-of-range number, so the clamp here is just to
// avoid a pointless activateStep(0) or activateStep(6) call.
const SWIPE_THRESHOLD = 50; // px of horizontal movement needed to count as a real swipe
function initStepSwipe() {
  const section = document.getElementById("tab-steps");
  if (!section) return;
  const stepCount = document.querySelectorAll(".step-tab").length;
  let startX = null;
  let startY = null;

  section.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  // Light visual feedback once the drag clearly reads as horizontal -- the
  // current step dips in opacity (see .step-content.swiping in style.css)
  // so a real drag doesn't feel like it did nothing until release.
  section.addEventListener("touchmove", (e) => {
    if (startX === null || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    const activeContent = document.querySelector(".step-content:not(.hidden)");
    if (activeContent) activeContent.classList.toggle("swiping", Math.abs(dx) > 15 && Math.abs(dx) > Math.abs(dy));
  }, { passive: true });

  section.addEventListener("touchend", (e) => {
    const activeContent = document.querySelector(".step-content:not(.hidden)");
    if (activeContent) activeContent.classList.remove("swiping");
    if (startX === null || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    startX = null;
    startY = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return; // not a real horizontal swipe
    const current = getCurrentStep();
    const next = dx < 0 ? current + 1 : current - 1; // swipe left = next step, swipe right = previous
    if (next < 1 || next > stepCount) return;
    activateStep(next);
  }, { passive: true });
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

// Shared fetch, added 2026-09-02 -- makes "My Info" genuinely the source of
// truth Showings pre-fills from, rather than each tab keeping its own
// separate localStorage-only copy (Aaron's explicit ask). Also keeps the
// localStorage GATE_NAME/PHONE keys refreshed as a same-device fallback
// cache for the instant-paint case, not as the primary source anymore.
// Returns null on any failure (network hiccup, 404) -- callers decide how
// to handle that; a plain network error just means "try again later," a
// 404 specifically means "this device's stored identity is stale" (e.g.
// the email changed and was confirmed on a different channel) and gets
// handled by handleStaleIdentity below.
async function fetchMyInfo(email) {
  if (!email) return null;
  try {
    // POST-with-body 2026-09-06, was GET ?email= -- moved off the URL so
    // Cloudflare's own access logs stop recording every visitor's email.
    const res = await fetch(`${ADMIN_API_URL}/my-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (res.status === 404) return { staleIdentity: true };
    if (!res.ok) return null;
    const data = await res.json();
    if (data.name) localStorage.setItem(GATE_NAME_STORAGE_KEY, data.name);
    if (data.phone) localStorage.setItem(GATE_PHONE_STORAGE_KEY, data.phone);
    return data;
  } catch (e) {
    return null;
  }
}

// A stored email no longer resolving means this device's identity is
// stale -- almost always because a confirmed email change (see
// POST /request-email-change) happened on a different channel/device than
// the one that originally passed the gate. Rather than try to guess the
// new email or keep silently showing blank/wrong fields, clear the gate
// state and reload -- the visitor just re-passes the gate once (a low-
// friction, self-healing fix), which naturally re-establishes identity
// from scratch and correctly matches their now-updated row as a returning
// visitor.
function handleStaleIdentity() {
  localStorage.removeItem(GATE_STORAGE_KEY);
  localStorage.removeItem(GATE_EMAIL_STORAGE_KEY);
  localStorage.removeItem(GATE_NAME_STORAGE_KEY);
  localStorage.removeItem(GATE_PHONE_STORAGE_KEY);
  location.reload();
}

async function prefillGetStartedContactFields() {
  // Synchronous fallback first (instant, no flash of blank fields) --
  // My Info is the real source of truth now, this is just a same-device
  // cache for the instant-paint case while the fresh fetch resolves.
  document.getElementById("get-started-name").value = localStorage.getItem(GATE_NAME_STORAGE_KEY) || "";
  document.getElementById("get-started-email").value = localStorage.getItem(GATE_EMAIL_STORAGE_KEY) || "";
  document.getElementById("get-started-phone").value = localStorage.getItem(GATE_PHONE_STORAGE_KEY) || "";

  const email = localStorage.getItem(GATE_EMAIL_STORAGE_KEY);
  const data = await fetchMyInfo(email);
  if (data && data.staleIdentity) return handleStaleIdentity();
  if (data) {
    if (data.name) document.getElementById("get-started-name").value = data.name;
    document.getElementById("get-started-email").value = data.email || email || "";
    if (data.phone) document.getElementById("get-started-phone").value = data.phone;
    // Added 2026-09-03 -- lets a returning visitor with an ID already on
    // file (from an earlier booking, or uploaded via My Info) skip
    // re-uploading it just to book another viewing. See updateIdPhotoStatus
    // below, which is the single place that actually applies this to the
    // field's required-ness and status line.
    serverIdOnFile = !!data.idOnFile;
    updateIdPhotoStatus();
  }
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

// Replaces the native <input type="date"> on both date pickers, added
// 2026-08-29 -- real reported bug: several mobile browsers render their own
// full native calendar UI regardless of min=/max=, so a visitor could still
// see (and scroll through) months of dates even though only an 11-day
// window (today + 10) was ever valid. A closed <select> of exactly those 11
// options makes an out-of-range date structurally impossible to pick,
// rather than relying on native min/max enforcement that isn't consistent
// across browsers. Returns {value, label} pairs -- value is the plain ISO
// date the rest of this codebase already expects everywhere (Sheet writes,
// comparisons), label is what the visitor actually reads.
function buildDateOptions() {
  const options = [];
  for (let i = 0; i <= 10; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const formatted = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    options.push({ value, label: i === 0 ? `Today (${formatted})` : formatted });
  }
  return options;
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
    // POST-with-body 2026-09-06, was GET ?email= -- same reasoning as
    // fetchMyInfo above.
    const res = await fetch(MY_APPOINTMENTS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
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
const PULL_REFRESH_RESTORE_TAB_KEY = "pullRefreshRestoreTab";

function getActiveTabName() {
  // All three nav instances (top-tabs/drawer/bottom-nav) stay in sync on
  // every activateTab() call, and "properties" starts .active in the raw
  // markup itself -- so this reads correctly even before activateTab has
  // ever run (e.g. right after a fresh page load).
  const active = document.querySelector(".nav-btn.active[data-tab]");
  return active ? active.dataset.tab : null;
}

// Called once, after the page's own default-tab setup (loadData()) has
// resolved, so a restored non-Homes tab that depends on ALL_LISTINGS (e.g.
// favorites, get-started) has real data to render against instead of an
// empty state. Restoring a tab that doesn't need listings at all (buyers,
// appointments, my-info) works fine at this point too.
function restoreTabAfterPullRefresh() {
  const saved = sessionStorage.getItem(PULL_REFRESH_RESTORE_TAB_KEY);
  if (!saved) return;
  sessionStorage.removeItem(PULL_REFRESH_RESTORE_TAB_KEY);
  if (document.getElementById(`tab-${saved}`)) activateTab(saved);
}

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
      // Real location.reload() resets to whichever tab-panel's markup
      // defaults to visible (Homes) -- stash the tab the visitor was
      // actually on so it can be restored after reload instead of always
      // bouncing back to Homes. sessionStorage (not localStorage): this is
      // a one-shot "restore after this specific reload" signal, not a
      // standing preference -- a fresh visit/tab should still land on
      // Homes normally. Added 2026-09-11 per Aaron's direct request.
      const active = getActiveTabName();
      if (active) sessionStorage.setItem(PULL_REFRESH_RESTORE_TAB_KEY, active);
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

  // Rebuilt as a closed <select> 2026-08-29 -- same fix, same reason as the
  // main booking date field (see buildDateOptions()'s own comment): some
  // mobile browsers show a full native calendar for <input type="date">
  // regardless of min=/max=. appt.date is guaranteed to be one of these 11
  // options -- it can only ever be today or later (past appointments are
  // filtered out before this banner is ever built, see refreshMyAppointments)
  // and can only ever be closer than the original 10-day cap it was booked
  // under, never farther.
  const datePicker = document.createElement("select");
  datePicker.className = "appt-date-picker hidden";
  for (const { value, label } of buildDateOptions()) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (value === appt.date) opt.selected = true;
    datePicker.appendChild(opt);
  }

  changeBtn.addEventListener("click", () => {
    const showing = !datePicker.classList.contains("hidden");
    datePicker.classList.toggle("hidden", showing);
    if (!showing) datePicker.focus();
  });

  datePicker.addEventListener("change", async () => {
    const newDate = datePicker.value;
    if (!newDate || newDate === appt.date) return; // no real change, or somehow blank -- nothing to write
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
    ADMIN_ALL_APPOINTMENTS_BY_ADDRESS = {};
    ADMIN_FAVORITES_BY_ADDRESS = {};
    return;
  }
  try {
    const res = await fetch(ADMIN_ACTIVITY_ENDPOINT, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const today = localTodayISO();

    const groupedAppts = {};
    const groupedAllAppts = {};
    for (const appt of data.appointments || []) {
      // ADMIN_ALL_APPOINTMENTS_BY_ADDRESS, added 2026-09-12 -- the
      // Appointments tab's own Past section (below) needs genuinely
      // past-dated appointments too, which this loop otherwise discards
      // for the property-card badge's sake (that one's correctly
      // upcoming-only, unchanged).
      (groupedAllAppts[appt.address] = groupedAllAppts[appt.address] || []).push(appt);
      if (appt.date < today) continue; // only count/show upcoming, matching the visitor-facing definition
      (groupedAppts[appt.address] = groupedAppts[appt.address] || []).push(appt);
    }
    for (const list of Object.values(groupedAppts)) list.sort((a, b) => a.date.localeCompare(b.date));
    for (const list of Object.values(groupedAllAppts)) list.sort((a, b) => a.date.localeCompare(b.date));
    ADMIN_APPOINTMENTS_BY_ADDRESS = groupedAppts;
    ADMIN_ALL_APPOINTMENTS_BY_ADDRESS = groupedAllAppts;

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
    ADMIN_ALL_APPOINTMENTS_BY_ADDRESS = {};
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

// Added 2026-09-03 -- whether /my-info reported an ID already on file
// server-side (set in prefillGetStartedContactFields). Distinct from
// lastUploadedIdPhoto: that one tracks a fresh pick made THIS session,
// this one reflects a real, already-confirmed upload from any prior
// session/device (an earlier booking, or a direct My Info upload).
let serverIdOnFile = false;

// Extended 2026-09-03 to also reflect a server-confirmed ID (not just a
// same-session pick) and to toggle whether a fresh photo is actually
// required -- a returning visitor who already has one on file shouldn't
// be forced to re-upload just to book another viewing. A fresh pick
// always takes visual priority over the server-known one (it's more
// current), but either one alone is enough to satisfy the requirement.
function updateIdPhotoStatus() {
  const el = document.getElementById("get-started-id-status");
  const input = document.getElementById("get-started-id-photo");
  if (!el || !input) return;
  if (lastUploadedIdPhoto) {
    el.textContent = `✓ ID on file: ${lastUploadedIdPhoto.name}`;
    el.classList.remove("hidden");
  } else if (serverIdOnFile) {
    el.textContent = "✓ ID already on file from a previous visit";
    el.classList.remove("hidden");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
  }
  input.required = !lastUploadedIdPhoto && !serverIdOnFile;
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

  // Rebuilt 2026-08-29 as a closed <select> -- see buildDateOptions()'s own
  // comment for why (several mobile browsers ignore <input type="date">'s
  // min=/max= and show a full native calendar regardless). No min/max/
  // re-validation logic needed anymore: the dropdown's own option list IS
  // the valid range, an out-of-range value simply doesn't exist to pick.
  // Populated once here, at init, same as this whole function only runs
  // once -- not repopulated per tab-visit like the property dropdown below,
  // since doing so would also reset any date the visitor already picked.
  // A theoretical edge case this doesn't cover: a page left open across a
  // real midnight would keep showing a now-stale "Today" as an option --
  // low-stakes (worst case, the visitor picks a date that's already
  // trivially just today or a day off) and not worth the UX cost of
  // silently clearing a real in-progress selection to close it.
  const dateSelect = document.getElementById("get-started-date");
  for (const { value, label } of buildDateOptions()) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    dateSelect.appendChild(opt);
  }

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
  "get-started": "MY SHOWINGS", favorites: "MY FAVORITES", "my-info": "MY INFO",
  buyers: "BUYERS", appointments: "APPOINTMENTS",
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
  // -- and so a property picked via "Schedule a Viewing" (which calls
  // activateTab("get-started") itself) gets the dropdown pre-selected.
  if (tabName === "favorites") renderFavoritesGrid();
  // Also re-run the contact-field prefill here, not just from the gate's
  // own submit handler -- a cheap, idempotent defensive re-sync so this
  // tab always reflects the freshest gate values no matter how it was
  // reached, rather than depending on exactly one call site staying correct.
  if (tabName === "get-started") { populateGetStartedPropertyDropdown(); prefillGetStartedContactFields(); renderMyAppointmentCards(); }
  if (tabName === "my-info") refreshMyInfoTab();
  if (tabName === "buyers") loadBuyers();
  // Also loads buyers now (2026-09-12), not just the activity/appointments
  // fetch -- the new Past-Appointments split needs each buyer's own
  // "shown" list (BUYERS_CACHE) to tell whether a still-upcoming-dated
  // appointment has already been manually marked done.
  if (tabName === "appointments") {
    Promise.all([refreshAdminActivity(), loadBuyers()]).then(renderAppointmentsOverview);
  }
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

// ---------- My Info tab (added 2026-09-02) ----------
// Deliberately fetches fresh from the server every time this tab is
// visited (see activateTab's own call site above), never trusting a
// cached copy -- same "always re-check, never assume localStorage is
// still current" discipline already applied elsewhere in this file (the
// appointment banner, the filter-sync). Wiring (initMyInfoUI) happens once
// at load; refreshMyInfoTab() is what actually re-fetches/re-renders on
// every visit.
function initMyInfoUI() {
  document.getElementById("my-info-save-name-btn").addEventListener("click", async () => {
    const email = localStorage.getItem(GATE_EMAIL_STORAGE_KEY);
    const name = document.getElementById("my-info-name").value.trim();
    const status = document.getElementById("my-info-name-status");
    if (!email || !name) return;
    status.textContent = "Saving...";
    try {
      const res = await fetch(`${ADMIN_API_URL}/update-name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name }),
      });
      status.textContent = res.ok ? "Saved!" : "Something went wrong -- please try again.";
    } catch (e) {
      status.textContent = "Something went wrong -- please try again.";
    }
  });

  document.getElementById("my-info-change-phone-btn").addEventListener("click", () => {
    document.getElementById("my-info-change-phone-form").classList.remove("hidden");
  });

  // Reuses the exact same POST /request-phone-change built for the
  // phone-backfill/verified-change flow -- no new backend logic needed
  // here, this is just a second real UI entry point into that same,
  // already-verified-live endpoint.
  document.getElementById("my-info-send-code-btn").addEventListener("click", async () => {
    const email = localStorage.getItem(GATE_EMAIL_STORAGE_KEY);
    const newPhone = document.getElementById("my-info-new-phone").value.trim();
    const status = document.getElementById("my-info-phone-status");
    if (!email || !newPhone) return;
    status.textContent = "Sending...";
    try {
      const res = await fetch(`${ADMIN_API_URL}/request-phone-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, newPhone }),
      });
      const data = await res.json();
      status.textContent = res.ok ? data.message : (data.message || "Something went wrong -- please try again.");
    } catch (e) {
      status.textContent = "Something went wrong -- please try again.";
    }
  });

  // Email-change confirmation, added 2026-09-02 -- same reveal-a-form
  // pattern as Change Phone Number above, but posts to
  // POST /request-email-change (confirmed via a text to the visitor's
  // EXISTING phone, not email -- see that endpoint's own comment).
  document.getElementById("my-info-change-email-btn").addEventListener("click", () => {
    document.getElementById("my-info-change-email-form").classList.remove("hidden");
  });

  document.getElementById("my-info-send-email-code-btn").addEventListener("click", async () => {
    const email = localStorage.getItem(GATE_EMAIL_STORAGE_KEY);
    const newEmail = document.getElementById("my-info-new-email").value.trim();
    const status = document.getElementById("my-info-email-status");
    if (!email || !newEmail) return;
    status.textContent = "Sending...";
    try {
      const res = await fetch(`${ADMIN_API_URL}/request-email-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, newEmail }),
      });
      const data = await res.json();
      status.textContent = res.ok ? data.message : (data.message || "Something went wrong -- please try again.");
    } catch (e) {
      status.textContent = "Something went wrong -- please try again.";
    }
  });

  // Primary buyer's own ID, added 2026-09-03 -- closes the last real gap
  // from Aaron's original "My Info" scope ask. Same immediate-upload-on-
  // select pattern as the co-buyer ID fields below.
  document.getElementById("my-info-id-photo").addEventListener("change", async (evt) => {
    const email = localStorage.getItem(GATE_EMAIL_STORAGE_KEY);
    const file = evt.target.files && evt.target.files[0];
    const status = document.getElementById("my-info-id-upload-status");
    if (!email || !file) return;
    status.textContent = "Uploading...";
    try {
      const form = new FormData();
      form.append("email", email);
      form.append("idPhoto", file);
      const res = await fetch(`${ADMIN_API_URL}/upload-my-id`, { method: "POST", body: form });
      const data = await res.json();
      if (res.ok) {
        status.textContent = "Saved!";
        refreshMyInfoTab(); // re-pull so the new thumbnail actually shows
      } else {
        status.textContent = data.message || "Something went wrong -- please try again.";
      }
    } catch (e) {
      status.textContent = "Something went wrong -- please try again.";
    }
  });

  // Additional Buyers (co-buyers), added 2026-09-02 -- same wiring pattern
  // for both slots, driven by a small helper rather than duplicating the
  // listener code twice, since the two blocks are otherwise identical.
  [1, 2].forEach((slot) => {
    document.getElementById(`my-info-cobuyer${slot}-save-btn`).addEventListener("click", async () => {
      const email = localStorage.getItem(GATE_EMAIL_STORAGE_KEY);
      const name = document.getElementById(`my-info-cobuyer${slot}-name`).value.trim();
      const coBuyerEmail = document.getElementById(`my-info-cobuyer${slot}-email`).value.trim();
      const coBuyerPhone = document.getElementById(`my-info-cobuyer${slot}-phone`).value.trim();
      const status = document.getElementById(`my-info-cobuyer${slot}-status`);
      if (!email || !name) return;
      status.textContent = "Saving...";
      try {
        const res = await fetch(`${ADMIN_API_URL}/update-co-buyer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, slot, name, coBuyerEmail, coBuyerPhone }),
        });
        status.textContent = res.ok ? "Saved!" : "Something went wrong -- please try again.";
      } catch (e) {
        status.textContent = "Something went wrong -- please try again.";
      }
    });

    // ID upload fires immediately on file selection -- unlike the primary
    // buyer's ID (bundled into the larger Showings form submit), a
    // co-buyer's ID here has no surrounding form to submit alongside, so
    // there's nothing to wait for.
    document.getElementById(`my-info-cobuyer${slot}-id-photo`).addEventListener("change", async (evt) => {
      const email = localStorage.getItem(GATE_EMAIL_STORAGE_KEY);
      const file = evt.target.files && evt.target.files[0];
      const status = document.getElementById(`my-info-cobuyer${slot}-id-status`);
      if (!email || !file) return;
      status.textContent = "Uploading...";
      try {
        const form = new FormData();
        form.append("email", email);
        form.append("slot", String(slot));
        form.append("idPhoto", file);
        const res = await fetch(`${ADMIN_API_URL}/upload-co-buyer-id`, { method: "POST", body: form });
        const data = await res.json();
        if (res.ok) {
          status.textContent = "Saved!";
          refreshMyInfoTab(); // re-pull so the new thumbnail actually shows
        } else {
          status.textContent = data.message || "Something went wrong -- please try again.";
        }
      } catch (e) {
        status.textContent = "Something went wrong -- please try again.";
      }
    });
  });
}

// Added 2026-09-06, replacing a plain <img src="${ADMIN_API_URL}/id-photo?email=...">
// assignment. Browsers can only ever GET an <img src> -- there's no way to
// POST from one -- but /id-photo moved to POST-with-body the same day (gate-check
// flagged the email/coBuyerSlot living in the URL, same as my-info/my-appointments
// above). So this fetches the photo itself via POST, then hands the image
// bytes to the <img> as a local blob: URL instead of pointing it at the
// endpoint directly. Revokes the previous blob: URL first (if any) so
// repeated tab refreshes don't leak memory.
async function loadIdPhotoThumbnail(imgEl, email, coBuyerSlot) {
  const prevUrl = imgEl.dataset.blobUrl;
  if (prevUrl) URL.revokeObjectURL(prevUrl);
  imgEl.removeAttribute("src");
  delete imgEl.dataset.blobUrl;
  try {
    const res = await fetch(`${ADMIN_API_URL}/id-photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(coBuyerSlot ? { email, coBuyerSlot } : { email }),
    });
    if (!res.ok) return; // no ID on file / server hiccup -- leave the <img> blank rather than break the tab
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    imgEl.dataset.blobUrl = objectUrl;
    imgEl.src = objectUrl;
  } catch (e) {
    // Network hiccup -- same "leave it blank" fallback as the res.ok check above.
  }
}

async function refreshMyInfoTab() {
  const email = localStorage.getItem(GATE_EMAIL_STORAGE_KEY);
  const notGated = document.getElementById("my-info-not-gated");
  const content = document.getElementById("my-info-content");
  if (!email) {
    notGated.classList.remove("hidden");
    content.classList.add("hidden");
    return;
  }
  notGated.classList.add("hidden");
  content.classList.remove("hidden");

  const data = await fetchMyInfo(email);
  if (data && data.staleIdentity) return handleStaleIdentity();
  if (!data) return; // network hiccup -- leave fields as they were rather than blank them out

  document.getElementById("my-info-name").value = data.name || "";
  document.getElementById("my-info-email").value = data.email || "";
  document.getElementById("my-info-phone").value = data.phone || "";
  // Reset the change-phone/change-email forms + statuses on every fresh
  // visit, so a stale "Sending..." or a previous session's revealed form
  // doesn't linger across tab switches.
  document.getElementById("my-info-change-phone-form").classList.add("hidden");
  document.getElementById("my-info-new-phone").value = "";
  document.getElementById("my-info-change-email-form").classList.add("hidden");
  document.getElementById("my-info-new-email").value = "";
  document.getElementById("my-info-name-status").textContent = "";
  document.getElementById("my-info-phone-status").textContent = "";
  document.getElementById("my-info-email-status").textContent = "";
  document.getElementById("my-info-id-upload-status").textContent = "";
  document.getElementById("my-info-id-photo").value = "";

  const hasId = document.getElementById("my-info-id-has-file");
  const missingId = document.getElementById("my-info-id-missing");
  if (data.idOnFile) {
    hasId.classList.remove("hidden");
    missingId.classList.add("hidden");
    loadIdPhotoThumbnail(document.getElementById("my-info-id-thumbnail"), email, null);
  } else {
    hasId.classList.add("hidden");
    missingId.classList.remove("hidden");
  }

  // Additional Buyers -- data.coBuyers is [slot1, slot2], each either null
  // (nothing saved yet) or {name, email, phone, idOnFile}.
  const coBuyers = data.coBuyers || [null, null];
  [1, 2].forEach((slot) => {
    const co = coBuyers[slot - 1];
    document.getElementById(`my-info-cobuyer${slot}-name`).value = (co && co.name) || "";
    document.getElementById(`my-info-cobuyer${slot}-email`).value = (co && co.email) || "";
    document.getElementById(`my-info-cobuyer${slot}-phone`).value = (co && co.phone) || "";
    document.getElementById(`my-info-cobuyer${slot}-status`).textContent = "";
    document.getElementById(`my-info-cobuyer${slot}-id-status`).textContent = "";
    document.getElementById(`my-info-cobuyer${slot}-id-photo`).value = "";

    const coHasId = document.getElementById(`my-info-cobuyer${slot}-id-has-file`);
    if (co && co.idOnFile) {
      coHasId.classList.remove("hidden");
      loadIdPhotoThumbnail(document.getElementById(`my-info-cobuyer${slot}-id-thumbnail`), email, String(slot));
    } else {
      coHasId.classList.add("hidden");
    }
  });
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

// Sort applies live on selection, no Apply button -- added 2026-08-29 per
// Aaron's direct request, matching the exact same live-apply pattern the
// filter controls below already use (see applyFiltersFromControls' own
// comment). Deliberately does NOT close sort-panel on change, same reason
// as filters: closing it would hide the dropdown the moment you pick an
// option, which reads as the control vanishing rather than confirming
// the choice.
document.getElementById("f-sort").addEventListener("change", () => {
  filterState.sort = document.getElementById("f-sort").value;
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
    // Added 2026-09-11, same "full list every time" convention.
    viewed: getViewedAddresses(),
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
  // Buyers/Appointments tabs, added 2026-09-11 -- admin-only, same signedIn check.
  // "-bottom" ids added 2026-09-13 (footer copies, see index.html).
  for (const id of ["nav-buyers-top", "nav-buyers-drawer", "nav-buyers-bottom", "nav-appointments-top", "nav-appointments-drawer", "nav-appointments-bottom"]) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", !signedIn);
  }
  // Footer-only decluttering, added 2026-09-13 per Aaron's direct request:
  // while signed in as admin, the FOOTER specifically should show just
  // Homes/Buyers/Appointments -- the buyer-facing tabs stay reachable via
  // .top-tabs/.nav-drawer (unaffected by this), just hidden from the
  // footer's own row so it isn't cluttered with tabs Aaron doesn't use
  // while working the admin view. Reverts the moment signedIn goes false
  // (sign-out), same single toggle either way.
  document.querySelectorAll(".bottom-nav-buyer-tab").forEach((el) => {
    el.classList.toggle("hidden", signedIn);
  });
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
    ADMIN_ALL_APPOINTMENTS_BY_ADDRESS = {};
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
initStepSwipe();
initAdminUI();
initLoginGate();
initInstallUI();
initAppointmentsAccordionToggle();
initPullToRefresh();
initMyInfoUI();
initBuyersTab();
// initGetStartedForm() and initVisitorSync() both chained after loadData()
// resolves, not called alongside it -- both need ALL_LISTINGS (property
// dropdown / #area-checkboxes respectively) which only exist once
// loadData() has actually populated them.
loadData().then(() => {
  initGetStartedForm();
  initVisitorSync();
  restoreTabAfterPullRefresh();
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

// ---------- Admin: Buyers tab (added 2026-09-11) ----------
// Aaron's own request: one page listing every potential term buyer (every
// real conversation on the Filling number, not just the ~half already
// tagged in Quo), sortable, click-through to a full CRM-style detail view
// (ID photo, co-buyers, favorited properties, appointments, search
// filters). Talks to the standalone iah-buyers Worker -- deliberately
// separate from ADMIN_API_URL/super-frost-1dbb, so nothing here can affect
// the live listings site or its existing admin features.
//
// This file is meant to be pasted into docs/js/app.js (its functions use
// the same globals -- getStoredAdminToken(), ADMIN_OAUTH_CLIENT_ID -- already
// defined there) and this tab's markup into docs/index.html, both spots
// marked in the README. Kept as its own file for review before merging.

const BUYERS_API_URL = "https://iah-buyers.notactuallyit.workers.dev";

let BUYERS_CACHE = null; // the last /buyers response, re-sorted client-side on dropdown change
// Default sort, changed 2026-09-11 per Aaron's direct request ("Buyers
// should be default sorted by most recent contact/login, etc.") -- was
// "area".
let BUYERS_SORT = "last-contact";
// 1 = today's real default order for whichever sort is selected, -1 =
// reversed. Reset to 1 whenever the sort TYPE changes (see initBuyersTab)
// so switching sorts always starts from its own sensible default, not
// whatever direction was left over from a different sort.
let BUYERS_SORT_DIR = 1;
// Labels are generic ("Reverse order"), not literally "A-Z"/"Z-A" --
// applies to date-based sorts too, where that framing wouldn't make
// sense. Shows the direction that CLICKING would produce, matching how
// the homes page's own sort/filter toggles read (an action, not a
// current-state readout).
function updateSortDirToggleLabel(btn) {
  btn.textContent = BUYERS_SORT_DIR === 1 ? "↓ Reverse order" : "↑ Default order";
}

// Same 5 areas admin-buyers-worker.js's own CANONICAL_AREAS canonicalizes
// onto -- kept as a plain list here (not derived live like the homes-page
// area checkboxes, which come from real property data) since this is a
// fixed taxonomy Aaron defined, not something to infer from the buyer
// population itself.
const BUYERS_CANONICAL_AREAS = ["IL - East St Louis", "MO - St. Louis", "AR - Little Rock", "AR - West Memphis", "IL - Springfield"];
// Populated fresh each renderBuyerDetail() call -- see its own comment at
// the Shown Properties section for why this replaced a native <datalist>.
let SHOWN_AVAILABLE_ADDRESSES = [];
let APPOINTMENT_AVAILABLE_ADDRESSES = []; // added 2026-09-12, same pattern, populated fresh each renderBuyerDetail() call

let BUYERS_FILTER = {
  down: null, monthly: null, beds: null, areas: [],
  // Added 2026-09-11 per Aaron's direct request.
  idOnFile: null, // null | "yes" | "no"
  hasFavorites: null, // null | "yes" | "no"
  loggedIn: null, // null | "yes" | "no"
  contactOp: null, // null | "before" | "after"
  contactPeriod: "week", // "week" | "month" | "quarter" | "year" -- only applied when contactOp is set
  stages: [], // added 2026-09-12
  sentiment: null, // added 2026-09-12 -- null | "smile" | "neutral" | "frown" | "none"
};

// Pipeline stages, added 2026-09-12 per Aaron's direct request -- kept as
// a plain ordered list here (not derived from anything server-side) since
// this is a fixed taxonomy he defined, same reasoning as
// BUYERS_CANONICAL_AREAS above. Keep in sync with STAGE_VALUES in
// admin/worker.js if this list ever changes.
const BUYER_STAGES = [
  "First Contact", "ID Verified", "Showing Scheduled", "First Showing Done",
  "Multiple Showings", "Deposit Received", "Buyer", "Multiple Buyer",
];

// One color per stage, same order as BUYER_STAGES -- a warm-to-cool
// gradient (orange -> yellow -> green -> purple), added 2026-09-12 per
// Aaron's direct request. Used for both the progress bar's own fill (each
// segment colored by ITS stage, not one flat color) and the card outline
// color below (a buyer's current-stage color, replacing a flat red).
const STAGE_COLORS = [
  "#f97316", // First Contact -- orange
  "#f59e0b", // ID Verified -- amber
  "#eab308", // Showing Scheduled -- yellow
  "#84cc16", // First Showing Done -- lime
  "#22c55e", // Multiple Showings -- green
  "#14b8a6", // Deposit Received -- teal
  "#3b82f6", // Buyer -- blue
  "#a855f7", // Multiple Buyer -- purple
];
function stageColorFor(stage) {
  const idx = stage ? BUYER_STAGES.indexOf(stage) : -1;
  return idx >= 0 ? STAGE_COLORS[idx] : null;
}

// Sentiment emojis, added 2026-09-12 -- Aaron's own personal-impression
// note per buyer. Stored server-side as one of these three keys (or "" for
// unset); the emoji itself is purely a client-side rendering choice.
const SENTIMENT_EMOJI = { smile: "😊", neutral: "😐", frown: "😟" };

// Shared markup builders, added 2026-09-12 -- used on both the buyer list
// card AND the top of the buyer detail page (Aaron's direct request to be
// able to update these from either place), so both stay in sync rather
// than duplicating slightly-different copies.
function renderSentimentPickerHtml(buyer) {
  const current = buyer.sentiment || "";
  return Object.entries(SENTIMENT_EMOJI).map(([key, emoji]) => `
    <button type="button" class="sentiment-btn${current === key ? " sentiment-btn-selected" : ""}" data-phone="${escapeAttr(buyer.phone)}" data-sentiment="${key}" title="${key}">${emoji}</button>
  `).join("");
}
function renderStageSelectHtml(buyer) {
  const options = `<option value=""${!buyer.stage ? " selected" : ""}>— Stage —</option>` +
    BUYER_STAGES.map((s) => `<option value="${escapeAttr(s)}"${buyer.stage === s ? " selected" : ""}>${escapeHtml(s)}</option>`).join("");
  return `<select class="stage-select" data-phone="${escapeAttr(buyer.phone)}">${options}</select>`;
}
// Segmented progress bar across the 8 pipeline stages -- one filled
// segment per stage up to (and including) the buyer's current one. No
// stage set yet renders all segments empty rather than guessing a start.
function renderStageProgressBarHtml(buyer) {
  const currentIdx = buyer.stage ? BUYER_STAGES.indexOf(buyer.stage) : -1;
  // Each FILLED segment takes on its OWN stage's color (STAGE_COLORS),
  // not one flat fill color -- reads as a real gradient sweeping through
  // orange/yellow/green/purple as it fills, added 2026-09-12 per Aaron's
  // direct request.
  const segments = BUYER_STAGES.map((s, i) => {
    const filled = i <= currentIdx;
    const style = filled ? ` style="background:${STAGE_COLORS[i]}"` : "";
    return `<span class="stage-progress-segment${filled ? " stage-progress-filled" : ""}"${style} title="${escapeAttr(s)}"></span>`;
  }).join("");
  return `
    <div class="stage-progress-bar">${segments}</div>
    <div class="stage-progress-label">${buyer.stage ? escapeHtml(buyer.stage) : "No stage set"}</div>
  `;
}

// Start-of-period boundary for the Last Contact filter, in the visitor's
// own local time (matches how "this week/month/..." reads to a human,
// not a UTC-aligned boundary). Week starts Monday.
function periodStartDate(period) {
  const now = new Date();
  if (period === "week") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = d.getDay(); // 0 = Sunday
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    return d;
  }
  if (period === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  if (period === "quarter") return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  if (period === "year") return new Date(now.getFullYear(), 0, 1);
  return null;
}

function renderBuyersAreaCheckboxes() {
  const container = document.getElementById("buyers-area-checkboxes");
  if (!container) return;
  container.innerHTML = BUYERS_CANONICAL_AREAS.map((area) => `
    <label class="area-checkbox"><input type="checkbox" value="${escapeAttr(area)}">${escapeHtml(area)}</label>
  `).join("");
  container.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.addEventListener("change", applyBuyersFilters));
}

// Same pattern as renderBuyersAreaCheckboxes above, added 2026-09-12.
function renderBuyersStageCheckboxes() {
  const container = document.getElementById("buyers-stage-checkboxes");
  if (!container) return;
  container.innerHTML = BUYER_STAGES.map((stage) => `
    <label class="area-checkbox"><input type="checkbox" value="${escapeAttr(stage)}">${escapeHtml(stage)}</label>
  `).join("");
  container.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.addEventListener("change", applyBuyersFilters));
}

// Filters the BUYER list by whether THEIR OWN saved site-search filters
// (loginsMatch.filters, written when they searched the homes list) match
// what's selected here -- mirrors the homes search UI but filters people,
// not properties. Added 2026-09-11 per Aaron's direct request.
function buyerMatchesFilters(b) {
  const f = BUYERS_FILTER;
  const lmFilters = (b.loginsMatch && b.loginsMatch.filters) || null;
  if (f.down != null && parseFloat((lmFilters && lmFilters.maxDown) || "") !== f.down) return false;
  if (f.monthly != null && parseFloat((lmFilters && lmFilters.maxMonthly) || "") !== f.monthly) return false;
  if (f.beds != null && parseInt((lmFilters && lmFilters.minBeds) || "", 10) !== f.beds) return false;
  if (f.areas.length > 0) {
    // A buyer counts as matching a checked area either by any of their own
    // classified areas (b.areas -- can now be more than one, per Aaron's
    // 2026-09-11 request) OR by what they literally typed into the site's
    // own area search field -- either is a real signal of interest in that area.
    const byTag = b.areas && b.areas.length > 0 && f.areas.some((a) => b.areas.includes(a));
    const bySearch = lmFilters && lmFilters.areas && f.areas.some((a) => lmFilters.areas.toLowerCase().includes(a.toLowerCase()));
    if (!byTag && !bySearch) return false;
  }
  const lm = b.loginsMatch;
  if (f.idOnFile === "yes" && !(lm && lm.idLink)) return false;
  if (f.idOnFile === "no" && lm && lm.idLink) return false;
  if (f.hasFavorites === "yes" && !(lm && lm.favorites && lm.favorites.length)) return false;
  if (f.hasFavorites === "no" && lm && lm.favorites && lm.favorites.length) return false;
  // "Logged in" means a real first-login timestamp on file, not merely
  // having a matching Sheet row (a row can exist from other activity).
  if (f.loggedIn === "yes" && !(lm && lm.firstLogin)) return false;
  if (f.loggedIn === "no" && lm && lm.firstLogin) return false;
  if (f.contactOp) {
    // Last contact = most recent of texted or called (Quo activity) --
    // deliberately NOT login, which has its own separate filter above.
    const candidates = [b.lastActivityAt, b.lastCallAt].filter(Boolean).map((d) => new Date(d));
    const boundary = periodStartDate(f.contactPeriod);
    if (candidates.length === 0) {
      // Never contacted at all -- counts as "before" any period (nothing
      // to be "after"), so this correctly fails an "after" filter and
      // passes a "before" one.
      if (f.contactOp === "after") return false;
    } else {
      const lastContact = new Date(Math.max(...candidates));
      if (f.contactOp === "before" && !(lastContact < boundary)) return false;
      if (f.contactOp === "after" && !(lastContact >= boundary)) return false;
    }
  }
  if (f.stages.length > 0 && !f.stages.includes(b.stage)) return false;
  if (f.sentiment) {
    if (f.sentiment === "none" ? !!b.sentiment : b.sentiment !== f.sentiment) return false;
  }
  return true;
}

// Free-text search, added 2026-09-11 per Aaron's direct request -- matches
// name, phone, email, and area (both the classified tag and whatever the
// buyer typed into their own area search), same "search across the
// obviously-relevant identity fields" scope as any contact search.
let BUYERS_SEARCH = "";
function buyerMatchesSearch(b) {
  if (!BUYERS_SEARCH) return true;
  const lm = b.loginsMatch;
  const li = b.leadInfo;
  const haystack = [
    b.quoName, b.phone, b.areas && b.areas.join(" "),
    lm && lm.email, lm && lm.name, lm && lm.filters && lm.filters.areas,
    // BUYERS-tab lead info, added 2026-09-11 -- some buyers only exist via
    // this source (no Quo/App:Logins match at all), so it has to be
    // searchable too, not just displayed.
    li && li.contactName, li && li.companyName, li && li.email, li && li.city, li && li.state,
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(BUYERS_SEARCH);
}

function activeBuyersFilterCount() {
  const f = BUYERS_FILTER;
  let n = 0;
  if (f.down != null) n++;
  if (f.monthly != null) n++;
  if (f.beds != null) n++;
  if (f.areas.length > 0) n++;
  if (f.idOnFile) n++;
  if (f.hasFavorites) n++;
  if (f.loggedIn) n++;
  if (f.contactOp) n++;
  if (f.stages.length > 0) n++;
  if (f.sentiment) n++;
  return n;
}
function updateBuyersFilterBadge() {
  const badge = document.getElementById("buyers-filter-badge");
  if (!badge) return;
  const n = activeBuyersFilterCount();
  badge.textContent = n;
  badge.classList.toggle("hidden", n === 0);
}

function applyBuyersFilters() {
  BUYERS_FILTER = {
    down: parseFloat(document.getElementById("bf-down").value) || null,
    monthly: parseFloat(document.getElementById("bf-monthly").value) || null,
    beds: parseInt(document.getElementById("bf-beds").value, 10) || null,
    areas: [...document.querySelectorAll("#buyers-area-checkboxes input:checked")].map((cb) => cb.value),
    idOnFile: document.getElementById("bf-id").value || null,
    hasFavorites: document.getElementById("bf-favorites").value || null,
    loggedIn: document.getElementById("bf-loggedin").value || null,
    contactOp: document.getElementById("bf-contact-op").value || null,
    contactPeriod: document.getElementById("bf-contact-period").value || "week",
    stages: [...document.querySelectorAll("#buyers-stage-checkboxes input:checked")].map((cb) => cb.value),
    sentiment: document.getElementById("bf-sentiment").value || null,
  };
  updateBuyersFilterBadge();
  renderBuyersList();
}

function clearBuyersFilters() {
  document.getElementById("bf-down").value = "";
  document.getElementById("bf-monthly").value = "";
  document.getElementById("bf-beds").value = "";
  document.querySelectorAll("#buyers-area-checkboxes input:checked").forEach((cb) => { cb.checked = false; });
  document.querySelectorAll("#buyers-stage-checkboxes input:checked").forEach((cb) => { cb.checked = false; });
  document.getElementById("bf-id").value = "";
  document.getElementById("bf-favorites").value = "";
  document.getElementById("bf-loggedin").value = "";
  document.getElementById("bf-contact-op").value = "";
  document.getElementById("bf-contact-period").value = "week";
  document.getElementById("bf-sentiment").value = "";
  applyBuyersFilters();
}

async function loadBuyers() {
  const token = getStoredAdminToken();
  const listEl = document.getElementById("buyers-list");
  if (!token) { listEl.innerHTML = "<p>Sign in as admin to view buyers.</p>"; return; }

  // Real bug, fixed 2026-09-11: this used to be called eagerly from
  // initBuyersTab(), which runs at page load time -- BEFORE this file's
  // own BUYERS_CANONICAL_AREAS/BUYERS_API_URL/etc. consts (declared
  // further down, since this whole section is appended after the main
  // init sequence) have executed. That threw a TDZ ReferenceError
  // ("Cannot access 'BUYERS_API_URL' before initialization") which,
  // uncaught, aborted the ENTIRE top-level script before loadData() ever
  // ran -- taking the property listings down with it, not just Buyers.
  // Calling it here instead is safe: loadBuyers() only ever runs lazily,
  // in response to a real tab click, which happens well after the whole
  // script has finished executing once.
  renderBuyersAreaCheckboxes();
  renderBuyersStageCheckboxes();

  listEl.innerHTML = "<p>Loading…</p>";
  try {
    const res = await fetch(`${BUYERS_API_URL}/buyers`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 403 || res.status === 401) {
      listEl.innerHTML = "<p>Not authorized. Sign in again.</p>";
      return;
    }
    const data = await res.json();
    // The worker returns { error, detail } (no `buyers` field) on a server
    // error (502) -- surface that plainly instead of silently falling
    // through to an empty list with "undefined total ... NaN unclassified"
    // (real bug found 2026-09-11: a Promise.all failure inside the worker's
    // /buyers handler was rendering exactly that misleading text).
    if (!res.ok || data.error) {
      listEl.innerHTML = `<p>Couldn't load buyers: ${data.error || res.status}${data.detail ? ` — ${data.detail}` : ""}</p>`;
      document.getElementById("buyers-count").textContent = "";
      return;
    }
    BUYERS_CACHE = data.buyers || [];
    document.getElementById("buyers-count").textContent =
      `${data.count} total — ${data.classifiedCount} area-tagged, ${data.count - data.classifiedCount} unclassified`;
    renderBuyersList();
  } catch (err) {
    listEl.innerHTML = `<p>Couldn't load buyers: ${err}</p>`;
  }
}

// Reversible sort, added 2026-09-11 per Aaron's direct request ("Sort
// should be able to toggle A-Z or Z-A for anything"). Each branch below
// is unchanged from before (still today's real default order at
// BUYERS_SORT_DIR's default value, 1) -- BUYERS_SORT_DIR just multiplies
// the whole comparator's result, which is enough to reverse an entire
// sort (including its own nested tie-breaks, e.g. area's own
// classified-first / most-recent-within-group ordering) without having
// to hand-flip every line individually.
// Added 2026-09-12 per Aaron's direct request -- soonest upcoming
// appointment date for a buyer, or null if they have none scheduled
// (today or later; a past appointment doesn't count, same "Scheduled vs
// Past" split the detail view already uses). Shared by the "Appointments"
// sort and the buyer-row red-outline highlight below.
function soonestUpcomingAppointmentDate(buyer) {
  const appts = buyer.loginsMatch && buyer.loginsMatch.appointments ? buyer.loginsMatch.appointments : [];
  const today = localTodayISO();
  const upcoming = appts.filter((a) => a.date >= today).map((a) => a.date).sort();
  return upcoming.length ? upcoming[0] : null;
}

function sortedBuyers() {
  const buyers = (BUYERS_CACHE || []).filter((b) => buyerMatchesFilters(b) && buyerMatchesSearch(b));
  const dir = BUYERS_SORT_DIR;
  if (BUYERS_SORT === "appointments") {
    // Buyers with an upcoming appointment first (soonest date first), then
    // everyone else falls back to Last Contact (any) so the list doesn't
    // just go alphabetical/random underneath the appointment block.
    const lastContactOf = (x) => Math.max(
      new Date(x.lastActivityAt || 0),
      new Date(x.lastCallAt || 0),
      new Date((x.loginsMatch && x.loginsMatch.lastLogin) || 0),
    );
    buyers.sort((a, b) => {
      const aDate = soonestUpcomingAppointmentDate(a), bDate = soonestUpcomingAppointmentDate(b);
      if (aDate && bDate) return dir * aDate.localeCompare(bDate);
      if (aDate !== bDate) return dir * (aDate ? -1 : 1);
      return dir * (lastContactOf(b) - lastContactOf(a));
    });
  } else if (BUYERS_SORT === "name") {
    const nameOf = (x) => x.quoName || (x.leadInfo && x.leadInfo.contactName) || x.phone;
    buyers.sort((a, b) => dir * nameOf(a).localeCompare(nameOf(b)));
  } else if (BUYERS_SORT === "last-contact") {
    // Added 2026-09-11 per Aaron's direct request -- the most recent of
    // texted, called, OR logged in, whichever is latest for each buyer.
    // Same "missing data sorts to the bottom" convention as the
    // individual sorts below (epoch 0 for anything absent).
    const lastContactOf = (x) => Math.max(
      new Date(x.lastActivityAt || 0),
      new Date(x.lastCallAt || 0),
      new Date((x.loginsMatch && x.loginsMatch.lastLogin) || 0),
    );
    buyers.sort((a, b) => dir * (lastContactOf(b) - lastContactOf(a)));
  } else if (BUYERS_SORT === "last-message") {
    // Renamed from "recent" 2026-09-11 (same underlying date, Quo
    // conversation activity) -- now one of three explicit last-contact
    // sorts instead of one vague "Most Recent Activity" option.
    buyers.sort((a, b) => dir * (new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0)));
  } else if (BUYERS_SORT === "last-login") {
    buyers.sort((a, b) => dir * (new Date((b.loginsMatch && b.loginsMatch.lastLogin) || 0) - new Date((a.loginsMatch && a.loginsMatch.lastLogin) || 0)));
  } else if (BUYERS_SORT === "last-call") {
    // lastCallAt comes from the worker's separate, slower calls_cache --
    // a buyer this hasn't reached yet just sorts to the bottom (epoch 0),
    // same as anyone genuinely never called.
    buyers.sort((a, b) => dir * (new Date(b.lastCallAt || 0) - new Date(a.lastCallAt || 0)));
  } else if (BUYERS_SORT === "area") {
    // Used to arrive pre-sorted from the API and need no client-side work
    // -- now sorted here explicitly so the direction toggle has something
    // to reverse. Same tie-break composition as before: classified before
    // unclassified, then A-Z by area, then most-recent-first within a group.
    buyers.sort((a, b) => {
      const aHas = a.areas && a.areas.length > 0, bHas = b.areas && b.areas.length > 0;
      if (aHas !== bHas) return dir * (aHas ? -1 : 1);
      if (aHas && bHas && a.areas[0] !== b.areas[0]) return dir * a.areas[0].localeCompare(b.areas[0]);
      return dir * (new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0));
    });
  } else if (BUYERS_SORT === "stage") {
    // Added 2026-09-12 per Aaron's direct request -- pipeline order (First
    // Contact through Multiple Buyer), same "set first, unset sorts to the
    // bottom" convention as the other sorts.
    const stageIndex = (s) => (s ? BUYER_STAGES.indexOf(s) : -1);
    buyers.sort((a, b) => {
      const aIdx = stageIndex(a.stage), bIdx = stageIndex(b.stage);
      if (aIdx === -1 || bIdx === -1) { if (aIdx !== bIdx) return dir * (aIdx === -1 ? 1 : -1); }
      return dir * (aIdx - bIdx);
    });
  } else if (BUYERS_SORT === "sentiment") {
    // Added 2026-09-12 per Aaron's direct request -- frown, then neutral,
    // then smile (most-to-least concerning); unset sorts to the bottom.
    const order = { frown: 0, neutral: 1, smile: 2 };
    const sentIndex = (s) => (s in order ? order[s] : 99);
    buyers.sort((a, b) => dir * (sentIndex(a.sentiment) - sentIndex(b.sentiment)));
  }
  return buyers;
}

function renderBuyersList() {
  const dateModeBtn = document.getElementById("buyers-date-mode-toggle");
  if (dateModeBtn) updateDateModeToggleLabel(dateModeBtn);
  const sortDirBtn = document.getElementById("buyers-sort-dir-toggle");
  if (sortDirBtn) updateSortDirToggleLabel(sortDirBtn);
  const cardModeBtn = document.getElementById("buyers-card-mode-toggle");
  if (cardModeBtn) updateCardModeToggleLabel(cardModeBtn);

  const listEl = document.getElementById("buyers-list");
  const buyers = sortedBuyers();
  if (buyers.length === 0) { listEl.innerHTML = "<p>No conversations found.</p>"; return; }

  let lastArea = undefined;
  const rows = [];
  for (const b of buyers) {
    // Group by the FIRST area when a buyer has more than one -- same
    // tie-break the area sort itself uses, so the grouping stays consistent
    // with sort order. Updated 2026-09-11: areas is now an array.
    const groupArea = b.areas && b.areas.length > 0 ? b.areas[0] : null;
    if (BUYERS_SORT === "area" && groupArea !== lastArea) {
      lastArea = groupArea;
      rows.push(`<div class="buyers-group-header">${escapeHtml(groupArea || "Unclassified")}</div>`);
    }
    // Fall back to the BUYERS-tab lead's contact name for buyers with no
    // Quo contact at all (standalone entries added 2026-09-11, see the
    // worker-side comment on why some leads never show up as a Quo
    // conversation participant).
    const realName = b.quoName || (b.leadInfo && b.leadInfo.contactName);
    const photoFlag = b.possibleIdImages && b.possibleIdImages.length ? " 📷" : "";
    // Copy-to-clipboard, added 2026-09-12 per Aaron's direct request
    // ("anywhere ... a phone number or email is displayed") -- only the
    // phone-as-name fallback and the email sub-line are actually a raw
    // phone/email; a real name/area list isn't, so those stay plain text.
    const labelHtml = realName ? escapeHtml(realName) + photoFlag : copyableTextHtml(b.phone) + photoFlag;
    const showEmailSub = !(b.areas && b.areas.length > 0 && BUYERS_SORT !== "area");
    const subEmail = showEmailSub && b.loginsMatch ? b.loginsMatch.email : "";
    const sub = showEmailSub ? "" : b.areas.join(", ");
    // Flags a mismatch between the Quo contact's own name and the name
    // actually read off their ID -- added 2026-09-12 per Aaron's direct
    // request to distinguish the two at a glance, not just on the detail
    // page. Loose case-insensitive substring check (not exact-equal) so a
    // clean match like "Alexis Langston" vs. Quo's "Alexis Langston WMTB"
    // doesn't falsely flag.
    const idNameVal = b.loginsMatch && b.loginsMatch.idName;
    const idNameMismatch = idNameVal && b.quoName && !b.quoName.toLowerCase().includes(idNameVal.toLowerCase());
    const idNameMismatchHtml = idNameMismatch
      ? `<span class="buyer-row-idname-flag" title="ID reads: ${escapeAttr(idNameVal)}">🪪⚠️ ID says "${escapeHtml(idNameVal)}"</span>`
      : "";
    // Last login (App: Logins sheet, via loginsMatch) and last texted (Quo
    // conversation activity) are two different signals -- a buyer can log
    // in without texting, or text without ever logging in -- so show both
    // rather than collapsing to one date. Added 2026-09-11 per Aaron's
    // request to see this at a glance on the list, not just in the detail view.
    const lastLogin = b.loginsMatch ? b.loginsMatch.lastLogin : "";
    const loginDate = lastLogin ? formatBuyerDate(lastLogin) : "";
    const textedDate = formatBuyerDate(b.lastActivityAt);
    // lastCallAt comes from the worker's separate, slower calls_cache (see
    // its own comment server-side) -- absent/null until that background
    // pass has actually reached this phone, in which case this just omits
    // the "Called:" date rather than showing anything misleading.
    const calledDate = b.lastCallAt ? formatBuyerDate(b.lastCallAt) : "";
    // At-a-glance badges, added 2026-09-11 per Aaron's direct request --
    // ID on file, and how many showings are actually booked (today or
    // later; a past-dated appointment doesn't count as "booked" here, see
    // the detail view's Scheduled/Past split for the full history).
    const today = localTodayISO();
    const upcomingCount = (b.loginsMatch && b.loginsMatch.appointments ? b.loginsMatch.appointments : []).filter((a) => a.date >= today).length;
    const hasId = !!(b.loginsMatch && b.loginsMatch.idLink);
    const hasLoggedIn = !!(b.loginsMatch && b.loginsMatch.firstLogin);
    // The ID badge is dropped from the DETAILED card specifically, added
    // 2026-09-13 per Aaron's direct request -- the detailed card already
    // shows the actual ID thumbnail (idThumbHtml below), so a redundant
    // "🪪 ID" badge on top of it added nothing. The COMPACT card below has
    // no thumbnail at all, so it keeps the badge -- that's its only way to
    // show "ID received" at a glance.
    const badgesHtml = `
      <span class="buyer-row-badges">
        ${upcomingCount > 0 ? `<span class="buyer-badge showing-badge" title="${upcomingCount} showing(s) booked">📅 ${upcomingCount}</span>` : ""}
        ${hasLoggedIn ? `<span class="buyer-badge login-badge" title="Has logged in">✅ Logged in</span>` : ""}
      </span>
    `;
    // Compact-card "last contact" -- added 2026-09-13 per Aaron's direct
    // request: "just something that says last contact which would take the
    // most recent of login texts and calls." Compares the three raw
    // timestamps (not the already-formatted date strings above) so the
    // actual most-recent one wins regardless of which channel it was.
    const contactCandidates = [
      { iso: lastLogin, label: "Login" },
      { iso: b.lastActivityAt, label: "Texted" },
      { iso: b.lastCallAt, label: "Called" },
    ].filter((c) => c.iso);
    let lastContactHtml = "";
    if (contactCandidates.length > 0) {
      contactCandidates.sort((a, c) => new Date(c.iso).getTime() - new Date(a.iso).getTime());
      const mostRecent = contactCandidates[0];
      lastContactHtml = `<span class="buyer-row-compact-contact" title="Most recent of login/text/call">Last contact: ${mostRecent.label} ${formatBuyerDate(mostRecent.iso)}</span>`;
    }
    // Card thumbnail, added 2026-09-12 per Aaron's direct request -- same
    // admin-id-photo blob-fetch as the detail view's full-size photo (a raw
    // Dropbox share link can't go straight into a plain <img src>, see
    // loadAdminIdPhoto's own comment), just rendered small via CSS. Wired
    // up below, same querySelectorAll(".admin-id-photo") pass the detail
    // view already uses.
    const idThumbHtml = b.loginsMatch && b.loginsMatch.idLink
      ? `<img class="buyer-row-thumb admin-id-photo" data-dropbox-link="${escapeAttr(b.loginsMatch.idLink)}" alt="ID on file">`
      : "";
    // Sentiment emoji + Stage dropdown, added 2026-09-12 per Aaron's
    // direct request -- quick controls right on the card, no need to open
    // the buyer's own detail page. Clicking an already-selected emoji
    // clears it (toggle off); the select saves on change. Rendered
    // directly into the status bar's own thirds below (buyer-row-status-bar
    // has the stopPropagation wiring, not a separate wrapper here).
    // Outline color, changed 2026-09-12 per Aaron's direct follow-up --
    // was a flat red for any upcoming appointment; now uses that buyer's
    // OWN current-stage color (STAGE_COLORS/stageColorFor) instead, so the
    // card border tells you both "there's a showing coming up" (whether
    // it's outlined at all) AND roughly where they are in the pipeline
    // (which color). Falls back to a neutral gray if they have an
    // appointment but no stage set yet, rather than no outline at all.
    const stageOutlineColor = upcomingCount > 0 ? (stageColorFor(b.stage) || "#9ca3af") : null;
    // Card layout, redone a third time 2026-09-12 per Aaron's explicit
    // correction -- NOT one unified grid. Two independent stacked
    // sections, each split differently:
    //   Top section: two EQUAL HALVES -- left = ID photo, right = name/
    //   phone/badges.
    //   Bottom section ("the status bar," full card width): three EQUAL
    //   THIRDS -- sentiment emoji | stage | last login/text/call info.
    // Building these as two independent flex rows (not one grid) is what
    // actually reproduces "top splits in half, bottom splits in thirds" --
    // a single grid's column tracks can't be half-width on one row and
    // third-width on another.
    //
    // Switched from <button> to a clickable <div> 2026-09-12 -- a <select>
    // and buttons (sentiment emoji, stage dropdown) can't validly nest
    // inside a <button>'s content model. role="button" + tabindex keep it
    // reachable/activatable via keyboard.
    const rowStyle = stageOutlineColor ? ` style="border-color:${stageOutlineColor};border-width:2px"` : "";
    if (BUYERS_CARD_MODE === "compact") {
      // Compact card, added 2026-09-13 per Aaron's direct request: one or
      // two lines -- name, area, ID-received/logged-in icons, and a single
      // "last contact" line (the most recent of login/text/call, computed
      // above as lastContactHtml). No thumbnail, no sentiment/stage
      // controls -- open the buyer's own detail page for those.
      const areaText = b.areas && b.areas.length > 0 ? b.areas.join(", ") : "";
      rows.push(`
        <div class="buyer-row buyer-row-compact" data-phone="${escapeHtml(b.phone)}" role="button" tabindex="0"${rowStyle}>
          <div class="buyer-row-compact-line1">
            <span class="buyer-row-name">${labelHtml}</span>
            ${areaText ? `<span class="buyer-row-compact-area">${escapeHtml(areaText)}</span>` : ""}
            <span class="buyer-row-compact-icons">
              <span class="buyer-badge id-badge${hasId ? "" : " buyer-badge-off"}" title="${hasId ? "ID on file" : "No ID on file"}">🪪</span>
              <span class="buyer-badge login-badge${hasLoggedIn ? "" : " buyer-badge-off"}" title="${hasLoggedIn ? "Has logged in" : "Hasn't logged in"}">✅</span>
            </span>
          </div>
          <div class="buyer-row-compact-line2">
            ${lastContactHtml || `<span class="buyer-row-compact-contact">No contact yet</span>`}
            ${idNameMismatchHtml}
          </div>
        </div>
      `);
    } else {
      rows.push(`
        <div class="buyer-row" data-phone="${escapeHtml(b.phone)}" role="button" tabindex="0"${rowStyle}>
          <div class="buyer-row-top">
            <div class="buyer-row-top-half buyer-row-top-thumb-half">
              ${idThumbHtml || `<div class="buyer-row-thumb buyer-row-no-thumb"></div>`}
            </div>
            <div class="buyer-row-top-half buyer-row-top-info-half">
              <div class="buyer-row-main">
                <span class="buyer-row-name">${labelHtml}</span>
                ${badgesHtml}
                ${subEmail ? `<span class="buyer-row-sub">${copyableTextHtml(subEmail)}</span>` : sub ? `<span class="buyer-row-sub">${escapeHtml(sub)}</span>` : ""}
                ${idNameMismatchHtml}
              </div>
            </div>
          </div>
          <div class="buyer-row-status-bar">
            <div class="status-bar-third status-bar-sentiment">
              <span class="sentiment-picker">${renderSentimentPickerHtml(b)}</span>
            </div>
            <div class="status-bar-third status-bar-stage">
              ${renderStageSelectHtml(b)}
            </div>
            <div class="status-bar-third status-bar-dates">
              ${loginDate ? `<span class="buyer-row-date" title="Last login">Login: ${loginDate}</span>` : ""}
              ${textedDate ? `<span class="buyer-row-date" title="Last texted">Texted: ${textedDate}</span>` : ""}
              ${calledDate ? `<span class="buyer-row-date" title="Last called">Called: ${calledDate}</span>` : ""}
            </div>
          </div>
        </div>
      `);
    }
  }
  listEl.innerHTML = rows.join("");
  listEl.querySelectorAll(".buyer-row").forEach((el) => {
    el.addEventListener("click", () => showBuyerDetail(el.dataset.phone));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showBuyerDetail(el.dataset.phone); } });
  });
  listEl.querySelectorAll(".buyer-row-status-bar").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
  });
  listEl.querySelectorAll(".sentiment-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const current = btn.classList.contains("sentiment-btn-selected");
      setBuyerSentiment(btn.dataset.phone, current ? "" : btn.dataset.sentiment);
    });
  });
  listEl.querySelectorAll(".stage-select").forEach((sel) => {
    sel.addEventListener("click", (e) => e.stopPropagation());
    sel.addEventListener("change", (e) => setBuyerStage(e.target.dataset.phone, e.target.value));
  });
  // Load card thumbnails lazily, same admin-id-photo wiring the detail view
  // uses -- deliberately AFTER the click-handler wiring above, so a slow
  // thumbnail fetch never blocks the list from being interactive.
  listEl.querySelectorAll(".admin-id-photo").forEach((img) => loadAdminIdPhoto(img, img.dataset.dropboxLink));
}

// Both save immediately, no confirm dialog (purely Aaron's own internal
// notes, never seen by a third party) -- update BUYERS_CACHE in place so
// the card reflects the change without waiting on the next background
// sync, then re-render.
// onDone, added 2026-09-12 -- these now also get called from the top of
// the buyer detail page (not just the list card), which needs to
// re-render ITSELF afterward, not the list underneath it. Defaults to the
// original list-card behavior when omitted.
async function setBuyerSentiment(phone, sentiment, onDone) {
  const token = getStoredAdminToken();
  try {
    const res = await fetch(`${ADMIN_API_URL}/admin/set-sentiment`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone, sentiment }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) { alert(`Couldn't save: ${(data && data.error) || res.status}`); return; }
    const buyer = findBuyer(phone);
    if (buyer) buyer.sentiment = sentiment;
    if (onDone) onDone(); else renderBuyersList();
  } catch (err) {
    alert(`Couldn't save: ${err}`);
  }
}

async function setBuyerStage(phone, stage, onDone) {
  const token = getStoredAdminToken();
  try {
    const res = await fetch(`${ADMIN_API_URL}/admin/set-stage`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone, stage }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) { alert(`Couldn't save: ${(data && data.error) || res.status}`); return; }
    const buyer = findBuyer(phone);
    if (buyer) buyer.stage = stage;
    if (onDone) onDone(); else renderBuyersList();
  } catch (err) {
    alert(`Couldn't save: ${err}`);
  }
}

function formatShortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// "Days since" toggle for Texted/Called/Login on the buyer list, added
// 2026-09-11 per Aaron's direct request. Persisted in localStorage --
// same "remembered per-device convenience" pattern as favorites/viewed
// above, not something synced to the Sheet.
const BUYERS_DATE_MODE_STORAGE_KEY = "iah_buyers_date_mode";
let BUYERS_DATE_MODE = (() => {
  try { return localStorage.getItem(BUYERS_DATE_MODE_STORAGE_KEY) || "date"; } catch (e) { return "date"; }
})();
function formatDaysSince(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}
// Picks formatShortDate or formatDaysSince based on the current toggle
// state -- single call site for every Texted/Called/Login date so the
// toggle affects all three at once, consistently.
function formatBuyerDate(iso) {
  return BUYERS_DATE_MODE === "days" ? formatDaysSince(iso) : formatShortDate(iso);
}

// Compact/Detailed card toggle, added 2026-09-13 per Aaron's direct
// request -- same localStorage-persisted-convenience pattern as
// BUYERS_DATE_MODE just above. "Detailed" (the pre-existing card) stays
// the default so nothing changes for anyone who hasn't touched the toggle.
const BUYERS_CARD_MODE_STORAGE_KEY = "iah_buyers_card_mode";
let BUYERS_CARD_MODE = (() => {
  try { return localStorage.getItem(BUYERS_CARD_MODE_STORAGE_KEY) || "detailed"; } catch (e) { return "detailed"; }
})();

// Same BUYERS_DATE_MODE toggle, extended 2026-09-12 per Aaron's direct
// request to the Appointments tab's own date -- that one can be a FUTURE
// date (an upcoming showing) as often as a past one, which formatDaysSince
// above was never built for (it assumes "since", producing a nonsense
// negative-day "today" for anything not yet happened). This handles both
// directions: "Today", "in Nd", or "Nd ago".
// Real bug found and fixed 2026-09-12, Aaron caught it directly: a
// 2026-09-13 appointment showed as "Today" on 2026-09-12. Cause: `new
// Date(dateStr)` parses a bare "YYYY-MM-DD" as UTC MIDNIGHT, then this was
// diffed against Date.now() (the current precise instant) -- late enough
// in the day in a timezone behind UTC (Aaron's own America/Los_Angeles,
// UTC-7/-8), "tomorrow at UTC midnight" is only a few hours away in real
// time, and Math.round() collapsed that gap to 0 days. The fix: diff two
// CALENDAR DATE strings against each other (both parsed the same way, as
// UTC midnight), never against the live instant -- localTodayISO()
// already exists for exactly this "what's today, in the viewer's own
// timezone" concept, used elsewhere in this file for the same reason.
function daysBetweenDateStrings(fromStr, toStr) {
  const a = new Date(fromStr + "T00:00:00Z");
  const b = new Date(toStr + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}
function formatApptDate(dateStr) {
  if (BUYERS_DATE_MODE !== "days") return formatShortDate(dateStr);
  const days = daysBetweenDateStrings(localTodayISO(), dateStr);
  if (days === 0) return "Today";
  if (days > 0) return days === 1 ? "in 1d" : `in ${days}d`;
  return days === -1 ? "1d ago" : `${-days}d ago`;
}

function findBuyer(phone) {
  return (BUYERS_CACHE || []).find((b) => b.phone === phone);
}

function showBuyerDetail(phone) {
  const buyer = findBuyer(phone);
  if (!buyer) return;
  CURRENT_BUYER_DETAIL_PHONE = phone;
  document.getElementById("buyers-list-view").classList.add("hidden");
  document.getElementById("buyers-detail-view").classList.remove("hidden");
  renderBuyerDetail(buyer);
  initBuyerDetailSwipe();
}

// Swipe left/right to move to the next/previous buyer, added 2026-09-12
// per Aaron's direct request ("go to the next/previous card based on my
// sorting criteria") -- walks the SAME sortedBuyers() order (current
// sort + filters + search) the list itself is showing, so this always
// matches whatever's actually on screen. Same touch-swipe pattern already
// used for the Steps tab (initStepSwipe/SWIPE_THRESHOLD above).
function showAdjacentBuyer(direction) {
  const list = sortedBuyers();
  if (list.length === 0) return;
  const phone = CURRENT_BUYER_DETAIL_PHONE;
  const idx = list.findIndex((b) => b.phone === phone);
  if (idx === -1) return; // current buyer got filtered out from under us -- nothing sane to step to
  const nextIdx = idx + direction;
  if (nextIdx < 0 || nextIdx >= list.length) return; // at an edge -- no wraparound
  const next = list[nextIdx];
  showBuyerDetail(next.phone);
  // Visual confirmation, added 2026-09-12 per Aaron's direct request ("I
  // have accidentally swiped before and didn't know that I was on a new
  // page") -- a brief slide-in toast naming who you just landed on and
  // which direction, plus a quick flash on the whole page content so a
  // swipe is unmistakably felt even if you don't read the toast text.
  flashSwipeIndicator(direction, next.quoName || (next.leadInfo && next.leadInfo.contactName) || next.phone);
}

function flashSwipeIndicator(direction, name) {
  const container = document.getElementById("buyers-detail-content");
  if (container) {
    container.classList.remove("swipe-flash-left", "swipe-flash-right");
    void container.offsetWidth; // force reflow so the animation restarts on back-to-back swipes
    container.classList.add(direction > 0 ? "swipe-flash-left" : "swipe-flash-right");
  }
  const existing = document.querySelector(".swipe-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = "swipe-toast";
  toast.textContent = `${direction > 0 ? "→" : "←"} ${name}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1000);
}

let CURRENT_BUYER_DETAIL_PHONE = null;
let buyerDetailSwipeWired = false;
function initBuyerDetailSwipe() {
  if (buyerDetailSwipeWired) return;
  buyerDetailSwipeWired = true;
  const section = document.getElementById("buyers-detail-view");
  if (!section) return;
  let startX = null;
  let startY = null;
  section.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  section.addEventListener("touchend", (e) => {
    if (startX === null || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    startX = null;
    startY = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return; // not a real horizontal swipe
    showAdjacentBuyer(dx < 0 ? 1 : -1); // swipe left = next, swipe right = previous
  }, { passive: true });
}

// Real bug fixed 2026-09-12, found by Aaron directly: this used to just
// toggle visibility, never re-rendering the list -- so a sentiment/stage
// change made from the TOP of a buyer's detail page (setBuyerSentiment/
// setBuyerStage there mutate the shared BUYERS_CACHE object fine, but only
// re-render the detail view itself, via their onDone callback) never
// showed up on that buyer's own list card until something else happened
// to reload the whole list (switching tabs away and back). The list-card
// controls' own writes were never affected (they already call
// renderBuyersList() themselves) -- this was a one-way gap, not a data
// problem: BUYERS_CACHE was always current, the list's rendered DOM
// underneath just wasn't refreshed to match it.
// Scrolls back to the card you actually came from, added 2026-09-13 per
// Aaron's direct request -- previously this always landed back at the top
// of the list, which is disorienting on a long, sorted/filtered list when
// the buyer you were looking at is 40 cards down. Uses the SAME data-phone
// attribute the click handler below reads, and scrollIntoView's own
// "nearest"/"center" behavior rather than hand-computing an offset, so it
// stays correct regardless of card height (compact vs. detailed mode).
function backToBuyersList() {
  const phone = CURRENT_BUYER_DETAIL_PHONE;
  document.getElementById("buyers-detail-view").classList.add("hidden");
  document.getElementById("buyers-list-view").classList.remove("hidden");
  renderBuyersList();
  if (phone) {
    const row = document.querySelector(`.buyer-row[data-phone="${cssEscapeAttrValue(phone)}"]`);
    if (row) row.scrollIntoView({ block: "center" });
  }
}

// Minimal CSS.escape-alike for a data-attribute value used inside a
// querySelector string -- phones are already E.164 ("+15555555555"), whose
// only special CSS-selector character is the leading "+", but this escapes
// defensively rather than assuming that never changes.
function cssEscapeAttrValue(value) {
  if (window.CSS && typeof CSS.escape === "function") return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

// Two links: the openphone:// scheme (documented at
// https://support.quo.com/core-concepts/integrations/deep-linking) opens
// that phone number's conversation directly in the Quo mobile app if
// installed -- silently does nothing on a device with no handler for it
// (desktop, or the app not installed), which is why the plain web URL
// stays alongside it rather than replacing it. There's no documented way
// to deep-link straight to a contact/conversation BY ID, only by phone
// number, so this is the closest real equivalent to "open this buyer in
// the app."
// Colors swapped 2026-09-12 per Aaron's direct request -- app link (the
// one he'll actually tap on his phone) is now the blue/primary one, the
// browser fallback white/outline. Wrapped in .buyer-quo-links so the two
// sit side by side (added same day -- see .buyer-quo-links in style.css).
function quoAppAndWebLinks(phone, webUrl) {
  if (!webUrl) return "";
  const appHtml = phone
    ? `<a href="openphone://message?number=${encodeURIComponent(phone)}" class="btn-primary buyer-quo-link">Open in Quo app</a>`
    : "";
  return `<div class="buyer-quo-links">${appHtml}<a href="${escapeAttr(webUrl)}" target="_blank" rel="noopener" class="btn-outline buyer-quo-link">Open in Quo (browser)</a></div>`;
}

function renderBuyerDetail(buyer) {
  const lm = buyer.loginsMatch;
  const container = document.getElementById("buyers-detail-content");

  // Real bug, fixed 2026-09-11: a raw Dropbox shared link doesn't render
  // as an image via a plain <img src> -- it's an HTML preview page, not
  // image bytes. Same reason the visitor-facing My Info tab never does
  // this either (see loadIdPhotoThumbnail) -- render a blank <img> here
  // and fill it in via loadAdminIdPhoto() below, after this HTML is in
  // the DOM, same fetch+blob-URL pattern.
  // Click-to-view/upload, added 2026-09-12 per Aaron's direct request
  // ("click on the ID photo to update ID or add id... or see it in full
  // screen") -- replaces the plain link-to-Dropbox. Clicking the photo
  // (or the empty placeholder, if there's no ID yet) opens a lightbox
  // (openIdLightbox) with the full-size image and an "Upload new ID"
  // action in the same place, whether or not one's on file yet.
  const idPhoto = lm && lm.idLink
    ? `<img class="buyer-id-photo admin-id-photo buyer-id-photo-clickable" data-dropbox-link="${escapeAttr(lm.idLink)}" data-phone="${escapeAttr(buyer.phone)}" alt="ID on file (click to view or replace)">`
    : `<div class="buyer-no-id-clickable" data-phone="${escapeAttr(buyer.phone)}">No ID on file. Click to add one.</div>`;

  // Background image scan (see IMAGES_CACHE_KEY server-side) found images
  // in this buyer's texts and they have no ID on file yet -- flagged for
  // Aaron to actually look at, never auto-filed as their ID. Added
  // 2026-09-11 per Aaron's direct request to search Quo conversations for
  // ID photos, not just the Dropbox folder.
  const possibleIdHtml = !(lm && lm.idLink) && buyer.possibleIdImages && buyer.possibleIdImages.length
    ? `<div class="buyer-section possible-id-flag">
        <h3>📷 Possible ID sent via text</h3>
        <p>No ID on file yet, but this buyer sent ${buyer.possibleIdImages.length} image(s) in their texts. Check if one is their ID:</p>
        <div class="possible-id-images">
          ${buyer.possibleIdImages.map((url) => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener"><img src="${escapeAttr(url)}" class="buyer-id-photo" alt="Possible ID from text"></a>`).join("")}
        </div>
      </div>`
    : "";

  // Three distinct name sources, added 2026-09-12 per Aaron's direct
  // request ("distinguish between the Quo name for a contact and their
  // login name for IAH and the name pulled from the ID") -- these can
  // genuinely disagree (a garbage/placeholder Quo name is a real example
  // found the same day: Angela McDonald's Quo contact was literally named
  // "WMTB CHURCH ST NO NAME" even though her real ID OCR'd cleanly).
  // "Quo Name" and "Areas" removed from this plain list 2026-09-12 --
  // Quo Name is now the page's own <h2> (click to edit, see
  // buyer-name-editable below), and Areas gets its own clickable block
  // right after it (buyer-areas-editable) -- both to save space (per
  // Aaron's direct request) and because they're editable now, unlike
  // everything else still in this read-only list.
  const facts = [
    ["Login Name (IAH)", (lm && lm.name) || ""],
    ["ID Name (OCR)", (lm && lm.idName) || ""],
    ["Phone", buyer.phone],
    ["Email", (lm && lm.email) || ""],
    ["First login", (lm && lm.firstLogin) || ""],
    ["Last login", (lm && lm.lastLogin) || ""],
    // Cross-referenced from a Glide-app login with no phone on its own
    // App: Logins row -- added 2026-09-11 per Aaron's direct request. See
    // matchEmailToContact's own comment server-side for how the identity
    // was recovered.
    ["Login Source", lm && lm.viaGlide ? "Glide App" : ""],
    ["Agreed to terms", (lm && lm.agreed) || ""],
    ["Last activity (Quo)", formatShortDate(buyer.lastActivityAt)],
  ].filter(([, v]) => v);

  // Phone/Email copy-to-clipboard, added 2026-09-12 per Aaron's direct
  // request -- these two facts get the copyable-text treatment, everything
  // else in this list stays plain escaped text.
  const COPYABLE_FACT_LABELS = new Set(["Phone", "Email"]);
  const factsHtml = facts.map(([k, v]) => `<div class="detail-field"><span class="label">${k}</span><span class="value">${COPYABLE_FACT_LABELS.has(k) ? copyableTextHtml(String(v)) : escapeHtml(String(v))}</span></div>`).join("");

  // Lead info from the Filling Sheet's separate "BUYERS" tab (rating,
  // preferences, company/landlord, which Quo number they came in on) --
  // added 2026-09-11 per Aaron's direct request. A distinct data source
  // from loginsMatch above (that's the site's own App: Logins), so its
  // own section rather than folded into factsHtml.
  const li = buyer.leadInfo;
  const leadFacts = li ? [
    ["Contact Name", li.contactName],
    ["Company", li.companyName],
    ["Landlord", li.landlord ? "Yes" : ""],
    ["Rating", li.rating],
    ["Location", [li.city, li.state].filter(Boolean).join(", ")],
    ["Min Beds", li.minBeds],
    ["Min Baths", li.minBaths],
    ["Max Monthly", li.maxMonthly],
    ["Other Preferences", li.otherPreferences],
    ["First Contact Address", li.firstContactAddress],
    ["Date Added", li.dateAdded],
  ].filter(([, v]) => v) : [];
  const leadInfoHtml = leadFacts.length ? `
    <div class="buyer-section">
      <h3>Lead Info</h3>
      ${leadFacts.map(([k, v]) => `<div class="detail-field"><span class="label">${k}</span><span class="value">${escapeHtml(String(v))}</span></div>`).join("")}
      ${li.openphoneLink ? quoAppAndWebLinks(buyer.phone, li.openphoneLink) : ""}
    </div>
  ` : "";

  const favoritesHtml = lm && lm.favorites && lm.favorites.length
    ? `<div class="buyer-section"><h3>Favorited Properties (${lm.favorites.length})</h3>${lm.favorites.map((f) => `<div class="buyer-list-item">${escapeHtml(f)}</div>`).join("")}</div>`
    : "";

  // Viewed Properties -- passive, every detail page this buyer opened on
  // the site (see recordViewed() in showDetail()). Read-only here, same
  // as Favorites/Appointments -- this is the buyer's own browsing
  // activity, not something Aaron edits.
  const viewedHtml = lm && lm.viewed && lm.viewed.length
    ? `<div class="buyer-section"><h3>Viewed Properties (${lm.viewed.length})</h3>${lm.viewed.map((v) => `<div class="buyer-list-item">${escapeHtml(v)}</div>`).join("")}</div>`
    : "";

  // Shown Properties -- Aaron's own admin-side record of what he's
  // personally shown/let this buyer into, added 2026-09-11 per his direct
  // request. Editable here (unlike Viewed above): a text input backed by
  // A custom JS-driven suggestion dropdown, not a native <datalist> --
  // reverted 2026-09-11 per Aaron's follow-up report that the native
  // datalist rendered its suggestions "in the keyboard" rather than as a
  // real dropdown (a known real limitation: mobile Safari/Chrome render
  // <datalist> inconsistently, sometimes as a thin strip competing with
  // the keyboard instead of a proper list). initShownPropertyAutocomplete()
  // below builds the actual dropdown, filtered live against
  // SHOWN_AVAILABLE_ADDRESSES as you type. Already-shown addresses
  // excluded so it only ever suggests something new to add. Needs lm.row
  // (the buyer's real Sheet row, added server-side 2026-09-11) -- if
  // that's somehow missing, the add control just doesn't render rather
  // than posting a request with no way to target a row.
  const alreadyShown = new Set(lm && lm.shown ? lm.shown : []);
  // Deliberately NOT Available-only, per Aaron's direct follow-up
  // (2026-09-12) -- this is a historical record of what he's actually
  // shown someone, which can genuinely include a property that's since
  // gone Pending/Sold. A same-day-earlier change had restricted this to
  // Available-only (reasonable for scheduling a NEW showing, wrong for
  // logging a past one) -- reverted here; Schedule a Showing below keeps
  // its own Available-only filter, that one's correct as-is.
  SHOWN_AVAILABLE_ADDRESSES = (ALL_LISTINGS || [])
    .filter((l) => !alreadyShown.has(l.address))
    .map((l) => l.address);
  const shownListHtml = (lm && lm.shown ? lm.shown : []).map((address) => `
    <div class="buyer-list-item shown-property-item">
      <span>${escapeHtml(address)}</span>
      ${lm && lm.row ? `<button type="button" class="shown-remove-btn" data-row="${lm.row}" data-address="${escapeAttr(address)}">Remove</button>` : ""}
    </div>
  `).join("");
  const shownAddHtml = lm && lm.row ? `
    <div class="shown-add-row">
      <div class="autocomplete-wrap">
        <input type="text" id="shown-property-input" placeholder="Type an address…" autocomplete="off">
        <div id="shown-property-suggestions" class="autocomplete-dropdown hidden"></div>
      </div>
      <button type="button" id="shown-add-btn" data-row="${lm.row}" class="btn-outline">Mark shown</button>
    </div>
  ` : "";
  const shownHtml = `<div class="buyer-section"><h3>Shown Properties${lm && lm.shown && lm.shown.length ? ` (${lm.shown.length})` : ""}</h3>${shownListHtml}${shownAddHtml}</div>`;

  // Split into Scheduled (today or later) vs Past, added 2026-09-11 per
  // Aaron's direct request -- previously one flat list with no distinction.
  const todayForAppts = localTodayISO();
  const scheduledAppts = (lm && lm.appointments ? lm.appointments : []).filter((a) => a.date >= todayForAppts);
  const pastAppts = (lm && lm.appointments ? lm.appointments : []).filter((a) => a.date < todayForAppts);
  const apptItem = (a) => `<div class="buyer-list-item">${escapeHtml(a.address)} — ${escapeHtml(a.date)}</div>`;
  // Schedule a showing, added 2026-09-12 per Aaron's direct request ("set
  // an appointment for a buyer for a property from their Buyer page
  // myself"). Same autocomplete pattern as Shown Properties above, but
  // against every Available listing (not excluding already-shown ones --
  // a second showing at the same property is a normal thing to schedule).
  // Available-only filter added same day per Aaron's follow-up ("only
  // display available properties there") -- matches the same filter the
  // visitor-facing Get Started page already applies
  // (getStartedAvailableListings). Writes through /admin/add-appointment
  // into the SAME Appointment 1-10 columns the public booking flow uses,
  // so the property-card admin badge and this same buyer's own Scheduled
  // Showings list above both pick it up automatically, no separate
  // rendering needed.
  APPOINTMENT_AVAILABLE_ADDRESSES = (ALL_LISTINGS || []).filter((l) => l.status === "Available").map((l) => l.address);
  // Restyled 2026-09-12 per Aaron's direct request ("make it look more
  // like the other things on the page") to match the visitor-facing Get
  // Started form's own .form-card look (docs/index.html) instead of the
  // plain buyer-section it started as. Date field switched from a native
  // <input type="date"> to the SAME closed <select> Get Started already
  // uses (buildDateOptions(), next 10 days) -- the real, previously-fixed
  // reason: several mobile browsers ignore an <input type="date">'s
  // min= entirely and show a full calendar anyway, so "only certain days
  // schedulable" needs the closed-option-list approach, not min=/max=.
  const apptDateOptionsHtml = buildDateOptions()
    .map(({ value, label }) => `<option value="${value}">${escapeHtml(label)}</option>`)
    .join("");
  const scheduleApptHtml = lm && lm.row ? `
    <div class="buyer-section">
      <h3>Schedule a Showing</h3>
      <div class="form-card schedule-appt-card">
        <label>Property Address
          <div class="autocomplete-wrap">
            <input type="text" id="appt-property-input" placeholder="Type an address…" autocomplete="off">
            <div id="appt-property-suggestions" class="autocomplete-dropdown hidden"></div>
          </div>
        </label>
        <label>Date
          <select id="appt-date-input">
            <option value="" disabled selected>Choose a date</option>
            ${apptDateOptionsHtml}
          </select>
        </label>
        <button type="button" id="appt-schedule-btn" data-phone="${escapeAttr(buyer.phone)}" data-row="${lm.row}" class="btn-primary">Schedule</button>
        <div id="appt-schedule-status"></div>
      </div>
    </div>
  ` : "";

  const scheduledHtml = scheduledAppts.length
    ? `<div class="buyer-section"><h3>Scheduled Showings (${scheduledAppts.length})</h3>${scheduledAppts.map(apptItem).join("")}</div>`
    : "";
  const pastHtml = pastAppts.length
    ? `<div class="buyer-section"><h3>Past Showings (${pastAppts.length})</h3>${pastAppts.map(apptItem).join("")}</div>`
    : "";

  const coBuyersHtml = lm && lm.coBuyers && lm.coBuyers.length
    ? `<div class="buyer-section"><h3>Co-Buyers</h3>${lm.coBuyers.map((c) => `
        <div class="co-buyer-block">
          <div class="detail-field"><span class="label">Name</span><span class="value">${escapeHtml(c.name)}</span></div>
          ${c.phone ? `<div class="detail-field"><span class="label">Phone</span><span class="value">${escapeHtml(c.phone)}</span></div>` : ""}
          ${c.email ? `<div class="detail-field"><span class="label">Email</span><span class="value">${escapeHtml(c.email)}</span></div>` : ""}
          ${c.idLink ? `<a href="${escapeAttr(c.idLink)}" target="_blank" rel="noopener"><img class="buyer-id-photo admin-id-photo" data-dropbox-link="${escapeAttr(c.idLink)}" alt="Co-buyer ID"></a>` : `<p class="buyer-no-id">No ID on file.</p>`}
        </div>`).join("")}</div>`
    : "";

  const filtersHtml = lm && lm.filters && (lm.filters.maxDown || lm.filters.maxMonthly || lm.filters.minBeds || lm.filters.areas)
    ? `<div class="buyer-section"><h3>Search Filters Used</h3>
        ${lm.filters.areas ? `<div class="detail-field"><span class="label">Area(s)</span><span class="value">${escapeHtml(lm.filters.areas)}</span></div>` : ""}
        ${lm.filters.maxDown ? `<div class="detail-field"><span class="label">Max Down</span><span class="value">${escapeHtml(lm.filters.maxDown)}</span></div>` : ""}
        ${lm.filters.maxMonthly ? `<div class="detail-field"><span class="label">Max Monthly</span><span class="value">${escapeHtml(lm.filters.maxMonthly)}</span></div>` : ""}
        ${lm.filters.minBeds ? `<div class="detail-field"><span class="label">Min Beds</span><span class="value">${escapeHtml(lm.filters.minBeds)}</span></div>` : ""}
        ${lm.lastSearch ? `<div class="detail-field"><span class="label">Last Search</span><span class="value">${escapeHtml(lm.lastSearch)}</span></div>` : ""}
      </div>`
    : "";

  // Two links, added 2026-09-12 per Aaron's direct request ("open the app
  // on my phone, or only the browser url?"): Quo's own deep-linking is
  // documented (https://support.quo.com/core-concepts/integrations/
  // deep-linking) for dial/message-by-phone-number only -- there is no
  // "open this contact/conversation by ID" scheme, so `openphone://
  // message?number=...` (opens that phone's conversation thread in the
  // app) is the closest real equivalent to "open this buyer in Quo," not
  // a documented contact-page deep link. Desktop/web has no handler for
  // openphone:// at all (Quo's own docs: "available for mobile apps
  // only") -- kept as a second button rather than the only one, since
  // Aaron also uses this from a laptop.
  const quoLinkHtml = quoAppAndWebLinks(buyer.phone, buyer.quoUrl);

  // Standalone Edit section + Messages section both REMOVED 2026-09-12 per
  // Aaron's direct request, to save space on the page:
  // - Name is now editable by clicking the <h2> itself (see
  //   buyer-name-editable below) -- Quo-rename only, no longer bundled
  //   with areas.
  // - Areas are now editable by clicking the Areas fact row itself (see
  //   buyer-areas-editable below) -- set-areas only, no longer bundled
  //   with a Quo rename.
  // - ID upload/view is now the ID photo itself, click to open a
  //   fullscreen lightbox with an "Upload new ID" action in it (see
  //   idPhoto below and openIdLightbox).
  // - Messages/compose section removed outright -- "since I now have the
  //   Quo app button, which takes me directly to a conversation, I don't
  //   even think that I need to be able to render the quo conversations
  //   at the bottom of every Buyer page anymore." loadBuyerMessages/
  //   sendBuyerMessage are left defined but unwired, same as the ID-match
  //   buttons removed earlier today -- trivial to bring back a button if
  //   ever wanted.
  const personalName = stripAreaTagsFromName(buyer.quoName || (buyer.leadInfo && buyer.leadInfo.contactName) || "");

  // Header block, added 2026-09-12 per Aaron's direct request: Quo links
  // side by side (moved into quoAppAndWebLinks's own wrapper div, see its
  // comment), a stage progress bar, and the SAME sentiment/stage controls
  // the list card has -- all updatable from the top of the page, not just
  // from the list.
  const detailHeaderHtml = `
    <div class="buyer-detail-header">
      ${quoLinkHtml}
      ${renderStageProgressBarHtml(buyer)}
      <div class="buyer-detail-quick-status">
        <span class="sentiment-picker">${renderSentimentPickerHtml(buyer)}</span>
        ${renderStageSelectHtml(buyer)}
      </div>
    </div>
  `;

  // Click-to-edit name, added 2026-09-12 per Aaron's direct request ("just
  // be able to click on the Quo name to edit it") -- replaces the
  // standalone Edit section's Name field + Save button. Click the
  // heading, it becomes a text input pre-filled with the name (tag
  // stripped, same as before); Enter or blur saves via
  // /admin/update-contact-name (Quo rename only -- areas are their own
  // click target now, see below, not bundled into this write anymore).
  const nameHeadingHtml = `
    <h2 class="buyer-name-editable" data-phone="${escapeAttr(buyer.phone)}" data-personal-name="${escapeAttr(personalName)}" tabindex="0" title="Click to edit">
      ${escapeHtml(buyer.quoName || (buyer.leadInfo && buyer.leadInfo.contactName) || buyer.phone)}
    </h2>
  `;

  // Click-to-edit areas, added 2026-09-12 per Aaron's direct request
  // ("click on the area to add areas") -- replaces the Edit section's
  // area checkboxes. Click the fact, it becomes the same checkbox list
  // inline; each checkbox saves immediately via /admin/set-areas (no
  // separate Save button, no Quo-name bundling -- that's the name click
  // target's own job now).
  const areasDisplayHtml = (buyer.areas && buyer.areas.length > 0) ? escapeHtml(buyer.areas.join(", ")) : "Not yet classified";
  const areasCheckboxesHtml = BUYERS_CANONICAL_AREAS.map((area) => `
    <label class="edit-area-checkbox">
      <input type="checkbox" class="buyer-areas-checkbox" value="${escapeAttr(area)}" ${buyer.areas && buyer.areas.includes(area) ? "checked" : ""}>
      ${escapeHtml(area)}
    </label>
  `).join("");
  const areasBlockHtml = `
    <div class="detail-field buyer-areas-editable" data-phone="${escapeAttr(buyer.phone)}" tabindex="0" title="Click to edit">
      <span class="label">Areas</span>
      <span class="value buyer-areas-display">${areasDisplayHtml}</span>
      <div class="buyer-areas-edit-panel hidden">${areasCheckboxesHtml}</div>
    </div>
  `;

  container.innerHTML = `
    ${nameHeadingHtml}
    ${detailHeaderHtml}
    <div class="buyer-id-section">${idPhoto}</div>
    ${possibleIdHtml}
    ${areasBlockHtml}
    ${factsHtml}
    ${leadInfoHtml}
    ${favoritesHtml}
    ${viewedHtml}
    ${shownHtml}
    ${scheduleApptHtml}
    ${scheduledHtml}
    ${pastHtml}
    ${coBuyersHtml}
    ${filtersHtml}
  `;

  // Click-to-edit name -- click the heading, it becomes a text input;
  // Enter or blur saves (Escape cancels without saving). Renders back to
  // plain text either way afterward.
  const nameHeading = container.querySelector(".buyer-name-editable");
  if (nameHeading) {
    const startEditingName = () => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "buyer-name-edit-input";
      input.value = nameHeading.dataset.personalName;
      nameHeading.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        const newName = input.value.trim();
        if (save && newName && newName !== nameHeading.dataset.personalName) {
          await saveBuyerName(nameHeading.dataset.phone, newName, () => renderBuyerDetail(findBuyer(nameHeading.dataset.phone)));
        } else {
          renderBuyerDetail(findBuyer(nameHeading.dataset.phone));
        }
      };
      input.addEventListener("blur", () => finish(true));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        if (e.key === "Escape") { e.preventDefault(); finish(false); }
      });
    };
    nameHeading.addEventListener("click", startEditingName);
    nameHeading.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startEditingName(); } });
  }

  // Click-to-edit areas -- click the fact row, its checkbox panel opens
  // inline; each checkbox saves immediately on change.
  const areasField = container.querySelector(".buyer-areas-editable");
  if (areasField) {
    areasField.addEventListener("click", (e) => {
      if (e.target.closest(".buyer-areas-checkbox")) return; // let the checkbox click do its own thing below
      areasField.querySelector(".buyer-areas-edit-panel").classList.toggle("hidden");
    });
    areasField.querySelectorAll(".buyer-areas-checkbox").forEach((cb) => {
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        const checked = [...areasField.querySelectorAll(".buyer-areas-checkbox:checked")].map((c) => c.value);
        saveBuyerAreas(areasField.dataset.phone, checked, () => renderBuyerDetail(findBuyer(areasField.dataset.phone)));
      });
    });
  }

  // Click-to-view/upload ID -- see openIdLightbox for the lightbox itself.
  const idClickTarget = container.querySelector(".buyer-id-photo-clickable, .buyer-no-id-clickable");
  if (idClickTarget) {
    idClickTarget.addEventListener("click", () => openIdLightbox(idClickTarget.dataset.phone, idClickTarget.dataset.dropboxLink || null));
  }

  // Sentiment/stage controls at the top of the page, added 2026-09-12 --
  // same handlers as the list card, but re-render THIS page afterward
  // (onDone), not the list underneath it.
  container.querySelectorAll(".sentiment-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const selected = btn.classList.contains("sentiment-btn-selected");
      setBuyerSentiment(btn.dataset.phone, selected ? "" : btn.dataset.sentiment, () => renderBuyerDetail(findBuyer(btn.dataset.phone)));
    });
  });
  container.querySelectorAll(".stage-select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      setBuyerStage(e.target.dataset.phone, e.target.value, () => renderBuyerDetail(findBuyer(e.target.dataset.phone)));
    });
  });

  // Fill in the placeholder <img> elements -- see idPhoto's own comment
  // above for why this can't just be a plain src= attribute.
  container.querySelectorAll(".admin-id-photo").forEach((img) => loadAdminIdPhoto(img, img.dataset.dropboxLink));
  initShownPropertyAutocomplete();
  initApptPropertyAutocomplete();

  const shownAddBtn = document.getElementById("shown-add-btn");
  if (shownAddBtn) shownAddBtn.addEventListener("click", () => {
    const input = document.getElementById("shown-property-input");
    const address = input.value.trim();
    if (!address) return;
    markShown(Number(shownAddBtn.dataset.row), address, "add", buyer.phone);
  });

  const apptScheduleBtn = document.getElementById("appt-schedule-btn");
  if (apptScheduleBtn) apptScheduleBtn.addEventListener("click", (e) => scheduleAppointment(e.target.dataset.phone));
  container.querySelectorAll(".shown-remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => markShown(Number(btn.dataset.row), btn.dataset.address, "remove", buyer.phone));
  });
}

// Calls the PRODUCTION admin worker (needs Sheets write) -- see
// handleMarkShown in admin/worker.js. Re-renders the buyer detail view
// from the refreshed buyer list on success, so the list stays the source
// of truth rather than hand-patching the DOM.
// Custom autocomplete dropdown for the Shown Properties input -- see that
// section's own comment for why this replaced a native <datalist>. Shows
// up to 8 matching addresses as the visitor types, click (or Enter on the
// first match) to select. No-op if the input isn't on the page (e.g. this
// buyer has no lm.row, so the add control never rendered).
const AUTOCOMPLETE_MAX_RESULTS = 8;
function initShownPropertyAutocomplete() {
  const input = document.getElementById("shown-property-input");
  const dropdown = document.getElementById("shown-property-suggestions");
  if (!input || !dropdown) return;

  function renderSuggestions(query) {
    const q = query.trim().toLowerCase();
    if (!q) { dropdown.classList.add("hidden"); dropdown.innerHTML = ""; return; }
    const matches = SHOWN_AVAILABLE_ADDRESSES.filter((a) => a.toLowerCase().includes(q)).slice(0, AUTOCOMPLETE_MAX_RESULTS);
    if (matches.length === 0) { dropdown.classList.add("hidden"); dropdown.innerHTML = ""; return; }
    dropdown.innerHTML = matches.map((a) => `<div class="autocomplete-option" data-address="${escapeAttr(a)}">${escapeHtml(a)}</div>`).join("");
    dropdown.classList.remove("hidden");
    dropdown.querySelectorAll(".autocomplete-option").forEach((opt) => {
      // mousedown, not click -- fires before the input's blur handler
      // below would otherwise hide the dropdown first and swallow the tap.
      opt.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = opt.dataset.address;
        dropdown.classList.add("hidden");
        dropdown.innerHTML = "";
      });
    });
  }

  input.addEventListener("input", () => renderSuggestions(input.value));
  input.addEventListener("focus", () => { if (input.value.trim()) renderSuggestions(input.value); });
  input.addEventListener("blur", () => { dropdown.classList.add("hidden"); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { dropdown.classList.add("hidden"); return; }
    if (e.key === "Enter") {
      const first = dropdown.querySelector(".autocomplete-option");
      if (first && !dropdown.classList.contains("hidden")) {
        e.preventDefault();
        input.value = first.dataset.address;
        dropdown.classList.add("hidden");
      }
    }
  });
}

// Same pattern as initShownPropertyAutocomplete above, against
// APPOINTMENT_AVAILABLE_ADDRESSES instead (every listing, not just
// not-yet-shown ones) -- added 2026-09-12 for the new Schedule a Showing
// control.
function initApptPropertyAutocomplete() {
  const input = document.getElementById("appt-property-input");
  const dropdown = document.getElementById("appt-property-suggestions");
  if (!input || !dropdown) return;

  function renderSuggestions(query) {
    const q = query.trim().toLowerCase();
    if (!q) { dropdown.classList.add("hidden"); dropdown.innerHTML = ""; return; }
    const matches = APPOINTMENT_AVAILABLE_ADDRESSES.filter((a) => a.toLowerCase().includes(q)).slice(0, AUTOCOMPLETE_MAX_RESULTS);
    if (matches.length === 0) { dropdown.classList.add("hidden"); dropdown.innerHTML = ""; return; }
    dropdown.innerHTML = matches.map((a) => `<div class="autocomplete-option" data-address="${escapeAttr(a)}">${escapeHtml(a)}</div>`).join("");
    dropdown.classList.remove("hidden");
    dropdown.querySelectorAll(".autocomplete-option").forEach((opt) => {
      opt.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = opt.dataset.address;
        dropdown.classList.add("hidden");
        dropdown.innerHTML = "";
      });
    });
  }

  input.addEventListener("input", () => renderSuggestions(input.value));
  input.addEventListener("focus", () => { if (input.value.trim()) renderSuggestions(input.value); });
  input.addEventListener("blur", () => { dropdown.classList.add("hidden"); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { dropdown.classList.add("hidden"); return; }
    if (e.key === "Enter") {
      const first = dropdown.querySelector(".autocomplete-option");
      if (first && !dropdown.classList.contains("hidden")) {
        e.preventDefault();
        input.value = first.dataset.address;
        dropdown.classList.add("hidden");
      }
    }
  });
}

// Quick-jump search at the top of the buyer detail page, added 2026-09-12
// per Aaron's direct request. initBuyersTab() (the sole caller) only runs
// once at page load, so this only needs to wire its listeners once too --
// BUYERS_CACHE is read fresh on every keystroke, not captured once, so this
// works correctly no matter which buyer you're currently viewing or how
// BUYERS_CACHE has changed since the page first loaded.
function initBuyerDetailSearch() {
  const input = document.getElementById("buyer-detail-search-input");
  const dropdown = document.getElementById("buyer-detail-search-suggestions");
  if (!input || !dropdown) return;

  function matchesFor(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (BUYERS_CACHE || [])
      .filter((b) => {
        const name = b.quoName || (b.leadInfo && b.leadInfo.contactName) || "";
        const email = (b.loginsMatch && b.loginsMatch.email) || "";
        return name.toLowerCase().includes(q) || b.phone.includes(q) || email.toLowerCase().includes(q);
      })
      .slice(0, AUTOCOMPLETE_MAX_RESULTS);
  }
  function renderSuggestions(query) {
    const matches = matchesFor(query);
    if (matches.length === 0) { dropdown.classList.add("hidden"); dropdown.innerHTML = ""; return; }
    dropdown.innerHTML = matches.map((b) => `
      <div class="autocomplete-option" data-phone="${escapeAttr(b.phone)}">
        ${escapeHtml(b.quoName || (b.leadInfo && b.leadInfo.contactName) || b.phone)}
        <span class="buyer-search-option-sub">${escapeHtml(b.phone)}</span>
      </div>
    `).join("");
    dropdown.classList.remove("hidden");
    dropdown.querySelectorAll(".autocomplete-option").forEach((opt) => {
      opt.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = "";
        dropdown.classList.add("hidden");
        dropdown.innerHTML = "";
        showBuyerDetail(opt.dataset.phone);
      });
    });
  }
  input.addEventListener("input", () => renderSuggestions(input.value));
  input.addEventListener("focus", () => { if (input.value.trim()) renderSuggestions(input.value); });
  input.addEventListener("blur", () => { dropdown.classList.add("hidden"); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { dropdown.classList.add("hidden"); return; }
    if (e.key === "Enter") {
      const first = dropdown.querySelector(".autocomplete-option");
      if (first && !dropdown.classList.contains("hidden")) {
        e.preventDefault();
        input.value = "";
        dropdown.classList.add("hidden");
        showBuyerDetail(first.dataset.phone);
      }
    }
  });
}

async function scheduleAppointment(phone) {
  const addressInput = document.getElementById("appt-property-input");
  const dateInput = document.getElementById("appt-date-input");
  const statusEl = document.getElementById("appt-schedule-status");
  const address = addressInput.value.trim();
  const date = dateInput.value;
  if (!address) { statusEl.textContent = "Type or pick an address first."; return; }
  if (!date) { statusEl.textContent = "Pick a date first."; return; }
  const buyer = findBuyer(phone);
  const fullName = buyer ? (buyer.quoName || (buyer.leadInfo && buyer.leadInfo.contactName) || "") : "";
  if (!confirm(`Schedule a showing at "${address}" on ${date}?`)) return;
  statusEl.textContent = "Scheduling…";
  const token = getStoredAdminToken();
  try {
    const res = await fetch(`${ADMIN_API_URL}/admin/add-appointment`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone, fullName, address, date }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) { statusEl.textContent = `Couldn't schedule: ${(data && data.error) || res.status}`; return; }
    statusEl.textContent = "Scheduled. (Shows up here and on the property card within ~15-20 min, once the background sync re-reads the Sheet.)";
    addressInput.value = "";
    dateInput.value = "";
  } catch (err) {
    statusEl.textContent = `Couldn't schedule: ${err}`;
  }
}

// onDone, added 2026-09-12 -- optional override for what to re-render
// after a successful change, since this is now also called from the
// Appointments overview (marking an appointment "shown" from there should
// re-render THAT list, not the buyer detail page underneath it). Defaults
// to the original buyer-detail-page behavior when omitted.
async function markShown(row, address, action, phone, onDone) {
  const token = getStoredAdminToken();
  try {
    const res = await fetch(`${ADMIN_API_URL}/mark-shown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ buyerRow: row, address, action }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) { alert(`Couldn't update shown properties: ${(data && data.error) || res.status}`); return; }
    await loadBuyers(); // refresh BUYERS_CACHE so the change is reflected
    if (onDone) { onDone(); return; }
    const refreshed = findBuyer(phone);
    if (refreshed) renderBuyerDetail(refreshed);
  } catch (err) {
    alert(`Couldn't update shown properties: ${err}`);
  }
}

// Admin equivalent of loadIdPhotoThumbnail (My Info tab) -- see idPhoto's
// own comment above for the real bug this fixes (a raw Dropbox link
// doesn't render via a plain <img src>). Same fetch+POST+blob-URL
// pattern, just against /admin-id-photo with Google OAuth instead of
// /id-photo's email gate.
async function loadAdminIdPhoto(imgEl, dropboxLink) {
  if (!dropboxLink) return;
  const token = getStoredAdminToken();
  try {
    const res = await fetch(`${ADMIN_API_URL}/admin-id-photo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ dropboxLink }),
    });
    if (!res.ok) return; // leave the <img> blank rather than break the page
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    imgEl.dataset.blobUrl = objectUrl;
    imgEl.src = objectUrl;
  } catch (e) {
    // network hiccup -- same "leave it blank" fallback
  }
}

// ---------- Buyer editing (name / areas / ID upload), added 2026-09-12 ----------
// Area labels resolve onto the same fused "<CITY>TB" tokens the server's
// own CANONICAL_AREAS regexes look for (parseAreasFromName, admin-buyers-
// worker.js) -- keep this map in sync with that list if either changes.
const AREA_TAG_TOKENS = {
  "IL - East St Louis": "ESTLTB",
  "MO - St. Louis": "STLTB",
  "AR - Little Rock": "LRTB",
  "AR - West Memphis": "WMTB",
  "IL - Springfield": "SPRINGFIELDTB",
};

// Strips any trailing area-tag tokens (and any bare "TB") from a Quo
// display name so the edit field shows just the person's actual name --
// the area checkboxes re-add the right tag(s) on save, so re-typing a name
// never means re-typing "WMTB" by hand too.
function stripAreaTagsFromName(name) {
  const tagTokens = new Set(Object.values(AREA_TAG_TOKENS).map((t) => t.toLowerCase()));
  const parts = (name || "").trim().split(/\s+/);
  while (parts.length && (tagTokens.has(parts[parts.length - 1].toLowerCase()) || /^tb$/i.test(parts[parts.length - 1]))) {
    parts.pop();
  }
  return parts.join(" ");
}

// Click-to-edit versions, added 2026-09-12 per Aaron's direct request to
// save page space -- replace the old standalone Edit section's combined
// Save button (saveBuyerNameAreas) and Upload button (uploadBuyerId).
// Name and Areas are now two SEPARATE triggers/writes (click the heading,
// click the Areas fact), so there's no more "also update Quo" checkbox to
// gate the name write -- clicking the name always means "rename this Quo
// contact," clicking Areas always means "set the area override," and
// neither touches the other anymore.
async function saveBuyerName(phone, fullName, onDone) {
  if (!confirm(`Rename this Quo contact to "${fullName}"?`)) { onDone(); return; }
  const token = getStoredAdminToken();
  try {
    const res = await fetch(`${ADMIN_API_URL}/admin/update-contact-name`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone, fullName }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) { alert(`Couldn't rename: ${(data && data.error) || res.status}`); onDone(); return; }
    const buyer = findBuyer(phone);
    if (buyer) buyer.quoName = fullName;
    onDone();
  } catch (err) {
    alert(`Couldn't rename: ${err}`);
    onDone();
  }
}

async function saveBuyerAreas(phone, areas, onDone) {
  const token = getStoredAdminToken();
  try {
    const res = await fetch(`${ADMIN_API_URL}/admin/set-areas`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone, fullName: "", areas }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) { alert(`Couldn't save areas: ${(data && data.error) || res.status}`); return; }
    const buyer = findBuyer(phone);
    if (buyer) buyer.areas = areas;
    onDone();
  } catch (err) {
    alert(`Couldn't save areas: ${err}`);
  }
}

// Fullscreen ID lightbox + upload, added 2026-09-12 per Aaron's direct
// request ("click on the ID photo to update ID or add id... or see it in
// full screen") -- one click target does both: view the current ID
// full-size (if there is one), or go straight to picking a replacement.
// Skips OCR entirely, same reasoning as the old upload button did -- the
// buyer is already known (that's which page this is), so the file gets
// named directly via /admin/upload-id.
function openIdLightbox(phone, dropboxLink) {
  const buyer = findBuyer(phone);
  const fullName = buyer ? (buyer.quoName || (buyer.leadInfo && buyer.leadInfo.contactName) || "") : "";
  const overlay = document.createElement("div");
  overlay.className = "id-lightbox-overlay";
  overlay.innerHTML = `
    <div class="id-lightbox-content">
      ${dropboxLink ? `<img class="id-lightbox-img admin-id-photo" data-dropbox-link="${escapeAttr(dropboxLink)}" alt="ID full size">` : `<p class="buyer-no-id">No ID on file yet.</p>`}
      <div class="id-lightbox-actions">
        <label class="btn-primary id-lightbox-upload-label">
          Upload new ID
          <input type="file" accept="image/*" class="id-lightbox-file-input hidden">
        </label>
        <button type="button" class="btn-outline id-lightbox-close">Close</button>
      </div>
      <div class="id-lightbox-status"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  if (dropboxLink) {
    const img = overlay.querySelector(".id-lightbox-img");
    loadAdminIdPhoto(img, dropboxLink);
  }
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".id-lightbox-close").addEventListener("click", close);
  overlay.querySelector(".id-lightbox-file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = overlay.querySelector(".id-lightbox-status");
    if (!confirm(`Upload this photo as ${fullName || phone}'s ID?`)) return;
    statusEl.textContent = "Uploading…";
    const token = getStoredAdminToken();
    try {
      const form = new FormData();
      form.set("phone", phone);
      form.set("fullName", fullName);
      form.set("idPhoto", file);
      const res = await fetch(`${ADMIN_API_URL}/admin/upload-id`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { statusEl.textContent = `Couldn't upload: ${(data && data.error) || res.status}`; return; }
      statusEl.textContent = "Uploaded and linked.";
      await loadBuyers();
      close();
      const refreshed = findBuyer(phone);
      if (refreshed) renderBuyerDetail(refreshed);
    } catch (err) {
      statusEl.textContent = `Couldn't upload: ${err}`;
    }
  });
}

async function loadBuyerMessages(phone) {
  const token = getStoredAdminToken();
  const el = document.getElementById("buyer-messages-list");
  el.innerHTML = "<p>Loading…</p>";
  try {
    const res = await fetch(`${BUYERS_API_URL}/buyer-messages?participant=${encodeURIComponent(phone)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!data.messages || data.messages.length === 0) { el.innerHTML = "<p>No messages found.</p>"; return; }
    // API returns newest-first; show oldest-first so it reads like a real
    // conversation thread, most recent message at the bottom. Each event is
    // either a text (`kind: "message"`, may carry `media` image URLs) or a
    // call (`kind: "call"`, may carry an `aiSummary` when Quo's plan has
    // one) -- added 2026-09-11 per Aaron's direct request to show calls in
    // the thread and surface the AI summary when available.
    el.innerHTML = [...data.messages].reverse().map((m) => {
      if (m.kind === "call") {
        const durationStr = typeof m.duration === "number" ? `${Math.floor(m.duration / 60)}:${String(m.duration % 60).padStart(2, "0")}` : "";
        return `
          <div class="buyer-message buyer-call ${m.direction === "incoming" ? "incoming" : "outgoing"}">
            <span class="buyer-call-label">📞 ${m.direction === "incoming" ? "Incoming call" : "Outgoing call"}${m.status ? ` — ${escapeHtml(m.status)}` : ""}${durationStr ? ` (${durationStr})` : ""}</span>
            ${m.aiSummary ? `<div class="buyer-call-summary"><strong>AI summary:</strong> ${escapeHtml(m.aiSummary)}</div>` : ""}
            <span class="buyer-message-date">${formatShortDate(m.createdAt)}</span>
          </div>`;
      }
      const mediaHtml = (m.media || []).map((url) => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener"><img src="${escapeAttr(url)}" class="buyer-message-image" alt="Attached image"></a>`).join("");
      return `
        <div class="buyer-message ${m.direction === "incoming" ? "incoming" : "outgoing"}">
          ${m.text ? `<span class="buyer-message-text">${escapeHtml(m.text)}</span>` : ""}
          ${mediaHtml}
          <span class="buyer-message-date">${formatShortDate(m.createdAt)}</span>
        </div>`;
    }).join("");
  } catch (err) {
    el.innerHTML = `<p>Couldn't load messages: ${err}</p>`;
  }
}

// Real Quo (OpenPhone) API has no "snippets"/canned-reply endpoint (checked
// directly, 2026-09-11 -- /v1/snippets doesn't exist), so this is our own
// simple saved-reply list, edited here rather than pulled from Quo. "{name}"
// is replaced with the buyer's first name (from their Quo contact name) when
// inserted, falling back to "there" if unknown.
const MESSAGE_SNIPPETS = [
  { label: "Following up", text: "Hi {name}, just following up on the home you were looking at — still interested? Happy to answer any questions." },
  { label: "Appointment reminder", text: "Hi {name}, quick reminder about your upcoming appointment to view the property. Let me know if anything changes!" },
  { label: "Send application link", text: "Hi {name}, here's the link to get started: instantapprovalhomes.com — let me know if you have trouble with anything." },
  { label: "No longer available", text: "Hi {name}, thanks for your interest — that property is no longer available, but I have similar ones if you'd like to see them." },
];

async function sendBuyerMessage(phone) {
  const token = getStoredAdminToken();
  const textEl = document.getElementById("buyer-compose-text");
  const statusEl = document.getElementById("buyer-send-status");
  const content = textEl.value.trim();
  if (!content) { statusEl.textContent = "Type a message first."; return; }

  const buyer = findBuyer(phone);
  const label = (buyer && (buyer.quoName || buyer.phone)) || phone;
  if (!confirm(`Send this text to ${label} (${phone})?\n\n"${content}"`)) return;

  statusEl.textContent = "Sending…";
  try {
    const res = await fetch(`${BUYERS_API_URL}/send-message`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: phone, content }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) { statusEl.textContent = `Failed: ${(data && (data.error || JSON.stringify(data.detail))) || "unknown error"}`; return; }
    statusEl.textContent = "Sent.";
    textEl.value = "";
    loadBuyerMessages(phone); // refresh the feed so the new message shows immediately
  } catch (err) {
    statusEl.textContent = `Failed: ${err}`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/`/g, "&#96;"); }

// Wired up once, on load -- sort dropdown, back button, the filter panel
// (added 2026-09-11), and the Dropbox-folder ID-match checker.
// Copy-to-clipboard for phone numbers/emails, added 2026-09-12 per Aaron's
// direct request -- "anywhere ... on the buyers page or the appointments
// page." Delegated (one listener, wired once here rather than re-wired on
// every render) so it survives renderBuyersList()/renderAppointmentsOverview()
// re-rendering their containers constantly -- matches copyableTextHtml's
// own markup wherever it's used across both tabs.
function copyableTextHtml(value) {
  if (!value) return "";
  return `<span class="copyable-text" data-copy-value="${escapeAttr(value)}" title="Click to copy">${escapeHtml(value)}</span>`;
}
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // Fallback for a browser/webview with no Clipboard API (or one that
    // refuses it outside a fully-trusted context) -- same old-school
    // textarea+execCommand trick, good enough as a last resort.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch (e2) {
      return false;
    }
  }
}
function initCopyableTextDelegation() {
  // Capture phase (the `true` third arg), NOT the default bubble phase --
  // real bug caught before ever shipping this: a copyable-text span
  // usually sits INSIDE a clickable buyer-row/appt-card, whose own
  // click-to-navigate listener is attached directly to that card element.
  // In the bubble phase, the card's OWN listener fires first (bubbling
  // goes target -> ... -> document, so document is always LAST), so
  // calling stopPropagation() there is too late -- navigation would have
  // already happened. Listening on document in the CAPTURE phase runs
  // before the event ever reaches the card, so stopPropagation() there
  // genuinely prevents the card's own handler from ever seeing the click.
  document.addEventListener("click", async (e) => {
    const el = e.target.closest(".copyable-text");
    if (!el) return;
    e.stopPropagation();
    const ok = await copyTextToClipboard(el.dataset.copyValue);
    const original = el.textContent;
    el.textContent = ok ? "Copied!" : "Couldn't copy";
    setTimeout(() => { el.textContent = original; }, 1200);
  }, true);
}

function initBuyersTab() {
  initCopyableTextDelegation();
  initBuyerDetailSearch();
  const sortSel = document.getElementById("buyers-sort");
  if (sortSel) sortSel.addEventListener("change", () => { BUYERS_SORT = sortSel.value; BUYERS_SORT_DIR = 1; renderBuyersList(); });
  const sortDirBtn = document.getElementById("buyers-sort-dir-toggle");
  if (sortDirBtn) sortDirBtn.addEventListener("click", () => { BUYERS_SORT_DIR *= -1; renderBuyersList(); });
  const backBtn = document.getElementById("buyers-back-btn");
  if (backBtn) backBtn.addEventListener("click", backToBuyersList);

  // Search box + filter/sort toggle buttons -- mirrors the homes page's
  // own search-row wiring (filter-toggle/sort-toggle, mutually exclusive
  // panels) exactly, added 2026-09-11 per Aaron's direct request for
  // layout consistency with the homes search.
  const searchBox = document.getElementById("buyers-search-box");
  if (searchBox) searchBox.addEventListener("input", () => {
    BUYERS_SEARCH = searchBox.value.trim().toLowerCase();
    renderBuyersList();
  });
  const filterToggle = document.getElementById("buyers-filter-toggle");
  const sortToggle = document.getElementById("buyers-sort-toggle");
  const filterPanel = document.getElementById("buyers-filter-panel");
  const sortPanel = document.getElementById("buyers-sort-panel");
  if (filterToggle && filterPanel && sortPanel) filterToggle.addEventListener("click", () => {
    sortPanel.classList.add("hidden");
    filterPanel.classList.toggle("hidden");
  });
  if (sortToggle && filterPanel && sortPanel) sortToggle.addEventListener("click", () => {
    filterPanel.classList.add("hidden");
    sortPanel.classList.toggle("hidden");
  });

  // renderBuyersAreaCheckboxes() is deliberately NOT called here -- see the
  // comment at its call site in loadBuyers() for why calling it eagerly at
  // page-load time (this function runs before this section's own consts
  // are initialized) is what broke the whole page on 2026-09-11.
  ["bf-down", "bf-monthly", "bf-beds", "bf-id", "bf-favorites", "bf-loggedin", "bf-contact-op", "bf-contact-period", "bf-sentiment"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", applyBuyersFilters);
  });
  const clearBtn = document.getElementById("buyers-filter-clear");
  if (clearBtn) clearBtn.addEventListener("click", clearBuyersFilters);

  // "Check for ID photo matches" / "Rename ID files in Dropbox" button
  // wiring removed 2026-09-12 -- see the removal comment in index.html for
  // why (superseded by id-photo-watch.ts's automated OCR matching).

  // updateDateModeToggleLabel() is deliberately NOT called here -- this
  // function runs at page-load time, before BUYERS_DATE_MODE (declared
  // further down, since this whole section is appended after the main
  // init sequence) has initialized. Same TDZ shape as the
  // renderBuyersAreaCheckboxes() bug fixed earlier -- caught this time by
  // the same jsdom check before ever deploying it. The label gets set
  // from renderBuyersList() instead, which -- like every other buyers-tab
  // entry point -- only ever runs lazily, well after the whole script has
  // finished executing once.
  // Shared BUYERS_DATE_MODE toggle -- both this button (buyers list) and
  // the Appointments tab's own button (added 2026-09-12) flip the SAME
  // state and re-render BOTH views, so whichever one you're not currently
  // looking at is still correct the next time you switch to it, and the
  // two never drift out of sync with each other.
  function toggleDateMode() {
    BUYERS_DATE_MODE = BUYERS_DATE_MODE === "days" ? "date" : "days";
    try { localStorage.setItem(BUYERS_DATE_MODE_STORAGE_KEY, BUYERS_DATE_MODE); } catch (e) {}
    renderBuyersList();
    renderAppointmentsOverview();
  }
  const dateModeBtn = document.getElementById("buyers-date-mode-toggle");
  if (dateModeBtn) dateModeBtn.addEventListener("click", toggleDateMode);
  const apptDateModeBtn = document.getElementById("appointments-date-mode-toggle");
  if (apptDateModeBtn) apptDateModeBtn.addEventListener("click", toggleDateMode);

  // Compact/Detailed card toggle, added 2026-09-13 per Aaron's direct
  // request -- same persisted-toggle pattern as toggleDateMode above.
  const cardModeBtn = document.getElementById("buyers-card-mode-toggle");
  if (cardModeBtn) cardModeBtn.addEventListener("click", () => {
    BUYERS_CARD_MODE = BUYERS_CARD_MODE === "compact" ? "detailed" : "compact";
    try { localStorage.setItem(BUYERS_CARD_MODE_STORAGE_KEY, BUYERS_CARD_MODE); } catch (e) {}
    renderBuyersList();
  });
}

function updateDateModeToggleLabel(btn) {
  btn.textContent = BUYERS_DATE_MODE === "days" ? "Show dates" : "Show days since";
}

function updateCardModeToggleLabel(btn) {
  btn.textContent = BUYERS_CARD_MODE === "compact" ? "Detailed view" : "Compact view";
}

// ---------- Suggested ID matches (Dropbox "Buyer IDs" folder), added 2026-09-11 ----------
// Calls the PRODUCTION admin worker (ADMIN_API_URL), not BUYERS_API_URL --
// this needs real Dropbox + Sheets WRITE access (to file a confirmed match
// as the buyer's ID Link), which the standalone buyers Worker deliberately
// doesn't have. See handleSuggestedIdMatches/handleConfirmIdMatch in
// admin/worker.js for why this never auto-files anything on its own.
async function loadSuggestedIdMatches() {
  const token = getStoredAdminToken();
  const panel = document.getElementById("buyers-id-matches-panel");
  panel.classList.remove("hidden");
  panel.innerHTML = "<p>Checking the ID folder…</p>";
  try {
    const res = await fetch(`${ADMIN_API_URL}/suggested-id-matches`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok || data.error) { panel.innerHTML = `<p>Couldn't check for matches: ${data.error || res.status}${data.detail ? ` — ${escapeHtml(data.detail)}` : ""}</p>`; return; }
    if (!data.matches || data.matches.length === 0) {
      panel.innerHTML = `<p>No new matches found (scanned ${data.filesScanned} file(s) in the ID folder against ${data.buyersNeedingId} buyer(s) with no ID on file).</p>`;
      return;
    }
    panel.innerHTML = `
      <p>${data.matches.length} possible match(es) found -- review each before confirming:</p>
      ${data.matches.map((m, i) => `
        <div class="id-match-row">
          <span>File "${escapeHtml(m.filename)}" looks like <strong>${escapeHtml(m.buyerName)}</strong> (${escapeHtml(m.buyerPhone)})</span>
          <button class="btn-primary id-match-confirm-btn" data-index="${i}">Confirm &amp; link</button>
        </div>
      `).join("")}
    `;
    panel.querySelectorAll(".id-match-confirm-btn").forEach((btn) => {
      btn.addEventListener("click", () => confirmIdMatch(data.matches[Number(btn.dataset.index)], btn));
    });
  } catch (err) {
    panel.innerHTML = `<p>Couldn't check for matches: ${err}</p>`;
  }
}

async function confirmIdMatch(match, btn) {
  const token = getStoredAdminToken();
  btn.disabled = true;
  btn.textContent = "Linking…";
  try {
    const res = await fetch(`${ADMIN_API_URL}/confirm-id-match`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ dropboxPath: match.dropboxPath, buyerPhone: match.buyerPhone, buyerName: match.buyerName }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) { btn.textContent = `Failed: ${(data && data.error) || "unknown error"}`; return; }
    btn.closest(".id-match-row").innerHTML = `<span>✅ Linked to ${escapeHtml(match.buyerName)}.</span>`;
    loadBuyers(); // refresh so the buyer's ID-on-file state is current if reopened
  } catch (err) {
    btn.textContent = `Failed: ${err}`;
  }
}

// "Rename ID files in Dropbox," added 2026-09-11 per Aaron's direct
// request -- normalizes manually-dropped files onto the standard naming
// convention. Scoped server-side to ONLY files matched to a buyer with no
// ID Link yet (see handleRenameIdFiles's own comment) -- an already-linked
// file is never touched, so this can't break an existing shared link. A
// real, if scoped-conservatively, bulk write -- confirm before firing.
async function renameIdFiles() {
  if (!confirm("Rename ID files in the Dropbox folder to match buyers' names? Only files not yet linked to a buyer are touched.")) return;
  const token = getStoredAdminToken();
  const panel = document.getElementById("buyers-id-matches-panel");
  panel.classList.remove("hidden");
  panel.innerHTML = "<p>Renaming…</p>";
  try {
    const res = await fetch(`${ADMIN_API_URL}/rename-id-files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok || data.error) { panel.innerHTML = `<p>Couldn't rename files: ${data.error || res.status}${data.detail ? ` — ${escapeHtml(data.detail)}` : ""}</p>`; return; }
    const parts = [];
    if (data.renamed.length) parts.push(`<p><strong>Renamed ${data.renamed.length}:</strong></p>` + data.renamed.map((r) => `<div class="buyer-list-item">${escapeHtml(r.from)} → ${escapeHtml(r.to)}</div>`).join(""));
    if (data.skipped.length) parts.push(`<p>${data.skipped.length} already matched the convention.</p>`);
    if (data.errors.length) parts.push(`<p><strong>${data.errors.length} failed:</strong></p>` + data.errors.map((e) => `<div class="buyer-list-item">${escapeHtml(e.filename)}: ${escapeHtml(e.detail)}</div>`).join(""));
    panel.innerHTML = parts.join("") || "<p>Nothing to rename.</p>";
  } catch (err) {
    panel.innerHTML = `<p>Couldn't rename files: ${err}</p>`;
  }
}

// ---------- Upcoming Appointments (all buyers, one page) -- added 2026-09-11 ----------
// Deliberately reuses data ALREADY fetched by the existing, live
// refreshAdminActivity() (ADMIN_APPOINTMENTS_BY_ADDRESS, grouped by
// property address) -- no new Worker, no new endpoint, this is purely a
// different rendering of data the site already pulls for the admin
// favorite/appointment badges. Flattens the by-address grouping into one
// list sorted by date, filtered to today-or-later (same "only show
// upcoming" rule already used for those badges).
// Builds one appt-card's HTML. `showMarkShown` controls whether the
// "Mark as shown" checkbox renders -- only on the Upcoming list, added
// 2026-09-12 per Aaron's direct request: clicking it marks that showing
// done (adds the address to the buyer's own Shown Properties, the SAME
// write the buyer-detail page's own "Mark shown" button already makes --
// no new endpoint), which is also what moves the card down into Past
// below on the next render, no separate "done" flag needed anywhere.
function renderApptCard(a, showMarkShown) {
  const clickable = !!a.phone;
  return `
    <div class="appt-card${clickable ? " appt-card-clickable" : ""}"${clickable ? ` data-phone="${escapeAttr(a.phone)}" role="button" tabindex="0"` : ""}>
      ${a.idLink ? `<img class="appt-card-thumb admin-id-photo" data-dropbox-link="${escapeAttr(a.idLink)}" alt="ID on file">` : `<div class="appt-card-thumb appt-card-no-id">No ID</div>`}
      <div class="appt-card-info">
        <div class="appt-card-date">${escapeHtml(formatApptDate(a.date))}</div>
        <div class="appt-card-address">${escapeHtml(a.address)}</div>
        <div class="appt-card-visitor">${escapeHtml(a.name || a.email || a.phone || "Unknown visitor")}</div>
        ${a.phone ? `<div class="appt-card-contact">${copyableTextHtml(a.phone)}${a.email ? " · " + copyableTextHtml(a.email) : ""}</div>` : ""}
        ${showMarkShown && a.row ? `
          <label class="appt-mark-shown-label">
            <input type="checkbox" class="appt-mark-shown-checkbox" data-row="${a.row}" data-address="${escapeAttr(a.address)}" data-phone="${escapeAttr(a.phone)}">
            Mark as shown
          </label>` : ""}
      </div>
    </div>
  `;
}

function renderAppointmentsOverview() {
  const container = document.getElementById("appointments-list");
  const pastContainer = document.getElementById("appointments-past-list");
  const pastHeading = document.getElementById("appointments-past-heading");
  if (!container) return;
  const apptDateModeBtn = document.getElementById("appointments-date-mode-toggle");
  if (apptDateModeBtn) updateDateModeToggleLabel(apptDateModeBtn);
  const today = localTodayISO(); // already defined in app.js

  const upcoming = [];
  const past = [];
  for (const [address, appts] of Object.entries(ADMIN_ALL_APPOINTMENTS_BY_ADDRESS || {})) {
    for (const a of appts) {
      const buyer = a.phone ? findBuyer(a.phone) : null;
      const row = buyer && buyer.loginsMatch ? buyer.loginsMatch.row : null;
      const alreadyShown = !!(buyer && buyer.loginsMatch && buyer.loginsMatch.shown && buyer.loginsMatch.shown.includes(address));
      const entry = { address, ...a, row };
      if (a.date < today || alreadyShown) past.push(entry);
      else upcoming.push(entry);
    }
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  past.sort((a, b) => b.date.localeCompare(a.date)); // most-recently-past first

  container.innerHTML = upcoming.length
    ? upcoming.map((a) => renderApptCard(a, true)).join("")
    : "<p>No upcoming appointments.</p>";
  if (pastContainer) {
    pastHeading.classList.toggle("hidden", past.length === 0);
    pastContainer.innerHTML = past.map((a) => renderApptCard(a, false)).join("");
  }

  const both = [container, pastContainer].filter(Boolean);
  for (const c of both) {
    // Same blob-fetch as everywhere else an admin-id-photo placeholder
    // appears -- a raw Dropbox share link can't go straight into <img src>.
    c.querySelectorAll(".admin-id-photo").forEach((img) => loadAdminIdPhoto(img, img.dataset.dropboxLink));
    c.querySelectorAll(".appt-card-clickable").forEach((el) => {
      // stopPropagation on the checkbox's own label below keeps a
      // "Mark as shown" tap from ALSO navigating to the buyer's page.
      el.addEventListener("click", () => goToBuyerFromAppointment(el.dataset.phone));
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goToBuyerFromAppointment(el.dataset.phone); } });
    });
    c.querySelectorAll(".appt-mark-shown-label").forEach((label) => {
      label.addEventListener("click", (e) => e.stopPropagation());
    });
    c.querySelectorAll(".appt-mark-shown-checkbox").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (!cb.checked) return; // one-way -- unchecking doesn't un-mark, same as the buyer-page Remove button being the only way back
        markShown(Number(cb.dataset.row), cb.dataset.address, "add", cb.dataset.phone, renderAppointmentsOverview);
      });
    });
  }
}

// Jumps from an appointment card straight to that buyer's own page --
// added 2026-09-12 per Aaron's direct request. Switches to the Buyers tab
// first (loading the list if it hasn't been already) so
// showBuyerDetail/findBuyer have BUYERS_CACHE to look the phone up in.
async function goToBuyerFromAppointment(phone) {
  activateTab("buyers");
  if (!BUYERS_CACHE) await loadBuyers();
  const buyer = findBuyer(phone);
  if (!buyer) { alert("Couldn't find this buyer's own card (they may not have a matching Quo contact or BUYERS-tab lead)."); return; }
  showBuyerDetail(phone);
}

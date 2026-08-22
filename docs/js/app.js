// Instant-Approval Home Financing -- front end
// Reads docs/data/properties.json (regenerated automatically whenever the
// source Sheet changes -- see scripts/generate_properties.py). No login,
// no cookies, no tracking.

// TODO(kickoff): fill in Aaron's existing Google Cloud API key here. It must
// have Street View Static API, Maps JavaScript API, and Geocoding API
// enabled, and this site's domain added to its HTTP referrer restrictions.
// This is a publishable/browser key by design (restricted by referrer, not
// a secret) -- same as any public site embedding Google Maps.
const GOOGLE_MAPS_API_KEY = "";

const AARON_PHONE = "6184184180"; // digits only, for sms:/tel: links

// TODO(kickoff): once the small serverless backend is deployed, point this
// at its real URL (e.g. https://<worker>.<account>.workers.dev/buyer-info).
const BUYER_INFO_ENDPOINT = "";

let ALL_LISTINGS = [];
let GENERATED_AT = null;
let filterState = { status: "Available", sort: "recent", down: null, monthly: null, beds: null, area: "" };

// ---------- data load ----------
async function loadData() {
  const res = await fetch("data/properties.json", { cache: "no-store" });
  const data = await res.json();
  ALL_LISTINGS = data.listings;
  GENERATED_AT = data.generatedAt;
  restoreFilterStateFromUrl();
  renderFreshness();
  renderStatsStrip();
  renderCardGrid();
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
  if (filterState.area && !(listing.area || "").toLowerCase().includes(filterState.area.toLowerCase())) return false;
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
      <div class="card-money">${escapeHtml(listing.down)} down &middot; ${escapeHtml(listing.monthly)} a month</div>
    `;
    card.appendChild(body);
    grid.appendChild(card);
  }
}

function streetViewUrl(address, w, h) {
  if (!GOOGLE_MAPS_API_KEY) return "assets/placeholder-streetview.png";
  return `https://maps.googleapis.com/maps/api/streetview?size=${w}x${h}&location=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
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
  document.getElementById("view-list").classList.add("hidden");
  document.getElementById("view-map").classList.add("hidden");
  const detail = document.getElementById("view-detail");
  detail.classList.remove("hidden");
  window.location.hash = `listing/${id}`;

  const availableOnly = listing.status === "Available";
  const inquireBtn = availableOnly
    ? `<a class="btn-primary" href="${inquireLink(listing)}">💬 Inquire</a>` : "";
  // Fixed 2026-08-21: this used to be a <button onclick="window.location.href=...">,
  // inconsistent with Inquire/Share (both plain <a href>) -- Aaron flagged it as
  // "didn't work like the others did." Same <a> pattern now, all three.
  const photoBtn = availableOnly
    ? `<a class="btn-outline btn-full" href="${photoNotWorkingLink(listing)}">📷 Photo link not working?</a>` : "";
  // Livability deliberately NOT shown here -- per Aaron's 2026-08-21 request,
  // it stays on the card only, not on the detail/properties page.

  detail.innerHTML = `
    <button class="detail-back" onclick="backToList()">←</button>
    <img class="detail-photo" src="${streetViewUrl(listing.address, 800, 500)}" alt="${escapeHtml(listing.address)}">
    <div class="detail-body">
      <div class="detail-status">${escapeHtml(listing.status)}</div>
      <div class="detail-address">${escapeHtml(listing.address)}</div>
      <div class="action-row">
        ${inquireBtn}
        <a class="btn-outline" href="${shareLink(listing)}">🔗 Share</a>
      </div>
      <a class="btn-outline btn-full" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(listing.address)}" target="_blank" rel="noopener">🚗 Get Directions</a>
      <div class="detail-field"><span>First Available</span><span class="value">${escapeHtml(listing.onMarketDate)}</span></div>
      <div class="detail-field"><span>Photo Link</span><span class="value"><a href="${escapeHtml(listing.picsLink)}" target="_blank" rel="noopener">${escapeHtml(listing.picsLink)}</a></span></div>
      ${photoBtn}
      <div class="detail-field"><span>Down Payment</span><span class="value">${escapeHtml(listing.down)}</span></div>
      <div class="detail-field"><span>Monthly Payment</span><span class="value">${escapeHtml(listing.monthly)}</span></div>
      <div class="detail-field"><span>Beds</span><span class="value">${escapeHtml(listing.beds)}</span></div>
      <div class="detail-field"><span>Baths</span><span class="value">${escapeHtml(listing.baths)}</span></div>
      <div class="detail-field"><span>Sq Ft</span><span class="value">${escapeHtml(listing.sqft)}</span></div>
      <div class="detail-field"><span>Last Updated</span><span class="value">${escapeHtml(listing.lastUpdate)}</span></div>
    </div>
  `;
}

function backToList() {
  document.getElementById("view-detail").classList.add("hidden");
  document.getElementById("view-list").classList.remove("hidden");
  history.replaceState(null, "", window.location.pathname);
}

// ---------- map (Available-only, always, regardless of the list filter) ----------
let mapInstance = null;
let mapsScriptLoading = null;

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

async function showMap() {
  document.getElementById("view-list").classList.add("hidden");
  document.getElementById("view-detail").classList.add("hidden");
  const mapView = document.getElementById("view-map");
  mapView.classList.remove("hidden");
  const canvas = document.getElementById("map-canvas");

  // Hard rule from the approved plan: the map ALWAYS shows Available only,
  // independent of whatever the Properties list filter is currently set to.
  const availableWithCoords = ALL_LISTINGS.filter(
    (l) => l.status === "Available" && l.lat != null && l.lng != null
  );

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
  }
  const bounds = new google.maps.LatLngBounds();
  for (const listing of availableWithCoords) {
    const pos = { lat: listing.lat, lng: listing.lng };
    const marker = new google.maps.Marker({ position: pos, map: mapInstance, title: listing.address });
    marker.addListener("click", () => showDetail(listing.id));
    bounds.extend(pos);
  }
  if (availableWithCoords.length > 0) mapInstance.fitBounds(bounds);
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
  properties: "PROPERTIES", approved: "APPROVED!", steps: "5 EASY STEPS",
  buyer: "BUYER INFO", faq: "FAQ",
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
  document.getElementById("f-area").value = filterState.area || "";
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
    area: params.get("area") || "",
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
  if (filterState.area) params.set("area", filterState.area);
  const q = document.getElementById("search-box").value.trim();
  if (q) params.set("q", q);
  const qs = params.toString();
  const url = `${window.location.origin}${window.location.pathname}${qs ? "?" + qs : ""}`;
  const btn = document.getElementById("copy-link-btn");
  const done = () => {
    const original = btn.textContent;
    btn.textContent = "✅ Link copied!";
    setTimeout(() => { btn.textContent = original; }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => window.prompt("Copy this link:", url));
  } else {
    window.prompt("Copy this link:", url);
  }
}

// ---------- wiring ----------
document.getElementById("filter-toggle").addEventListener("click", () => {
  document.getElementById("filter-panel").classList.toggle("hidden");
});
document.getElementById("filter-apply").addEventListener("click", () => {
  filterState = {
    status: document.getElementById("f-status").value,
    sort: document.getElementById("f-sort").value,
    down: parseFloat(document.getElementById("f-down").value) || null,
    monthly: parseFloat(document.getElementById("f-monthly").value) || null,
    beds: parseInt(document.getElementById("f-beds").value, 10) || null,
    area: document.getElementById("f-area").value,
  };
  document.getElementById("filter-panel").classList.add("hidden");
  renderCardGrid();
});
document.getElementById("copy-link-btn").addEventListener("click", copyResultsLink);
document.getElementById("search-box").addEventListener("input", renderCardGrid);
document.getElementById("show-map-btn").addEventListener("click", showMap);
document.getElementById("map-back-btn").addEventListener("click", () => {
  document.getElementById("view-map").classList.add("hidden");
  document.getElementById("view-list").classList.remove("hidden");
});

initNav();
initDrawer();
initStepTabs();
initBuyerForm();
loadData();

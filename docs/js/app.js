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
let filterState = { status: "Available", down: null, monthly: null, beds: null, area: "" };

// ---------- data load ----------
async function loadData() {
  const res = await fetch("data/properties.json", { cache: "no-store" });
  const data = await res.json();
  ALL_LISTINGS = data.listings;
  GENERATED_AT = data.generatedAt;
  renderFreshness();
  renderCardGrid();
}

function renderFreshness() {
  const el = document.getElementById("freshness");
  if (!GENERATED_AT) return;
  const d = new Date(GENERATED_AT);
  el.textContent = `Data last refreshed: ${d.toLocaleString()}`;
}

// ---------- filtering ----------
function matchesFilters(listing) {
  if (filterState.status !== "Any" && listing.status !== filterState.status) return false;
  const down = parseMoney(listing.down);
  const monthly = parseMoney(listing.monthly);
  if (filterState.down && down !== null && down > filterState.down) return false;
  if (filterState.monthly && monthly !== null && monthly > filterState.monthly) return false;
  if (filterState.beds && (parseInt(listing.beds, 10) || 0) < filterState.beds) return false;
  if (filterState.area && !listing.address.toLowerCase().includes(filterState.area.toLowerCase())) return false;
  const q = document.getElementById("search-box").value.trim().toLowerCase();
  if (q && !listing.address.toLowerCase().includes(q)) return false;
  return true;
}

function parseMoney(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

// ---------- card grid ----------
function renderCardGrid() {
  const grid = document.getElementById("card-grid");
  const empty = document.getElementById("empty-state");
  const filtered = ALL_LISTINGS.filter(matchesFilters);
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
    const livabilitySuffix = listing.livability !== null ? ` (${listing.livability})` : " ()";
    body.innerHTML = `
      <div class="card-status ${listing.status.toLowerCase()}">${listing.status.toUpperCase()} - ${escapeHtml(listing.onMarketDate)}${escapeHtml(livabilitySuffix)}</div>
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
  const photoBtn = availableOnly
    ? `<button class="btn-outline btn-full" onclick="window.location.href='${photoNotWorkingLink(listing)}'">📷 Photo link not working?</button>` : "";
  const livabilityRow = listing.livability !== null
    ? `<div class="detail-field"><span>Livability</span><span class="value">${listing.livability}</span></div>` : "";

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
      ${livabilityRow}
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
function initNav() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");
      if (btn.dataset.tab === "properties") backToList();
    });
  });
}

// ---------- wiring ----------
document.getElementById("filter-toggle").addEventListener("click", () => {
  document.getElementById("filter-panel").classList.toggle("hidden");
});
document.getElementById("filter-apply").addEventListener("click", () => {
  filterState = {
    status: document.getElementById("f-status").value,
    down: parseFloat(document.getElementById("f-down").value) || null,
    monthly: parseFloat(document.getElementById("f-monthly").value) || null,
    beds: parseInt(document.getElementById("f-beds").value, 10) || null,
    area: document.getElementById("f-area").value,
  };
  document.getElementById("filter-panel").classList.add("hidden");
  renderCardGrid();
});
document.getElementById("search-box").addEventListener("input", renderCardGrid);
document.getElementById("show-map-btn").addEventListener("click", showMap);
document.getElementById("map-back-btn").addEventListener("click", () => {
  document.getElementById("view-map").classList.add("hidden");
  document.getElementById("view-list").classList.remove("hidden");
});

initNav();
initStepTabs();
initBuyerForm();
loadData();

/**
 * Direct-bus departure planner for Singapore.
 *
 * Origin and destination are both free-form, so routing cannot be precomputed:
 * the busrouter datasets (~133 KB gzipped, cached 24h upstream) are loaded once
 * and every query is planned in the browser via src/lib/plan.js -- the same code
 * the CLI uses.
 *
 * Two clocks: arrivals refetch every 15s (matching arrivelah2's own cache) while
 * the board repaints every second from the stored payload, so countdowns tick
 * without extra requests.
 */

import { parseArrivals, arrivelahUrl } from './src/lib/arrivals.js';
import { rankOptions } from './src/lib/rank.js';
import { loadNetwork } from './src/lib/data.js';
import { planDirect, legsFromDirect } from './src/lib/plan.js';
import { suggest, nearestStops, currentPosition } from './src/lib/places.js';
import { ORIGIN, DESTINATIONS, WALK_PENALTY_MINUTES } from './src/lib/config.js';

const POLL_MS = 15_000;
const RETRY_MS = 3_000;
const TICK_MS = 1_000;
const STALE_MS = 45_000;
const TYPE_DEBOUNCE_MS = 260;

/**
 * Boarding stops polled per refresh. A generous walk budget can surface a dozen
 * candidate stops, and arrivelah2 is an unpaid courtesy service -- polling all
 * of them every 15s would be inconsiderate. The best options are kept.
 */
const MAX_LEGS = 6;

const STORE_KEY = 'sgbus.route.v1';

const el = (id) => document.getElementById(id);
const ui = {
  from: el('from'), to: el('to'),
  fromSuggest: el('from-suggest'), toSuggest: el('to-suggest'),
  fromNote: el('from-note'), toNote: el('to-note'),
  gps: el('gps'), presets: el('presets'),
  walk: el('walk'), walkOut: el('walk-out'),
  netState: el('net-state'),
  hero: el('hero-body'), heroHint: el('hero-hint'),
  options: el('options'), boardHint: el('board-hint'), status: el('status'),
  banner: el('banner'), bannerText: el('banner-text'),
  clock: el('clock'), updated: el('updated'), countdown: el('countdown'),
  live: el('chip-live'), freshness: el('freshness'),
};

let net = null;
let from = null;
let to = null;
let walkBudget = Number(ui.walk.value);
let legs = [];
let plan = null;
let lastRaw = {};
let lastFetchAt = null;
let nextFetchAt = null;
let pollTimer = null;
let inflight = null;
let typeTimer = null;
let failing = false;

const pad = (n) => String(n).padStart(2, '0');
const etaText = (m) => (m <= 0 ? 'now' : String(m));
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- persistence ---------- */

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ from, to, walkBudget }));
  } catch { /* private browsing, or storage disabled */ }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ---------- search fields ---------- */

function closeSuggest(listEl) {
  listEl.hidden = true;
  listEl.replaceChildren();
}

function renderSuggest(listEl, items, onPick) {
  listEl.replaceChildren();
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 's-empty';
    li.textContent = 'No match. Try a postal code, building or stop name.';
    listEl.append(li);
    listEl.hidden = false;
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.innerHTML =
      `<span class="s-kind">${item.source === 'stop' ? 'stop' : 'place'}</span>` +
      `<span class="s-name">${esc(item.name)}</span>` +
      `<span class="s-detail">${esc(item.detail ?? '')}</span>`;
    li.addEventListener('click', () => onPick(item));
    listEl.append(li);
  }
  listEl.hidden = false;
}

function setEndpoint(role, place, { note } = {}) {
  const target = { name: place.name, lat: place.lat, lng: place.lng };
  if (role === 'from') {
    from = target;
    ui.from.value = place.name;
    ui.fromNote.className = 'field-note is-set';
    ui.fromNote.textContent = note ?? `Set · ${place.detail ?? ''}`.trim();
    closeSuggest(ui.fromSuggest);
  } else {
    to = target;
    ui.to.value = place.name;
    ui.toNote.className = 'field-note is-set';
    ui.toNote.textContent = note ?? `Set · ${place.detail ?? ''}`.trim();
    closeSuggest(ui.toSuggest);
  }
  save();
  replan();
}

function wireField(role, input, listEl) {
  input.addEventListener('input', () => {
    clearTimeout(typeTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      closeSuggest(listEl);
      return;
    }
    typeTimer = setTimeout(async () => {
      if (!net) return;
      const items = await suggest(net.stops, q);
      renderSuggest(listEl, items, (item) => setEndpoint(role, item));
    }, TYPE_DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeSuggest(listEl);
  });

  // Close when focus leaves the field, but after a click on an option lands.
  input.addEventListener('blur', () => setTimeout(() => closeSuggest(listEl), 160));
}

/* ---------- planning ---------- */

/** Trim to the boarding stops carrying the best options, to bound polling. */
function limitLegs(direct) {
  const order = [];
  for (const opt of direct) {
    if (!order.includes(opt.boardStop)) order.push(opt.boardStop);
  }
  const allowed = new Set(order.slice(0, MAX_LEGS));
  return legsFromDirect(direct.filter((o) => allowed.has(o.boardStop)));
}

function replan() {
  if (!net || !from || !to) return;

  plan = planDirect({
    stops: net.stops,
    services: net.services,
    originAnchors: [{ name: from.name, lat: from.lat, lng: from.lng }],
    destAnchors: [{ name: to.name, lat: to.lat, lng: to.lng }],
    originWalkMin: walkBudget,
    destWalkMin: 10,
    penalties: WALK_PENALTY_MINUTES,
  });

  legs = limitLegs(plan.direct);
  lastRaw = {};
  lastFetchAt = null;

  ui.heroHint.textContent = `${from.name} → ${to.name}`;

  if (legs.length === 0) {
    ui.hero.innerHTML =
      `<p class="hero-empty">No direct bus from <b>${esc(from.name)}</b> to <b>${esc(to.name)}</b>` +
      ` within a ${walkBudget} min walk. Try widening the walk budget, or a nearby landmark.</p>`;
    ui.options.replaceChildren();
    ui.boardHint.textContent = '';
    ui.status.className = 'status';
    ui.status.textContent = plan.detours.length > 0
      ? `${plan.detours.length} option(s) rejected as detours`
      : 'No direct service';
    renderBanner();
    return;
  }

  renderBanner();
  refresh();
}

function renderBanner() {
  if (!plan) { ui.banner.hidden = true; return; }
  const parts = [];
  if (plan.direct.length === 0 && plan.detours.length > 0) {
    const best = plan.detours[0];
    parts.push(
      `Only indirect options exist: ${best.service} would take ${best.stopsTravelled} stops ` +
      `to ${best.alight.name}. Rejected as a detour.`,
    );
  }
  const dropped = plan.detours.length;
  if (plan.direct.length > 0 && dropped > 0) {
    parts.push(`${dropped} longer option${dropped === 1 ? '' : 's'} hidden as detours.`);
  }
  if (legs.length < new Set(plan.direct.map((o) => o.boardStop)).size) {
    parts.push(`Polling the best ${MAX_LEGS} boarding stops only.`);
  }
  if (parts.length === 0) { ui.banner.hidden = true; return; }
  ui.banner.hidden = false;
  ui.bannerText.textContent = parts.join(' ');
}

/* ---------- rendering ---------- */

const routeFor = (o) => legs.find((l) => l.stopCode === o.stopCode)?.alightBy[o.service] ?? null;

function renderHero(best) {
  if (!best) {
    ui.hero.innerHTML = '<p class="hero-empty">Nothing catchable right now — see the board.</p>';
    return;
  }
  const route = routeFor(best);
  const mins = best.arrival.minutesAway;
  ui.hero.innerHTML = `
    <div class="hero-lead">
      <span class="hero-svc">${esc(best.service)}</span>
      <span class="hero-eta">${etaText(mins)}${mins > 0 ? ' min' : ''}<small>departs in</small></span>
    </div>
    <p class="hero-dest">${esc(best.stopName)} &rarr; ${esc(route?.alight.name ?? to.name)}</p>
    <p class="hero-meta">
      ${best.walkMinutes} min walk to stop
      ${best.spareMinutes > 0 ? `&middot; <span class="ok">${best.spareMinutes} min spare</span>` : '&middot; leave now'}
    </p>
    ${
      route
        ? `<dl class="stats">
             <div class="stat walk"><dt>Walk to stop</dt><dd>${best.walkMinutes}<span> min</span></dd></div>
             <div class="stat ride"><dt>Ride</dt><dd>${route.stopsTravelled}<span> stops</span></dd></div>
             <div class="stat last"><dt>Final walk</dt><dd>${route.alight.walkMinutes}<span> min</span></dd></div>
             <div class="stat total"><dt>Total aboard</dt><dd>~${route.estimatedMinutes}<span> min</span></dd></div>
           </dl>
           <p class="hero-meta">Alight ${esc(route.alight.name)} &middot; ${route.alight.metresToAnchor} m from ${esc(to.name)}</p>`
        : ''
    }`;
}

function renderTiles(options) {
  ui.options.replaceChildren();
  const shown = options.slice(0, 8);
  let firstCatchable = true;

  for (const o of shown) {
    const route = routeFor(o);
    const mins = o.arrival.minutesAway;
    const isNext = o.catchable && firstCatchable;
    if (isNext) firstCatchable = false;

    const tile = document.createElement('article');
    tile.className = ['tile', isNext ? 'is-next' : '', o.catchable ? '' : 'is-missed',
      o.catchable && mins <= 5 ? 'is-soon' : ''].filter(Boolean).join(' ');
    tile.innerHTML = `
      <div class="tile-top">
        <span class="tile-svc">${esc(o.service)}</span>
        <span class="tile-stops">${route ? `${route.stopsTravelled} stops` : ''}</span>
      </div>
      <p class="tile-eta">${etaText(mins)}<small>${mins > 0 ? 'min' : ''}</small></p>
      <p class="tile-sub">${esc(o.stopName)}<br>${o.walkMinutes} min walk${
        route ? ` &middot; ~${route.estimatedMinutes} min total` : ''
      }</p>
      <div class="tile-tags">
        <span class="tag ${o.arrival.live ? 'live' : 'sched'}">${o.arrival.live ? 'live' : 'scheduled'}</span>
        ${o.arrival.load ? `<span class="tag load">${esc(o.arrival.loadLabel)}</span>` : ''}
        ${o.catchable ? '' : '<span class="tag miss">can\'t make it</span>'}
      </div>
      <div class="tile-rule"></div>`;
    ui.options.append(tile);
  }
  ui.boardHint.textContent = shown.length ? `${shown.length} shown` : '';
}

/** Repaint from the stored payload at the current time. No network. */
function paint() {
  if (!lastFetchAt || legs.length === 0) return;
  const arrivalsByStop = Object.fromEntries(
    legs.map((l) => [l.stopCode, parseArrivals(lastRaw[l.stopCode], Date.now())]),
  );
  const { options, best } = rankOptions({ legs, arrivalsByStop });
  renderHero(best);
  renderTiles(options);

  ui.status.className = 'status';
  ui.status.textContent =
    options.length === 0 ? 'No buses running right now'
    : !best ? 'Nothing catchable — next options listed'
    : 'Ranked by earliest catchable departure';
}

function paintChips() {
  const now = new Date();
  ui.clock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  if (lastFetchAt) {
    const age = Math.floor((Date.now() - lastFetchAt) / 1000);
    ui.updated.textContent = age <= 1 ? 'just now' : `${age}s ago`;
    const stale = Date.now() - lastFetchAt > STALE_MS;
    ui.live.className = `chip chip-live${failing ? ' is-down' : stale ? ' is-stale' : ''}`;
    ui.live.lastChild.textContent = failing ? 'RETRYING' : stale ? 'STALE' : 'LIVE';
  }
  ui.countdown.textContent = nextFetchAt
    ? `${Math.max(0, Math.ceil((nextFetchAt - Date.now()) / 1000))}s`
    : '–';
}

/* ---------- arrivals ---------- */

async function fetchStop(stopCode, signal) {
  const res = await fetch(arrivelahUrl(stopCode), { signal });
  if (!res.ok) throw new Error(`stop ${stopCode}: HTTP ${res.status}`);
  return res.json();
}

async function refresh() {
  if (legs.length === 0) return;
  inflight?.abort();
  inflight = new AbortController();
  try {
    const payloads = await Promise.all(
      legs.map((l) => fetchStop(l.stopCode, inflight.signal).catch(() => ({ services: [] }))),
    );
    lastRaw = Object.fromEntries(legs.map((l, i) => [l.stopCode, payloads[i]]));
    lastFetchAt = Date.now();
    failing = false;
    paint();
    schedule(POLL_MS);
  } catch (err) {
    if (err.name === 'AbortError') return;
    failing = true;
    ui.status.className = 'status is-error';
    ui.status.textContent = `Arrivals feed unreachable, retrying — ${err.message}`;
    schedule(RETRY_MS);
  }
  paintChips();
}

function schedule(ms) {
  clearTimeout(pollTimer);
  nextFetchAt = Date.now() + ms;
  if (document.hidden) return;
  pollTimer = setTimeout(refresh, ms);
}

/* ---------- controls ---------- */

ui.gps.addEventListener('click', async () => {
  ui.gps.disabled = true;
  ui.gps.classList.add('is-busy');
  ui.fromNote.className = 'field-note';
  ui.fromNote.textContent = 'Locating…';
  try {
    const pos = await currentPosition();
    const near = nearestStops(net?.stops ?? [], pos, { limit: 1 });
    const label = near[0] ? `Near ${near[0].name}` : 'Current location';
    setEndpoint('from', { name: label, lat: pos.lat, lng: pos.lng },
      { note: `Located to ±${pos.accuracy} m` });
  } catch (err) {
    ui.fromNote.className = 'field-note is-error';
    ui.fromNote.textContent = err.message;
  } finally {
    ui.gps.disabled = false;
    ui.gps.classList.remove('is-busy');
  }
});

ui.walk.addEventListener('input', () => {
  walkBudget = Number(ui.walk.value);
  ui.walkOut.textContent = `${walkBudget} min`;
});
ui.walk.addEventListener('change', () => { save(); replan(); });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(pollTimer);
  else refresh();
});

setInterval(() => { paintChips(); paint(); }, TICK_MS);

wireField('from', ui.from, ui.fromSuggest);
wireField('to', ui.to, ui.toSuggest);

/* ---------- boot ---------- */

function buildPresets() {
  ui.presets.replaceChildren();
  const items = [
    { label: `From ${ORIGIN.name}`, role: 'from', place: { name: ORIGIN.name, lat: ORIGIN.lat, lng: ORIGIN.lng, detail: ORIGIN.address } },
    ...DESTINATIONS.map((d) => ({
      label: `To ${d.name}`,
      role: 'to',
      place: { name: d.name, lat: d.anchors[0].lat, lng: d.anchors[0].lng, detail: d.anchors[0].name },
    })),
  ];
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.textContent = item.label;
    b.addEventListener('click', () => setEndpoint(item.role, item.place));
    ui.presets.append(b);
  }
}

try {
  buildPresets();
  net = await loadNetwork();
  ui.netState.textContent =
    `${net.stops.length} stops · ${Object.keys(net.services).length} services`;
  ui.freshness.textContent = `Route data ${new Date(net.lastUpdated).toLocaleDateString('en-SG')} · planned in-browser`;

  const saved = restore();
  if (saved?.walkBudget) {
    walkBudget = saved.walkBudget;
    ui.walk.value = String(walkBudget);
    ui.walkOut.textContent = `${walkBudget} min`;
  }
  if (saved?.from && saved?.to) {
    from = saved.from;
    to = saved.to;
    ui.from.value = from.name;
    ui.to.value = to.name;
    ui.fromNote.className = 'field-note is-set';
    ui.fromNote.textContent = 'Restored';
    ui.toNote.className = 'field-note is-set';
    ui.toNote.textContent = 'Restored';
    replan();
  }
} catch (err) {
  ui.netState.textContent = 'Network data unavailable';
  ui.status.className = 'status is-error';
  ui.status.textContent = `Could not load route data: ${err.message}`;
}

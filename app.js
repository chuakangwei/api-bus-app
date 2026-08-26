/**
 * Departure board for CT Hub 2.
 *
 * Route data is precomputed (see scripts/build-routes.mjs), so the only network
 * traffic at runtime is one arrivelah2 call per boarding stop.
 *
 * Two clocks run: arrivals are refetched every 15s (matching arrivelah2's own
 * cache), while the display re-renders every second from the stored payload so
 * countdowns tick down smoothly without extra requests.
 */

import { parseArrivals, arrivelahUrl } from './src/lib/arrivals.js';
import { rankOptions } from './src/lib/rank.js';

const POLL_MS = 15_000;
const RETRY_MS = 3_000;
const TICK_MS = 1_000;
/** Feed is flagged stale once the last good fetch is older than this. */
const STALE_MS = 45_000;

const el = {
  destination: document.getElementById('destination'),
  hero: document.getElementById('hero-body'),
  options: document.getElementById('options'),
  status: document.getElementById('status'),
  boardHint: document.getElementById('board-hint'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('banner-text'),
  freshness: document.getElementById('freshness'),
  clock: document.getElementById('clock'),
  updated: document.getElementById('updated'),
  countdown: document.getElementById('countdown'),
  live: document.getElementById('chip-live'),
};

let routes = null;
let legs = [];
/** Raw arrivelah2 payloads, kept so the board can re-tick without refetching. */
let lastRaw = {};
let lastFetchAt = null;
let nextFetchAt = null;
let pollTimer = null;
let inflight = null;
let failing = false;

const pad = (n) => String(n).padStart(2, '0');
const etaText = (m) => (m <= 0 ? 'now' : String(m));

/** Boarding stops for a destination, with the services that reach it. */
function legsFor(dest) {
  const byStop = new Map();
  for (const opt of dest.direct) {
    const stop = routes.originStops.find((s) => s.code === opt.boardStop);
    if (!stop) continue;
    if (!byStop.has(stop.code)) {
      byStop.set(stop.code, {
        stopCode: stop.code,
        stopName: stop.name,
        walkMinutes: stop.walkMinutes,
        services: [],
        alightBy: {},
      });
    }
    const leg = byStop.get(stop.code);
    if (!leg.services.includes(opt.service)) leg.services.push(opt.service);
    leg.alightBy[opt.service] = opt;
  }
  return [...byStop.values()];
}

const routeFor = (option) =>
  legs.find((l) => l.stopCode === option.stopCode)?.alightBy[option.service] ?? null;

function renderHero(best, dest) {
  if (!best) {
    el.hero.innerHTML = `<p class="hero-empty">No catchable bus to ${dest.name} right now.</p>`;
    return;
  }
  const route = routeFor(best);
  const mins = best.arrival.minutesAway;
  el.hero.innerHTML = `
    <div class="hero-lead">
      <span class="hero-svc">${best.service}</span>
      <span class="hero-eta">${etaText(mins)}${mins > 0 ? ' min' : ''}<small>departs in</small></span>
    </div>
    <p class="hero-dest">${best.stopName} &rarr; ${dest.name}</p>
    <p class="hero-meta">
      Leave now &middot; ${best.walkMinutes} min walk
      ${best.spareMinutes > 0 ? `&middot; <span class="ok">${best.spareMinutes} min spare</span>` : '&middot; leave immediately'}
    </p>
    ${
      route
        ? `<dl class="stats">
             <div class="stat walk"><dt>Walk to stop</dt><dd>${best.walkMinutes}<span> min</span></dd></div>
             <div class="stat ride"><dt>Ride</dt><dd>${route.stopsTravelled}<span> stops</span></dd></div>
             <div class="stat last"><dt>Final walk</dt><dd>${route.alight.walkMinutes}<span> min</span></dd></div>
             <div class="stat total"><dt>Total aboard</dt><dd>~${route.estimatedMinutes}<span> min</span></dd></div>
           </dl>
           <p class="hero-meta">Alight at ${route.alight.name}</p>`
        : ''
    }`;
}

function renderTiles(options) {
  el.options.replaceChildren();
  const shown = options.slice(0, 8);
  let firstCatchable = true;

  for (const o of shown) {
    const route = routeFor(o);
    const mins = o.arrival.minutesAway;
    const isNext = o.catchable && firstCatchable;
    if (isNext) firstCatchable = false;

    const tile = document.createElement('article');
    tile.className = [
      'tile',
      isNext ? 'is-next' : '',
      o.catchable ? '' : 'is-missed',
      o.catchable && mins <= 5 ? 'is-soon' : '',
    ]
      .filter(Boolean)
      .join(' ');

    tile.innerHTML = `
      <div class="tile-top">
        <span class="tile-svc">${o.service}</span>
        <span class="tile-stops">${route ? `${route.stopsTravelled} stops` : ''}</span>
      </div>
      <p class="tile-eta">${etaText(mins)}<small>${mins > 0 ? 'min' : ''}</small></p>
      <p class="tile-sub">
        ${o.stopName}<br>${o.walkMinutes} min walk${route ? ` &middot; ~${route.estimatedMinutes} min total` : ''}
      </p>
      <div class="tile-tags">
        <span class="tag ${o.arrival.live ? 'live' : 'sched'}">${o.arrival.live ? 'live' : 'scheduled'}</span>
        ${o.arrival.load ? `<span class="tag load">${o.arrival.loadLabel}</span>` : ''}
        ${o.catchable ? '' : '<span class="tag miss">can\'t make it</span>'}
      </div>
      <div class="tile-rule"></div>`;
    el.options.append(tile);
  }

  el.boardHint.textContent = shown.length > 0 ? `${shown.length} shown` : '';
}

/** Re-render from the stored payload using the current time. No network. */
function paint() {
  const dest = currentDest();
  if (!dest || !lastFetchAt) return;

  const arrivalsByStop = Object.fromEntries(
    legs.map((l) => [l.stopCode, parseArrivals(lastRaw[l.stopCode], Date.now())]),
  );
  const { options, best } = rankOptions({ legs, arrivalsByStop });

  renderHero(best, dest);
  renderTiles(options);

  if (options.length === 0) {
    el.status.className = 'status';
    el.status.textContent = 'No buses running right now';
  } else if (!best) {
    el.status.className = 'status';
    el.status.textContent = 'Nothing catchable — next options listed';
  } else {
    el.status.className = 'status';
    el.status.textContent = `Ranked by earliest catchable departure`;
  }
}

/** Header chips: wall clock, feed age, and the countdown to the next fetch. */
function paintChips() {
  const now = new Date();
  el.clock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  if (lastFetchAt) {
    const age = Math.floor((Date.now() - lastFetchAt) / 1000);
    el.updated.textContent = age <= 1 ? 'just now' : `${age}s ago`;
    const stale = Date.now() - lastFetchAt > STALE_MS;
    el.live.className = `chip chip-live${failing ? ' is-down' : stale ? ' is-stale' : ''}`;
    el.live.lastChild.textContent = failing ? 'RETRYING' : stale ? 'STALE' : 'LIVE';
  }

  if (nextFetchAt) {
    const left = Math.max(0, Math.ceil((nextFetchAt - Date.now()) / 1000));
    el.countdown.textContent = `${left}s`;
  }
}

function renderBanner(dest) {
  if (!dest?.fallback?.note) {
    el.banner.hidden = true;
    return;
  }
  el.banner.hidden = false;
  el.bannerText.textContent = dest.fallback.note;
}

const currentDest = () =>
  routes?.destinations.find((d) => d.id === el.destination.value) ??
  routes?.destinations[0] ??
  null;

async function fetchStop(stopCode, signal) {
  const res = await fetch(arrivelahUrl(stopCode), { signal });
  if (!res.ok) throw new Error(`stop ${stopCode}: HTTP ${res.status}`);
  return res.json();
}

async function refresh() {
  const dest = currentDest();
  if (!dest) return;

  legs = legsFor(dest);
  renderBanner(dest);

  if (legs.length === 0) {
    el.hero.innerHTML = `<p class="hero-empty">No direct bus reaches within ${dest.maxWalkMinutes} min walk of ${dest.name}.</p>`;
    el.options.replaceChildren();
    el.status.className = 'status';
    el.status.textContent = 'No direct service';
    return;
  }

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
    el.status.className = 'status is-error';
    el.status.textContent = `Arrivals feed unreachable, retrying — ${err.message}`;
    schedule(RETRY_MS);
  }
  paintChips();
}

function schedule(ms) {
  clearTimeout(pollTimer);
  nextFetchAt = Date.now() + ms;
  // Never poll a tab nobody is looking at.
  if (document.hidden) return;
  pollTimer = setTimeout(refresh, ms);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(pollTimer);
  else refresh();
});

el.destination.addEventListener('change', () => {
  lastFetchAt = null;
  lastRaw = {};
  refresh();
});

setInterval(() => {
  paintChips();
  if (lastFetchAt) paint();
}, TICK_MS);

try {
  routes = await (await fetch('./data/routes.json')).json();
  el.destination.replaceChildren(
    ...routes.destinations.map((d) => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = `${d.name} · ${d.maxWalkMinutes} min walk`;
      return o;
    }),
  );
  el.freshness.textContent =
    `Origin ${routes.origin.name}, ${routes.origin.address} · ` +
    `route data ${new Date(routes.datasetLastUpdated).toLocaleDateString('en-SG')}`;
  await refresh();
} catch (err) {
  el.status.className = 'status is-error';
  el.status.textContent = `Could not load route data: ${err.message}`;
}

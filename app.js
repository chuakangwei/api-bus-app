/**
 * Departure board for CT Hub 2.
 *
 * Route data is precomputed (see scripts/build-routes.mjs), so the only network
 * traffic at runtime is one arrivelah2 call per boarding stop.
 */

import { arrivelahUrl, parseArrivals } from './src/lib/arrivals.js';
import { rankOptions } from './src/lib/rank.js';

/** Matches arrivelah2's own 15s cache, so polling costs nothing upstream. */
const POLL_MS = 15_000;
/** Upstream back-off on failure, mirroring busrouter.sg's own client. */
const RETRY_MS = 3_000;

const el = {
  destination: document.getElementById('destination'),
  pick: document.getElementById('pick'),
  options: document.getElementById('options'),
  status: document.getElementById('status'),
  fallback: document.getElementById('fallback'),
  freshness: document.getElementById('freshness'),
};

let routes = null;
let timer = null;
let inflight = null;

const minutesText = (m) => (m <= 0 ? 'now' : `${m} min`);

/** Boarding stops for the selected destination, each with the services that reach it. */
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

async function fetchStop(stopCode, signal) {
  const res = await fetch(arrivelahUrl(stopCode), { signal });
  if (!res.ok) throw new Error(`stop ${stopCode}: HTTP ${res.status}`);
  return parseArrivals(await res.json());
}

function renderPick(best, legs) {
  if (!best) {
    el.pick.hidden = true;
    return;
  }
  const alight = legs.find((l) => l.stopCode === best.stopCode)?.alightBy[best.service];
  el.pick.hidden = false;
  el.pick.innerHTML = `
    <p class="pick-lead">Take</p>
    <p class="pick-body"><span class="svc">${best.service}</span> in ${minutesText(best.arrival.minutesAway)}</p>
    <p class="pick-note">
      Walk ${best.walkMinutes} min to ${best.stopName}${best.spareMinutes > 0 ? ` &middot; ${best.spareMinutes} min spare` : ''}
      ${alight ? `<br>Ride ${alight.stopsTravelled} stops, then ${alight.alight.walkMinutes} min walk from ${alight.alight.name}<br>About ${alight.estimatedMinutes} min once aboard` : ''}
    </p>`;
}

function renderOptions(options, legs) {
  el.options.replaceChildren();
  for (const o of options.slice(0, 8)) {
    const alight = legs.find((l) => l.stopCode === o.stopCode)?.alightBy[o.service];
    const li = document.createElement('li');
    li.className = `opt${o.catchable ? '' : ' missed'}`;
    li.innerHTML = `
      <span class="opt-svc">${o.service}</span>
      <span class="opt-where">
        ${o.stopName} &middot; ${o.walkMinutes} min walk
        ${alight ? `<br>${alight.stopsTravelled} stops &rarr; ${alight.alight.walkMinutes} min walk &middot; ~${alight.estimatedMinutes} min` : ''}
        ${o.catchable ? '' : '<br><span class="tag miss">Not enough time</span>'}
      </span>
      <span class="opt-when">
        <span class="opt-eta">${minutesText(o.arrival.minutesAway)}</span>
        ${o.arrival.live ? '' : '<br><span class="tag est">scheduled</span>'}
      </span>`;
    el.options.append(li);
  }
}

function renderFallback(dest, hasAny) {
  if (!dest.fallback) {
    el.fallback.hidden = true;
    return;
  }
  el.fallback.hidden = false;
  el.fallback.innerHTML = `
    <h2>${hasAny ? 'Also worth knowing' : 'No direct bus'}</h2>
    <p>${dest.fallback.note}</p>`;
}

async function refresh() {
  // Fall back to the first destination rather than rendering nothing if the
  // select has no value yet.
  const dest =
    routes.destinations.find((d) => d.id === el.destination.value) ??
    routes.destinations[0];
  if (!dest) return;
  const legs = legsFor(dest);

  if (legs.length === 0) {
    el.pick.hidden = true;
    el.options.replaceChildren();
    el.status.textContent = `No direct bus from CT Hub 2 reaches within ${dest.maxWalkMinutes} min walk of ${dest.name}.`;
    renderFallback(dest, false);
    return;
  }

  inflight?.abort();
  inflight = new AbortController();

  try {
    const results = await Promise.all(
      legs.map((l) => fetchStop(l.stopCode, inflight.signal).catch(() => [])),
    );
    const arrivalsByStop = Object.fromEntries(legs.map((l, i) => [l.stopCode, results[i]]));
    const { options, best } = rankOptions({ legs, arrivalsByStop });

    renderPick(best, legs);
    renderOptions(options, legs);
    renderFallback(dest, true);

    el.status.className = 'status';
    if (options.length === 0) {
      el.status.textContent = 'No buses running right now.';
    } else if (!best) {
      el.status.textContent = 'Nothing you can still catch — the next one is listed above.';
    } else {
      el.status.textContent = `Updated ${new Date().toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }
    schedule(POLL_MS);
  } catch (err) {
    if (err.name === 'AbortError') return;
    el.status.className = 'status error';
    el.status.textContent = `Could not reach the arrivals service. Retrying… (${err.message})`;
    schedule(RETRY_MS);
  }
}

function schedule(ms) {
  clearTimeout(timer);
  // Never poll a tab nobody is looking at; refresh immediately on return.
  if (document.hidden) return;
  timer = setTimeout(refresh, ms);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else refresh();
});

el.destination.addEventListener('change', refresh);

try {
  routes = await (await fetch('./data/routes.json')).json();
  el.destination.replaceChildren(
    ...routes.destinations.map((d) => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = `${d.name} (within ${d.maxWalkMinutes} min walk)`;
      return o;
    }),
  );
  el.freshness.textContent = `Route data from busrouter.sg, last updated ${new Date(routes.datasetLastUpdated).toLocaleDateString('en-SG')}.`;
  await refresh();
} catch (err) {
  el.status.className = 'status error';
  el.status.textContent = `Could not load route data: ${err.message}`;
}

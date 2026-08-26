/**
 * Terminal departure board -- `npm start [from] [to]`.
 *
 * Uses the same planner as the web UI, so running this exercises the real
 * routing path against live data.
 *
 *   npm start                                 # config defaults
 *   npm start -- "CT Hub 2" "Redhill MRT"
 *   npm start -- 338729 "Tiong Bahru"         # postal codes work too
 */

import { loadNetwork } from './lib/data.js';
import { planDirect, legsFromDirect } from './lib/plan.js';
import { geocode, searchStops } from './lib/places.js';
import { parseArrivals, arrivelahUrl } from './lib/arrivals.js';
import { rankOptions } from './lib/rank.js';
import { ORIGIN, DESTINATIONS, WALK_PENALTY_MINUTES } from './lib/config.js';

const MAX_LEGS = 6;
const WALK_BUDGET_MIN = Number(process.env.WALK_MIN ?? 8);

/** Resolve free text to a point: bus stops first, then OneMap. */
async function resolve(query, stops) {
  const local = searchStops(stops, query, { limit: 1 });
  if (local.length > 0) return local[0];
  const [place] = await geocode(query, { limit: 1 });
  if (!place) throw new Error(`Could not find "${query}"`);
  return place;
}

const net = await loadNetwork();

const [fromArg, toArg] = process.argv.slice(2);
const from = fromArg
  ? await resolve(fromArg, net.stops)
  : { name: ORIGIN.name, detail: ORIGIN.address, lat: ORIGIN.lat, lng: ORIGIN.lng };
const to = toArg
  ? await resolve(toArg, net.stops)
  : {
      name: DESTINATIONS[0].name,
      detail: DESTINATIONS[0].anchors[0].name,
      lat: DESTINATIONS[0].anchors[0].lat,
      lng: DESTINATIONS[0].anchors[0].lng,
    };

console.log(`${from.name} → ${to.name}`);
console.log(
  `${net.stops.length} stops · ${Object.keys(net.services).length} services · ` +
    `data ${net.lastUpdated} · walk budget ${WALK_BUDGET_MIN} min\n`,
);

const plan = planDirect({
  stops: net.stops,
  services: net.services,
  originAnchors: [{ name: from.name, lat: from.lat, lng: from.lng }],
  destAnchors: [{ name: to.name, lat: to.lat, lng: to.lng }],
  originWalkMin: WALK_BUDGET_MIN,
  destWalkMin: 10,
  penalties: WALK_PENALTY_MINUTES,
});

if (plan.direct.length === 0) {
  console.log(`No direct bus within a ${WALK_BUDGET_MIN} min walk.`);
  if (plan.detours.length > 0) {
    const d = plan.detours[0];
    console.log(
      `Closest indirect option: ${d.service}, ${d.stopsTravelled} stops to ${d.alight.name} ` +
        `(rejected as a detour).`,
    );
  }
  process.exit(0);
}

// Bound polling: arrivelah2 is an unpaid courtesy service.
const boardOrder = [...new Set(plan.direct.map((o) => o.boardStop))].slice(0, MAX_LEGS);
const legs = legsFromDirect(plan.direct.filter((o) => boardOrder.includes(o.boardStop)));

const payloads = await Promise.all(
  legs.map((l) =>
    fetch(arrivelahUrl(l.stopCode))
      .then((r) => r.json())
      .catch(() => ({ services: [] })),
  ),
);
const arrivalsByStop = Object.fromEntries(
  legs.map((l, i) => [l.stopCode, parseArrivals(payloads[i])]),
);
const { options, best } = rankOptions({ legs, arrivalsByStop });

for (const o of options.slice(0, 8)) {
  const route = legs.find((l) => l.stopCode === o.stopCode).alightBy[o.service];
  const eta = o.arrival.minutesAway <= 0 ? 'now' : `${o.arrival.minutesAway} min`;
  console.log(
    `${o.catchable ? ' ' : '×'} ${o.service.padStart(5)}  ${eta.padStart(6)}` +
      `  ${o.arrival.live ? 'live ' : 'sched'}` +
      `  ${o.stopName} (${o.walkMinutes} min walk)` +
      `  → ${route.stopsTravelled} stops, ${route.alight.walkMinutes} min walk` +
      ` from ${route.alight.name}  (~${route.estimatedMinutes} min)`,
  );
}

console.log(
  best
    ? `\nTake ${best.service} in ${best.arrival.minutesAway <= 0 ? 'now' : `${best.arrival.minutesAway} min`}` +
        ` from ${best.stopName}${best.spareMinutes > 0 ? ` (${best.spareMinutes} min spare)` : ''}`
    : '\nNothing you can still catch.',
);
if (options.some((o) => !o.catchable)) console.log('× = not enough time to walk there');
if (plan.detours.length > 0) console.log(`${plan.detours.length} longer option(s) hidden as detours.`);

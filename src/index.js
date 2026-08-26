/**
 * Terminal departure board -- `npm start`.
 *
 * Shares the same lib code as the web UI, so running this exercises the real
 * ranking path against live data.
 */

import { readFile } from 'node:fs/promises';
import { arrivelahUrl, parseArrivals } from './lib/arrivals.js';
import { rankOptions } from './lib/rank.js';

const ROUTES = new URL('../data/routes.json', import.meta.url);

/** Group a destination's direct options by boarding stop. */
export function buildLegs(routes, dest) {
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

const routes = JSON.parse(await readFile(ROUTES, 'utf8'));
const wanted = process.argv[2];
const dest =
  routes.destinations.find((d) => d.id === wanted) ?? routes.destinations[0];

if (wanted && dest.id !== wanted) {
  console.error(`Unknown destination "${wanted}". Known: ${routes.destinations.map((d) => d.id).join(', ')}`);
  process.exitCode = 1;
}

const legs = buildLegs(routes, dest);
console.log(`${routes.origin.name} -> ${dest.name} (within ${dest.maxWalkMinutes} min walk)\n`);

if (legs.length === 0) {
  console.log(`No direct bus reaches ${dest.name}.`);
  if (dest.fallback) console.log(`\n${dest.fallback.note}`);
  process.exit(0);
}

const results = await Promise.all(
  legs.map((l) =>
    fetch(arrivelahUrl(l.stopCode))
      .then((r) => r.json())
      .then(parseArrivals)
      .catch(() => []),
  ),
);
const arrivalsByStop = Object.fromEntries(legs.map((l, i) => [l.stopCode, results[i]]));
const { options, best } = rankOptions({ legs, arrivalsByStop });

for (const o of options.slice(0, 8)) {
  const alight = legs.find((l) => l.stopCode === o.stopCode).alightBy[o.service];
  const eta = o.arrival.minutesAway <= 0 ? 'now' : `${o.arrival.minutesAway} min`;
  console.log(
    `${o.catchable ? ' ' : '×'} ${o.service.padStart(5)}  ${eta.padStart(6)}` +
      `  ${o.arrival.live ? 'live ' : 'sched'}` +
      `  ${o.stopName} (${o.walkMinutes} min walk)` +
      `  → ${alight.stopsTravelled} stops, ${alight.alight.walkMinutes} min walk from ${alight.alight.name}` +
      `  (~${alight.estimatedMinutes} min)`,
  );
}

console.log(
  best
    ? `\nTake ${best.service} in ${best.arrival.minutesAway <= 0 ? 'now' : `${best.arrival.minutesAway} min`}` +
        ` from ${best.stopName}${best.spareMinutes > 0 ? ` (${best.spareMinutes} min spare)` : ''}`
    : '\nNothing you can still catch.',
);
if (options.some((o) => !o.catchable)) console.log('× = not enough time to walk there');
if (dest.fallback) console.log(`\nNote: ${dest.fallback.note}`);

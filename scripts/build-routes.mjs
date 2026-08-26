/**
 * Precomputes the direct-service table and writes web/data/routes.json.
 *
 * Why build-time: the origin and destinations are fixed, so the answer to
 * "which service connects these stops in the right direction" never changes
 * between data refreshes. Resolving it here means the browser downloads a few
 * KB instead of the ~573 KB of raw busrouter datasets.
 *
 * Run: npm run build:routes
 */

import { writeFile } from 'node:fs/promises';
import { haversine, walkMinutes, radiusForWalkMinutes } from '../src/lib/geo.js';
import {
  ORIGIN,
  ORIGIN_STOPS,
  DESTINATIONS,
  MAX_REASONABLE_STOPS,
  WALK_PENALTY_MINUTES,
} from '../src/lib/config.js';

const STOPS_URL = 'https://data.busrouter.sg/v1/stops.min.json';
const SERVICES_URL = 'https://data.busrouter.sg/v1/services.min.json';
const LAST_UPDATED_URL = 'https://data.busrouter.sg/v1/last-updated.txt';
const OUT = new URL('../data/routes.json', import.meta.url);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** stops.min.json is `{code: [lng, lat, name, road]}` -- note lng comes FIRST. */
const toStop = (code, [lng, lat, name, road]) => ({ code, lat, lng, name, road });

/**
 * Alighting stops within walking range of any of a destination's anchors.
 * Returns the closest-anchor distance for each, so the UI can say how far the
 * final walk is.
 */
function catchment(stops, dest) {
  const limit = radiusForWalkMinutes(dest.maxWalkMinutes);
  const out = new Map();
  for (const stop of stops) {
    let best = null;
    for (const anchor of dest.anchors) {
      const metres = haversine(stop, anchor);
      if (metres <= limit && (!best || metres < best.metres)) {
        best = { metres, anchor: anchor.name };
      }
    }
    if (best) {
      out.set(stop.code, {
        ...stop,
        metresToAnchor: Math.round(best.metres),
        nearestAnchor: best.anchor,
        walkMinutes: walkMinutes(best.metres) + (WALK_PENALTY_MINUTES[stop.code] ?? 0),
        walkPenalty: WALK_PENALTY_MINUTES[stop.code] ?? 0,
        // True walk can exceed the radius-based promise once a junction penalty
        // is applied. Surfaced rather than hidden, so the UI can say so.
        exceedsWalkPreference:
          walkMinutes(best.metres) + (WALK_PENALTY_MINUTES[stop.code] ?? 0) > dest.maxWalkMinutes,
      });
    }
  }
  return out;
}

/**
 * A service is a valid direct option only if, within ONE direction's stop
 * sequence, an origin stop appears at a LOWER index than a catchment stop.
 * Equal or higher index means the bus passes the destination before it reaches
 * you -- correct route, wrong way round.
 */
function findDirect(services, originCodes, catchmentStops) {
  const hits = [];
  for (const [no, svc] of Object.entries(services)) {
    for (const [direction, sequence] of svc.routes.entries()) {
      const originIdx = new Map();
      for (const [i, code] of sequence.entries()) {
        if (originCodes.has(code) && !originIdx.has(code)) originIdx.set(code, i);
      }
      if (originIdx.size === 0) continue;

      for (const [i, code] of sequence.entries()) {
        if (!catchmentStops.has(code)) continue;
        for (const [boardCode, boardIdx] of originIdx) {
          if (boardIdx >= i) continue; // wrong direction of travel
          hits.push({
            service: no,
            serviceName: svc.name,
            direction,
            boardStop: boardCode,
            boardIndex: boardIdx,
            alightStop: code,
            alightIndex: i,
            stopsTravelled: i - boardIdx,
            alight: catchmentStops.get(code),
          });
        }
      }
    }
  }
  return hits;
}

const [rawStops, services, lastUpdated] = await Promise.all([
  getJson(STOPS_URL),
  getJson(SERVICES_URL),
  fetch(LAST_UPDATED_URL).then((r) => r.text()),
]);

const stops = Object.entries(rawStops).map(([code, row]) => toStop(code, row));
const originCodes = new Set(ORIGIN_STOPS.map((s) => s.code));
console.log(`Loaded ${stops.length} stops, ${Object.keys(services).length} services`);
console.log(`Dataset last updated: ${lastUpdated.trim()}`);

const destinations = DESTINATIONS.map((dest) => {
  const stopsInRange = catchment(stops, dest);
  const hits = findDirect(services, originCodes, stopsInRange);

  // Keep, per (service, boarding stop), only the alighting stop with the
  // shortest final walk -- that is the one a rider would actually use.
  const bestPerPair = new Map();
  for (const hit of hits) {
    const key = `${hit.service}@${hit.boardStop}`;
    const prev = bestPerPair.get(key);
    if (!prev || hit.alight.metresToAnchor < prev.alight.metresToAnchor) {
      bestPerPair.set(key, hit);
    }
  }
  const all = [...bestPerPair.values()].sort((a, b) => a.stopsTravelled - b.stopsTravelled);
  const direct = all.filter((d) => d.stopsTravelled <= MAX_REASONABLE_STOPS);
  const detours = all.filter((d) => d.stopsTravelled > MAX_REASONABLE_STOPS);

  console.log(
    `\n${dest.name}: ${stopsInRange.size} stops within ${dest.maxWalkMinutes} min walk` +
      ` (<=${Math.round(radiusForWalkMinutes(dest.maxWalkMinutes))} m), ${direct.length} direct option(s)`,
  );
  for (const d of detours) {
    console.log(
      `  suppressed ${d.service} dir${d.direction}: ${d.stopsTravelled} stops via ${d.alight.name} -- detour`,
    );
  }
  for (const d of direct) {
    console.log(
      `  ${d.service.padStart(5)} dir${d.direction}  ${d.boardStop} -> ${d.alightStop}` +
        `  ${String(d.stopsTravelled).padStart(2)} stops  ${d.alight.name}` +
        ` (${d.alight.metresToAnchor} m / ${d.alight.walkMinutes} min walk)`,
    );
  }

  return {
    id: dest.id,
    name: dest.name,
    maxWalkMinutes: dest.maxWalkMinutes,
    anchors: dest.anchors,
    fallback: dest.fallback ?? null,
    direct,
  };
});

const payload = {
  generatedFrom: { stops: STOPS_URL, services: SERVICES_URL },
  datasetLastUpdated: lastUpdated.trim().replace(/^"|"$/g, ''),
  origin: ORIGIN,
  originStops: ORIGIN_STOPS,
  destinations,
};

await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\nWrote ${OUT.pathname}`);

/**
 * Journey planning over the busrouter.sg datasets.
 *
 * This is the logic that used to run at build time for a fixed origin. With an
 * arbitrary origin it has to run per query instead, so it lives here and is
 * shared verbatim by the browser and the CLI -- one implementation, no drift.
 *
 * The core rule throughout: a service only counts if an origin stop appears at
 * a LOWER index than a destination stop within the SAME direction array. Equal
 * or higher means the bus passes your destination before it reaches you.
 */

import { haversine, walkMinutes, radiusForWalkMinutes } from './geo.js';
import { rejectDetours } from './journey.js';

/** How far you will walk to reach a boarding stop, unless told otherwise. */
export const DEFAULT_ORIGIN_WALK_MIN = 8;

/** `stops.min.json` is `{code: [lng, lat, name, road]}` -- lng comes FIRST. */
export function indexStops(raw) {
  const out = [];
  for (const [code, row] of Object.entries(raw)) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const [lng, lat, name, road] = row;
    out.push({ code, lat, lng, name, road });
  }
  return out;
}

/**
 * Stops within a walking budget of any of the given anchor points.
 *
 * Each result carries the distance to its closest anchor, so the caller can
 * report the final walk honestly. `penalties` adds minutes for specific stops
 * whose walk crosses something a straight line ignores.
 */
export function stopsWithin(stops, anchors, maxWalkMin, penalties = {}) {
  const limit = radiusForWalkMinutes(maxWalkMin);
  const found = new Map();

  for (const stop of stops) {
    let best = null;
    for (const anchor of anchors) {
      const metres = haversine(stop, anchor);
      if (metres <= limit && (!best || metres < best.metres)) {
        best = { metres, anchor: anchor.name ?? '' };
      }
    }
    if (!best) continue;

    const penalty = penalties[stop.code] ?? 0;
    const walk = walkMinutes(best.metres) + penalty;
    found.set(stop.code, {
      ...stop,
      metresToAnchor: Math.round(best.metres),
      nearestAnchor: best.anchor,
      walkMinutes: walk,
      walkPenalty: penalty,
      exceedsWalkPreference: walk > maxWalkMin,
    });
  }
  return found;
}

/**
 * Every direction-valid pairing of a boarding stop and an alighting stop.
 *
 * Keeps only the best alighting stop per (service, boarding stop) -- the one
 * with the shortest final walk, which is the one a rider would actually use.
 */
export function findDirect(services, originStops, destStops) {
  const hits = new Map();

  for (const [no, svc] of Object.entries(services)) {
    const routes = Array.isArray(svc?.routes) ? svc.routes : [];

    for (const [direction, sequence] of routes.entries()) {
      // First index at which each origin stop appears in this direction.
      const boardAt = new Map();
      for (const [i, code] of sequence.entries()) {
        if (originStops.has(code) && !boardAt.has(code)) boardAt.set(code, i);
      }
      if (boardAt.size === 0) continue;

      for (const [i, code] of sequence.entries()) {
        const alight = destStops.get(code);
        if (!alight) continue;

        for (const [boardCode, boardIdx] of boardAt) {
          if (boardIdx >= i) continue; // wrong direction of travel
          const key = `${no}@${boardCode}`;
          const prev = hits.get(key);
          if (prev && prev.alight.metresToAnchor <= alight.metresToAnchor) continue;
          hits.set(key, {
            service: no,
            serviceName: svc.name ?? '',
            direction,
            boardStop: boardCode,
            boardIndex: boardIdx,
            alightStop: code,
            alightIndex: i,
            stopsTravelled: i - boardIdx,
            board: originStops.get(boardCode),
            alight,
          });
        }
      }
    }
  }
  return [...hits.values()];
}

/**
 * Plan direct journeys between two places.
 *
 * @param {object} p
 * @param {Array}  p.stops            - from indexStops()
 * @param {object} p.services         - raw services.min.json
 * @param {Array}  p.originAnchors    - [{ name, lat, lng }]
 * @param {Array}  p.destAnchors      - [{ name, lat, lng }]
 * @param {number} [p.originWalkMin]
 * @param {number} [p.destWalkMin]
 * @param {object} [p.penalties]
 */
export function planDirect({
  stops,
  services,
  originAnchors,
  destAnchors,
  originWalkMin = DEFAULT_ORIGIN_WALK_MIN,
  destWalkMin = 10,
  penalties = {},
}) {
  const originStops = stopsWithin(stops, originAnchors, originWalkMin, penalties);
  const destStops = stopsWithin(stops, destAnchors, destWalkMin, penalties);

  if (originStops.size === 0 || destStops.size === 0) {
    return { originStops, destStops, direct: [], detours: [] };
  }

  const all = findDirect(services, originStops, destStops).sort(
    (a, b) => a.stopsTravelled - b.stopsTravelled,
  );
  const { keep: direct, drop: detours } = rejectDetours(all);
  direct.sort((a, b) => a.estimatedMinutes - b.estimatedMinutes);

  return { originStops, destStops, direct, detours };
}

/**
 * Group direct options by boarding stop, in the shape the ranker expects.
 * Shared by both front ends so the arrivals lookup is identical.
 */
export function legsFromDirect(direct) {
  const byStop = new Map();
  for (const opt of direct) {
    if (!byStop.has(opt.boardStop)) {
      byStop.set(opt.boardStop, {
        stopCode: opt.boardStop,
        stopName: opt.board?.name ?? opt.boardStop,
        walkMinutes: opt.board?.walkMinutes ?? 0,
        services: [],
        alightBy: {},
      });
    }
    const leg = byStop.get(opt.boardStop);
    if (!leg.services.includes(opt.service)) leg.services.push(opt.service);
    leg.alightBy[opt.service] = opt;
  }
  return [...byStop.values()];
}

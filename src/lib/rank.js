/**
 * Ranking: "leave-now soonest".
 *
 * The question this answers is not "which bus is fastest" but "which bus can I
 * physically still catch, and which of those leaves first". A bus arriving in
 * 2 minutes at a stop 5 minutes' walk away is not an option, and saying so is
 * the whole point of the walk-time modelling.
 */

/**
 * Arrivals already this far in the past are discarded as noise. The live feed
 * genuinely returns negative countdowns for buses that have just departed.
 */
const DEPARTED_GRACE_SEC = 60;

/**
 * Slack added to the walk before a bus is considered catchable: time to pack
 * up, wait for a lift, cross at the lights. Deliberately conservative.
 */
export const DEFAULT_BUFFER_SEC = 60;

/**
 * Build a flat, ranked list of options.
 *
 * @param {object} params
 * @param {Array} params.legs        - [{ stopCode, stopName, walkMinutes, services: [serviceNo] }]
 * @param {object} params.arrivalsByStop - { [stopCode]: parseArrivals() output }
 * @param {number} [params.bufferSec]
 * @returns {{options: Array, best: object|null}}
 */
export function rankOptions({ legs, arrivalsByStop, bufferSec = DEFAULT_BUFFER_SEC }) {
  const options = [];

  for (const leg of legs) {
    const atStop = arrivalsByStop[leg.stopCode] ?? [];
    const wanted = new Set(leg.services.map(String));

    for (const entry of atStop) {
      if (!wanted.has(entry.service)) continue; // service does not reach the destination

      for (const [index, arrival] of entry.arrivals.entries()) {
        if (arrival.secondsAway < -DEPARTED_GRACE_SEC) continue; // already gone

        const walkSec = leg.walkMinutes * 60;
        const spareSec = arrival.secondsAway - walkSec - bufferSec;

        options.push({
          service: entry.service,
          operator: entry.operator,
          stopCode: leg.stopCode,
          stopName: leg.stopName,
          walkMinutes: leg.walkMinutes,
          arrival,
          // Which of next/next2/next3 this was, for "and the one after" display.
          sequence: index,
          catchable: spareSec >= 0,
          spareMinutes: Math.floor(spareSec / 60),
        });
      }
    }
  }

  // Sort by actual arrival time. Uncatchable options stay in place rather than
  // being hidden or pushed to the bottom -- seeing the bus you just missed is
  // useful information, and it explains why the recommendation is what it is.
  options.sort((a, b) => a.arrival.secondsAway - b.arrival.secondsAway);

  const deduped = dedupeVehicles(options);

  const best = deduped.find((o) => o.catchable) ?? null;
  return { options: deduped, allOptions: options, best };
}

/**
 * Collapse rows that describe the SAME physical vehicle.
 *
 * The origin stops sit consecutively on the same route, so one bus generates an
 * arrival at each -- 175 at 07369 in 11 min and at 07379 in 12 min is one bus,
 * not two. Listing both makes the service look twice as frequent as it is.
 *
 * Keeps, per (service, sequence), the boarding stop that leaves the most slack
 * after walking; ties break toward the earlier arrival.
 */
export function dedupeVehicles(options) {
  const best = new Map();
  for (const o of options) {
    // destinationCode guards against merging a service that appears twice at one
    // stop because it serves both directions -- those are different vehicles.
    const key = `${o.service}#${o.sequence}#${o.arrival.destinationCode}`;
    const prev = best.get(key);
    if (
      !prev ||
      o.spareMinutes > prev.spareMinutes ||
      (o.spareMinutes === prev.spareMinutes &&
        o.arrival.secondsAway < prev.arrival.secondsAway)
    ) {
      best.set(key, o);
    }
  }
  return [...best.values()].sort(
    (a, b) => a.arrival.secondsAway - b.arrival.secondsAway,
  );
}

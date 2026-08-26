/** Geographic helpers. All distances in metres, all angles in degrees. */

const EARTH_RADIUS_M = 6371008.8;

/** Average walking pace, metres per minute (~4.8 km/h). */
export const WALK_METRES_PER_MIN = 80;

/**
 * Circuity factor: real pedestrian paths are longer than straight lines because
 * of blocks, crossings and detours. 1.3 is a common urban approximation.
 */
export const CIRCUITY = 1.3;

const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance between two {lat, lng} points, in metres. */
export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Estimated walking time in minutes for a straight-line distance, inflated by
 * CIRCUITY to approximate the real path. Rounded up — it is better to tell
 * someone a walk is a minute longer than to have them miss the bus.
 */
export function walkMinutes(straightLineMetres) {
  return Math.ceil((straightLineMetres * CIRCUITY) / WALK_METRES_PER_MIN);
}

/** Straight-line distance that corresponds to a given walk time in minutes. */
export function radiusForWalkMinutes(minutes) {
  return (minutes * WALK_METRES_PER_MIN) / CIRCUITY;
}

/**
 * Parsing and normalising arrivelah2 responses.
 *
 * https://arrivelah2.busrouter.sg/?id=<5-digit stop code>
 *
 * The upstream shape is awkward in several documented ways, all handled here so
 * the rest of the app can rely on a clean model:
 *   - `next` / `next2` / `next3` may each be null (`next3` very often is).
 *   - `duration_ms` is frozen server-side and can be negative; we always
 *     recompute the countdown from the ISO `time` field instead.
 *   - `subsequent` is a byte-identical legacy alias of `next2` and is ignored.
 *   - A service number can appear twice in one response (it serves the stop in
 *     both directions); callers must not key by service number alone.
 *   - An unknown stop code returns HTTP 200 with `{"services":[]}`, never a 4xx.
 */

export const ARRIVELAH_BASE = 'https://arrivelah2.busrouter.sg/';

/** Passenger load codes -> human labels. */
const LOAD_LABELS = {
  SEA: 'Seats available',
  SDA: 'Standing available',
  LSD: 'Limited standing',
};

/** Vehicle type codes -> human labels. */
const BUS_TYPE_LABELS = {
  SD: 'Single deck',
  DD: 'Double deck',
  BD: 'Bendy',
};

export function loadLabel(code) {
  return LOAD_LABELS[code] ?? 'Unknown';
}

export function busTypeLabel(code) {
  return BUS_TYPE_LABELS[code] ?? 'Unknown';
}

export function arrivelahUrl(stopCode) {
  return `${ARRIVELAH_BASE}?id=${encodeURIComponent(stopCode)}`;
}

/**
 * Normalise one raw arrival object. Returns null when the arrival is absent,
 * which upstream signals with a literal null.
 *
 * `now` is injected so this is deterministic under test.
 */
export function normaliseArrival(raw, now = Date.now()) {
  if (!raw || !raw.time) return null;
  const at = new Date(raw.time);
  const ms = at.getTime();
  if (Number.isNaN(ms)) return null;
  return {
    at,
    // Recomputed locally: upstream duration_ms is stale by the time we read it.
    // Floored, not rounded, so "2 min" always means *at least* two minutes --
    // it is safer to leave early than to be told 3 min and miss the bus.
    minutesAway: Math.floor((ms - now) / 60000),
    secondsAway: Math.floor((ms - now) / 1000),
    load: raw.load ?? '',
    loadLabel: loadLabel(raw.load),
    busType: raw.type ?? '',
    busTypeLabel: busTypeLabel(raw.type),
    wheelchair: raw.feature === 'WAB',
    // monitored: 1 = real GPS estimate, 0 = timetable guess. Undocumented but
    // present, and the only honest signal of how much to trust the timing.
    live: raw.monitored === 1,
    // lat/lng are 0 when the vehicle is not being tracked.
    position:
      raw.lat && raw.lng && raw.lat !== 0 && raw.lng !== 0
        ? { lat: raw.lat, lng: raw.lng }
        : null,
    visitNumber: raw.visit_number ?? 1,
    destinationCode: raw.destination_code ?? '',
  };
}

/**
 * Flatten an arrivelah2 payload into one entry per service, each carrying up to
 * three upcoming arrivals (nulls dropped).
 */
export function parseArrivals(payload, now = Date.now()) {
  const services = Array.isArray(payload?.services) ? payload.services : [];
  return services.map((s) => ({
    service: String(s.no ?? ''),
    operator: s.operator ?? '',
    arrivals: [s.next, s.next2, s.next3]
      .map((a) => normaliseArrival(a, now))
      .filter(Boolean),
  }));
}

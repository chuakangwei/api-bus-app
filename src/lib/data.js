/**
 * Loading the busrouter.sg datasets.
 *
 * Both files are CORS-open and cached for 24h upstream, so the browser's HTTP
 * cache does the real work; this only avoids re-parsing them within a session.
 * Combined they are ~133 KB gzipped -- the unavoidable cost of planning from an
 * arbitrary origin, which cannot be precomputed the way a fixed one could.
 */

import { indexStops } from './plan.js';

export const STOPS_URL = 'https://data.busrouter.sg/v1/stops.min.json';
export const SERVICES_URL = 'https://data.busrouter.sg/v1/services.min.json';
export const LAST_UPDATED_URL = 'https://data.busrouter.sg/v1/last-updated.txt';

let pending = null;

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch and index both datasets. Concurrent callers share one in-flight load,
 * and the result is memoised for the life of the page.
 */
export function loadNetwork({ signal } = {}) {
  pending ??= (async () => {
    const [rawStops, services, lastUpdated] = await Promise.all([
      getJson(STOPS_URL, signal),
      getJson(SERVICES_URL, signal),
      fetch(LAST_UPDATED_URL, { signal })
        .then((r) => r.text())
        .catch(() => ''),
    ]);
    return {
      stops: indexStops(rawStops),
      services,
      lastUpdated: lastUpdated.trim().replace(/^"|"$/g, ''),
    };
  })().catch((err) => {
    // Allow a retry after a failure rather than caching the rejection.
    pending = null;
    throw err;
  });
  return pending;
}

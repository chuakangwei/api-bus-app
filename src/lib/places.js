/**
 * Turning what someone types into coordinates.
 *
 * Two sources, because each catches what the other misses:
 *
 *   - OneMap's search API resolves real addresses, postal codes and building
 *     names. It is keyless and sends `Access-Control-Allow-Origin: *`, so a
 *     static page can call it directly. It is not contractually guaranteed for
 *     keyless use, hence the graceful degradation below.
 *   - The bus-stop dataset is already in memory, so matching stop and road
 *     names is instant, works offline, and finds things OneMap ranks poorly
 *     ("Aperia", "Arc 380", or a road name you half-remember).
 */

import { haversine, walkMinutes } from './geo.js';

const ONEMAP_SEARCH = 'https://www.onemap.gov.sg/api/common/elastic/search';

/** Singapore's rough bounding box, used to reject nonsense coordinates. */
const SG_BOUNDS = { minLat: 1.13, maxLat: 1.49, minLng: 103.6, maxLng: 104.1 };

export function withinSingapore({ lat, lng }) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= SG_BOUNDS.minLat &&
    lat <= SG_BOUNDS.maxLat &&
    lng >= SG_BOUNDS.minLng &&
    lng <= SG_BOUNDS.maxLng
  );
}

/** Station-line codes such as EW18, NS1, CC29. */
const LINE_CODE = /^[A-Z]{2,3}\d+$/;
/** A short token with no vowels is an initialism, not a word: CT, MRT, HDB. */
const INITIALISM = /^[BCDFGHJKLMNPQRSTVWXYZ]{2,4}$/;

/**
 * OneMap returns ALL CAPS. Title-casing it naively turns "CT HUB 2" into
 * "Ct Hub 2" and "EW18" into "Ew18", so acronyms and line codes are preserved.
 */
function titleCase(s) {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => {
      // Split off surrounding punctuation so "(EW18)" is still recognised.
      const [, lead, core, tail] = word.match(/^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/) ?? [];
      if (!core) return word;
      const keep = LINE_CODE.test(core) || INITIALISM.test(core);
      const cased = keep ? core : core[0].toUpperCase() + core.slice(1).toLowerCase();
      return `${lead}${cased}${tail}`;
    })
    .join(' ');
}

/**
 * Geocode free text via OneMap. Returns [] rather than throwing, so a failure
 * here degrades to local stop search instead of breaking the search box.
 */
export async function geocode(query, { signal, limit = 6 } = {}) {
  const url =
    `${ONEMAP_SEARCH}?searchVal=${encodeURIComponent(query)}` +
    `&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return [];
    const body = await res.json();
    const rows = Array.isArray(body?.results) ? body.results : [];
    return rows
      .map((r) => ({
        source: 'onemap',
        name: titleCase(r.BUILDING && r.BUILDING !== 'NIL' ? r.BUILDING : r.SEARCHVAL ?? ''),
        detail: titleCase(r.ADDRESS ?? ''),
        postal: r.POSTAL && r.POSTAL !== 'NIL' ? r.POSTAL : '',
        lat: Number.parseFloat(r.LATITUDE),
        lng: Number.parseFloat(r.LONGITUDE),
      }))
      .filter((p) => p.name && withinSingapore(p))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Match a query against stop names and roads.
 *
 * Scored rather than filtered, so "tiong bahru" ranks the station above a stop
 * that merely sits on Tiong Bahru Road. Lower score sorts first.
 */
export function searchStops(stops, query, { limit = 6 } = {}) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const scored = [];
  for (const stop of stops) {
    const name = stop.name.toLowerCase();
    const road = stop.road.toLowerCase();

    let score = null;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (road.startsWith(q)) score = 3;
    else if (road.includes(q)) score = 4;
    else if (stop.code === q) score = 0;
    if (score === null) continue;

    scored.push({
      source: 'stop',
      code: stop.code,
      name: stop.name,
      detail: `Bus stop ${stop.code} · ${stop.road}`,
      lat: stop.lat,
      lng: stop.lng,
      // Shorter names matching the same way are more likely to be the thing meant.
      score: score * 1000 + stop.name.length,
    });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit);
}

/**
 * Combined suggestions for a typed query: exact-ish stop matches first, since
 * they are certain, then geocoded places.
 */
export async function suggest(stops, query, { signal, limit = 8 } = {}) {
  const local = searchStops(stops, query, { limit: 4 });
  const places = await geocode(query, { signal, limit: 6 });

  // Drop geocoded places that duplicate a stop we already offer.
  const seen = new Set(local.map((s) => s.name.toLowerCase()));
  const merged = [...local];
  for (const p of places) {
    if (seen.has(p.name.toLowerCase())) continue;
    seen.add(p.name.toLowerCase());
    merged.push(p);
  }
  return merged.slice(0, limit);
}

/** The nearest stops to a point, with an estimated walk to each. */
export function nearestStops(stops, point, { limit = 6, maxMetres = 800 } = {}) {
  const near = [];
  for (const stop of stops) {
    const metres = haversine(stop, point);
    if (metres <= maxMetres) {
      near.push({ ...stop, metres: Math.round(metres), walkMinutes: walkMinutes(metres) });
    }
  }
  return near.sort((a, b) => a.metres - b.metres).slice(0, limit);
}

/** Browser geolocation as a promise, with a plain-language error. */
export function currentPosition({ timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!globalThis.navigator?.geolocation) {
      reject(new Error('This browser does not support location access.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const point = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (!withinSingapore(point)) {
          reject(new Error('You appear to be outside Singapore, where this data applies.'));
          return;
        }
        resolve({ ...point, accuracy: Math.round(pos.coords.accuracy ?? 0) });
      },
      (err) => {
        const messages = {
          1: 'Location permission denied. Allow it in your browser, or type a place instead.',
          2: 'Location unavailable right now. Try again, or type a place instead.',
          3: 'Locating timed out. Try again, or type a place instead.',
        };
        reject(new Error(messages[err.code] ?? 'Could not determine your location.'));
      },
      { enableHighAccuracy: true, timeout, maximumAge: 30_000 },
    );
  });
}

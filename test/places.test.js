import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchStops, nearestStops, withinSingapore } from '../src/lib/places.js';

const STOPS = [
  { code: '10169', lat: 1.28600, lng: 103.82748, name: 'Tiong Bahru Stn/Plaza', road: 'Tiong Bahru Rd' },
  { code: '10141', lat: 1.28584, lng: 103.83238, name: 'Blk 18', road: 'Tiong Bahru Rd' },
  { code: '07369', lat: 1.31141, lng: 103.86238, name: 'Aft Kallang Bahru', road: 'Lavender St' },
  { code: '07379', lat: 1.31017, lng: 103.86338, name: 'Aperia', road: 'Lavender St' },
];

test('a stop whose name matches ranks above one that merely shares a road', () => {
  const hits = searchStops(STOPS, 'tiong bahru');
  assert.equal(hits[0].code, '10169');
  assert.ok(hits.some((h) => h.code === '10141'), 'the road match should still appear');
});

test('road-only matches are found when nothing matches by name', () => {
  const hits = searchStops(STOPS, 'lavender');
  assert.deepEqual(hits.map((h) => h.code).sort(), ['07369', '07379']);
});

test('a bus stop code resolves directly', () => {
  const hits = searchStops(STOPS, '07369');
  assert.equal(hits[0].code, '07369');
});

test('queries shorter than two characters return nothing', () => {
  assert.deepEqual(searchStops(STOPS, 'a'), []);
  assert.deepEqual(searchStops(STOPS, ' '), []);
});

test('search is case and whitespace insensitive', () => {
  assert.equal(searchStops(STOPS, '  APERIA ')[0].code, '07379');
});

test('an unmatched query returns nothing rather than everything', () => {
  assert.deepEqual(searchStops(STOPS, 'zzzznotathing'), []);
});

test('nearestStops orders by distance and respects the radius', () => {
  const near = nearestStops(STOPS, { lat: 1.31100, lng: 103.86280 }, { maxMetres: 400 });
  assert.equal(near[0].code, '07369');
  assert.ok(near.every((s) => s.metres <= 400));
  assert.ok(!near.some((s) => s.code === '10169'), 'Tiong Bahru is far outside 400 m');
});

test('nearestStops attaches a walk estimate', () => {
  const near = nearestStops(STOPS, { lat: 1.31141, lng: 103.86238 }, { maxMetres: 200 });
  assert.equal(near[0].metres, 0);
  assert.equal(typeof near[0].walkMinutes, 'number');
});

test('coordinates outside Singapore are rejected', () => {
  assert.equal(withinSingapore({ lat: 1.3, lng: 103.8 }), true);
  assert.equal(withinSingapore({ lat: 51.5, lng: -0.12 }), false);
  assert.equal(withinSingapore({ lat: NaN, lng: 103.8 }), false);
});

// --- OneMap label formatting ---

import { geocode } from '../src/lib/places.js';

test('geocode returns [] rather than throwing when the network fails', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  try {
    assert.deepEqual(await geocode('anything'), []);
  } finally {
    globalThis.fetch = original;
  }
});

test('geocode preserves acronyms and line codes in labels', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve({
      ok: true,
      json: async () => ({
        results: [
          {
            SEARCHVAL: 'REDHILL MRT STATION (EW18)',
            BUILDING: 'NIL',
            ADDRESS: '90 TIONG BAHRU ROAD SINGAPORE 168731',
            POSTAL: '168731',
            LATITUDE: '1.2896',
            LONGITUDE: '103.8168',
          },
          {
            SEARCHVAL: 'CT HUB 2',
            BUILDING: 'CT HUB 2',
            ADDRESS: '114 LAVENDER STREET CT HUB 2 SINGAPORE 338729',
            POSTAL: '338729',
            LATITUDE: '1.3115',
            LONGITUDE: '103.8633',
          },
        ],
      }),
    });
  try {
    const out = await geocode('x');
    assert.equal(out[0].name, 'Redhill MRT Station (EW18)');
    assert.equal(out[1].name, 'CT Hub 2'); // acronym kept, rest title-cased
  } finally {
    globalThis.fetch = original;
  }
});

test('geocode drops results outside Singapore', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve({
      ok: true,
      json: async () => ({
        results: [
          { SEARCHVAL: 'LONDON', BUILDING: 'NIL', ADDRESS: 'UK', POSTAL: 'NIL', LATITUDE: '51.5', LONGITUDE: '-0.12' },
        ],
      }),
    });
  try {
    assert.deepEqual(await geocode('london'), []);
  } finally {
    globalThis.fetch = original;
  }
});

test('currentPosition rejects clearly when geolocation is unavailable', async () => {
  const { currentPosition } = await import('../src/lib/places.js');
  await assert.rejects(currentPosition(), /does not support location/);
});

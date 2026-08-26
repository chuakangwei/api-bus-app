import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseArrival, parseArrivals, loadLabel } from '../src/lib/arrivals.js';

const NOW = new Date('2026-08-26T13:30:00+08:00').getTime();

const REAL_ARRIVAL = {
  time: '2026-08-26T13:32:30+08:00',
  duration_ms: 140786,
  lat: 1.315494,
  lng: 103.90594816666666,
  load: 'SDA',
  feature: 'WAB',
  type: 'SD',
  visit_number: 1,
  origin_code: '77009',
  destination_code: '77009',
  monitored: 1,
};

test('countdown is recomputed from time, not the stale duration_ms', () => {
  const a = normaliseArrival(REAL_ARRIVAL, NOW);
  assert.equal(a.minutesAway, 2); // 2.5 min floors to 2 -- "at least 2 min"
  assert.equal(a.secondsAway, 150);
});

test('a bus that already passed yields a negative countdown', () => {
  const later = new Date('2026-08-26T13:40:00+08:00').getTime();
  assert.equal(normaliseArrival(REAL_ARRIVAL, later).minutesAway, -8);
});

test('null and malformed arrivals are dropped, not crashed on', () => {
  assert.equal(normaliseArrival(null, NOW), null);
  assert.equal(normaliseArrival({}, NOW), null);
  assert.equal(normaliseArrival({ time: 'not-a-date' }, NOW), null);
});

test('untracked buses (lat/lng of 0) report no position', () => {
  const untracked = { ...REAL_ARRIVAL, lat: 0, lng: 0, monitored: 0 };
  const a = normaliseArrival(untracked, NOW);
  assert.equal(a.position, null);
  assert.equal(a.live, false);
});

test('tracked buses expose a position and are marked live', () => {
  const a = normaliseArrival(REAL_ARRIVAL, NOW);
  assert.deepEqual(a.position, { lat: REAL_ARRIVAL.lat, lng: REAL_ARRIVAL.lng });
  assert.equal(a.live, true);
});

test('feature is only wheelchair-accessible when exactly WAB', () => {
  assert.equal(normaliseArrival({ ...REAL_ARRIVAL, feature: '' }, NOW).wheelchair, false);
  assert.equal(normaliseArrival(REAL_ARRIVAL, NOW).wheelchair, true);
});

test('unknown load codes degrade to Unknown rather than undefined', () => {
  assert.equal(loadLabel('SEA'), 'Seats available');
  assert.equal(loadLabel(undefined), 'Unknown');
  assert.equal(loadLabel('XXX'), 'Unknown');
});

test('an empty services array (unknown stop code) parses to no entries', () => {
  assert.deepEqual(parseArrivals({ services: [] }, NOW), []);
  assert.deepEqual(parseArrivals({}, NOW), []);
  assert.deepEqual(parseArrivals(null, NOW), []);
});

test('null next3 is dropped so arrivals stays dense', () => {
  const parsed = parseArrivals(
    { services: [{ no: '15', operator: 'GAS', next: REAL_ARRIVAL, next2: REAL_ARRIVAL, next3: null }] },
    NOW,
  );
  assert.equal(parsed[0].arrivals.length, 2);
});

test('the legacy subsequent alias is ignored, not double-counted', () => {
  const parsed = parseArrivals(
    { services: [{ no: '15', next: REAL_ARRIVAL, subsequent: REAL_ARRIVAL, next2: null, next3: null }] },
    NOW,
  );
  assert.equal(parsed[0].arrivals.length, 1);
});

test('a service listed twice in one response is preserved as two entries', () => {
  const parsed = parseArrivals(
    { services: [{ no: '13', next: REAL_ARRIVAL }, { no: '13', next: REAL_ARRIVAL }] },
    NOW,
  );
  assert.equal(parsed.length, 2);
});

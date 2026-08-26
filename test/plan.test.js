import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  indexStops,
  stopsWithin,
  findDirect,
  planDirect,
  legsFromDirect,
} from '../src/lib/plan.js';

/**
 * A tiny synthetic network. Stops sit on a west-to-east line at a constant
 * latitude, roughly 300 m apart, so distances are predictable.
 */
const RAW_STOPS = {
  A1: [103.8000, 1.3000, 'Alpha', 'First Rd'],
  A2: [103.8027, 1.3000, 'Alpha Opp', 'First Rd'],
  B1: [103.8100, 1.3000, 'Bravo', 'Second Rd'],
  C1: [103.8200, 1.3000, 'Charlie', 'Third Rd'],
  D1: [103.9000, 1.3000, 'Delta', 'Far Rd'],
};

const SERVICES = {
  // Runs A1 -> B1 -> C1 one way, and the reverse the other.
  10: { name: 'Alpha ⇄ Charlie', routes: [['A1', 'B1', 'C1'], ['C1', 'B1', 'A1']] },
  // Only ever goes away from C1.
  20: { name: 'Alpha ⇄ Delta', routes: [['A1', 'D1'], ['D1', 'A1']] },
  // A loop touching both, but reaching C1 before A1.
  30: { name: 'Loop ⟲', routes: [['C1', 'A1', 'B1']] },
};

const stops = indexStops(RAW_STOPS);
const at = (code) => {
  const s = stops.find((x) => x.code === code);
  return { name: code, lat: s.lat, lng: s.lng };
};

test('indexStops reads lng-first rows into named fields', () => {
  const a1 = stops.find((s) => s.code === 'A1');
  assert.deepEqual(a1, { code: 'A1', lat: 1.3, lng: 103.8, name: 'Alpha', road: 'First Rd' });
});

test('indexStops skips malformed rows instead of producing junk', () => {
  const out = indexStops({ good: [103.8, 1.3, 'N', 'R'], bad: [103.8, 1.3], worse: null });
  assert.deepEqual(out.map((s) => s.code), ['good']);
});

test('stopsWithin finds stops inside the walking budget and excludes the rest', () => {
  const near = stopsWithin(stops, [at('A1')], 8);
  assert.ok(near.has('A1'));
  assert.ok(near.has('A2'), 'the 300 m stop should be within an 8 min walk');
  assert.ok(!near.has('D1'), 'a stop 11 km away must not be included');
});

test('stopsWithin reports distance to the closest anchor', () => {
  const near = stopsWithin(stops, [at('D1'), at('A1')], 8);
  assert.equal(near.get('A1').metresToAnchor, 0);
  assert.equal(near.get('A1').nearestAnchor, 'A1');
});

test('a per-stop penalty raises the walk and can breach the preference', () => {
  const near = stopsWithin(stops, [at('A1')], 5, { A2: 4 });
  const a2 = near.get('A2');
  assert.equal(a2.walkPenalty, 4);
  assert.ok(a2.walkMinutes > 5);
  assert.equal(a2.exceedsWalkPreference, true);
});

test('a service is only direct when the origin precedes the destination', () => {
  const origin = stopsWithin(stops, [at('A1')], 4);
  const dest = stopsWithin(stops, [at('C1')], 4);
  const hits = findDirect(SERVICES, origin, dest);
  // 10 qualifies (A1 before C1 in direction 0). 20 never reaches C1.
  // 30 reaches C1 before A1, so it is the wrong way round.
  assert.deepEqual([...new Set(hits.map((h) => h.service))], ['10']);
  assert.equal(hits[0].direction, 0);
  assert.equal(hits[0].stopsTravelled, 2);
});

test('the reverse direction is found when the journey is reversed', () => {
  const origin = stopsWithin(stops, [at('C1')], 4);
  const dest = stopsWithin(stops, [at('A1')], 4);
  const hits = findDirect(SERVICES, origin, dest);
  const ten = hits.find((h) => h.service === '10');
  assert.equal(ten.direction, 1, 'should use the return pattern');
});

test('a loop service counts only if it reaches the destination after boarding', () => {
  // Boarding at A1 (index 1), B1 is at index 2 -- valid on the loop.
  const hits = findDirect(SERVICES, stopsWithin(stops, [at('A1')], 4), stopsWithin(stops, [at('B1')], 4));
  assert.ok(hits.some((h) => h.service === '30'));
});

test('only the closest alighting stop is kept per service and boarding stop', () => {
  // Both A1 and A2 are within reach of the destination anchor at A1.
  const hits = findDirect(
    SERVICES,
    stopsWithin(stops, [at('C1')], 4),
    stopsWithin(stops, [at('A1')], 8),
  );
  const forTen = hits.filter((h) => h.service === '10');
  assert.equal(forTen.length, 1);
  assert.equal(forTen[0].alightStop, 'A1', 'A1 is nearer the anchor than A2');
});

test('planDirect returns nothing when either end has no stops in range', () => {
  const far = [{ name: 'Nowhere', lat: 1.48, lng: 104.05 }];
  const out = planDirect({ stops, services: SERVICES, originAnchors: far, destAnchors: [at('C1')] });
  assert.deepEqual(out.direct, []);
  assert.deepEqual(out.detours, []);
});

test('planDirect sorts by estimated time and attaches an estimate', () => {
  const out = planDirect({
    stops,
    services: SERVICES,
    originAnchors: [at('A1')],
    destAnchors: [at('C1')],
    originWalkMin: 4,
    destWalkMin: 4,
  });
  assert.ok(out.direct.length > 0);
  assert.ok(Number.isFinite(out.direct[0].estimatedMinutes));
});

test('legsFromDirect groups options by boarding stop', () => {
  const out = planDirect({
    stops,
    services: SERVICES,
    originAnchors: [at('A1')],
    destAnchors: [at('B1')],
    originWalkMin: 8,
    destWalkMin: 4,
  });
  const legs = legsFromDirect(out.direct);
  assert.ok(legs.length >= 1);
  for (const leg of legs) {
    assert.ok(leg.stopCode);
    assert.ok(leg.services.length > 0);
    assert.equal(typeof leg.walkMinutes, 'number');
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journeyCost, rejectDetours, MIN_PER_STOP } from '../src/lib/journey.js';

const opt = (stopsTravelled, walkMinutes, service = 'x') => ({
  service,
  stopsTravelled,
  alight: { walkMinutes },
});

test('journey cost combines ride and final walk', () => {
  assert.equal(journeyCost({ stopsTravelled: 10, alightWalkMinutes: 5 }), 10 * MIN_PER_STOP + 5);
});

test('a long ride that lands at the door beats a short ride plus a long walk', () => {
  // The real Redhill case: 961 is 23 stops + 13 min walk; 145 is 32 stops + 1 min.
  const { keep, drop } = rejectDetours([opt(23, 13, '961'), opt(32, 1, '145')]);
  assert.equal(drop.length, 0);
  assert.deepEqual(keep.map((o) => o.service).sort(), ['145', '961']);
});

test('a ride that is worse on both ride time and walk is dropped', () => {
  // The real Tiong Bahru case: 175 is 19 stops + 7 min; 145 is 29 stops + 10 min.
  const { keep, drop } = rejectDetours([opt(19, 7, '175'), opt(29, 10, '145')]);
  assert.deepEqual(keep.map((o) => o.service), ['175']);
  assert.deepEqual(drop.map((o) => o.service), ['145']);
});

test('an absurdly long ride is dropped even with no walk at all', () => {
  const { keep, drop } = rejectDetours([opt(10, 12, 'a'), opt(60, 0, 'b')]);
  assert.deepEqual(keep.map((o) => o.service), ['a']);
  assert.deepEqual(drop.map((o) => o.service), ['b']);
});

test('the best option always survives, however poor', () => {
  const { keep } = rejectDetours([opt(38, 20, 'only')]);
  assert.equal(keep.length, 1);
});

test('an estimated door-to-door time is attached to every option', () => {
  const { keep } = rejectDetours([opt(20, 5, 'a')]);
  assert.equal(keep[0].estimatedMinutes, Math.round(20 * MIN_PER_STOP + 5));
});

test('no options in, no options out', () => {
  assert.deepEqual(rejectDetours([]), { keep: [], drop: [] });
});

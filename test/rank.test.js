import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankOptions } from '../src/lib/rank.js';

/** Build a minimal parsed-arrival entry at a given number of minutes away. */
const entry = (service, ...minutesAway) => ({
  service,
  operator: 'SBST',
  arrivals: minutesAway.map((m) => ({
    secondsAway: m * 60,
    minutesAway: m,
    live: true,
    load: 'SEA',
  })),
});

const LEGS = [
  { stopCode: '07361', stopName: 'Bef Kallang Bahru', walkMinutes: 3, services: ['13', '133'] },
  { stopCode: '07369', stopName: 'Aft Kallang Bahru', walkMinutes: 5, services: ['13', '145'] },
];

test('a bus arriving sooner than the walk plus buffer is not catchable', () => {
  // 3 min walk + 1 min buffer = 4 min needed; bus is 2 min away.
  const { options, best } = rankOptions({
    legs: [LEGS[0]],
    arrivalsByStop: { '07361': [entry('13', 2)] },
  });
  assert.equal(options[0].catchable, false);
  assert.equal(best, null);
});

test('a bus with enough lead time is catchable and becomes the pick', () => {
  const { best } = rankOptions({
    legs: [LEGS[0]],
    arrivalsByStop: { '07361': [entry('13', 9)] },
  });
  assert.equal(best.service, '13');
  assert.equal(best.spareMinutes, 5); // 9 - 3 walk - 1 buffer
});

test('the pick is the soonest CATCHABLE bus, not the soonest bus', () => {
  // 145 is sooner but the far stop is a 5 min walk; 133 at the near stop wins.
  const { options, best } = rankOptions({
    legs: LEGS,
    arrivalsByStop: { '07361': [entry('133', 8)], '07369': [entry('145', 4)] },
  });
  assert.equal(options[0].service, '145'); // still listed first by time
  assert.equal(options[0].catchable, false);
  assert.equal(best.service, '133');
});

test('buses that already departed are dropped past the grace period', () => {
  const { options } = rankOptions({
    legs: [LEGS[0]],
    arrivalsByStop: { '07361': [entry('13', -5, 12)] },
  });
  assert.equal(options.length, 1);
  assert.equal(options[0].arrival.minutesAway, 12);
});

test('a bus that only just left is still shown, to explain the wait', () => {
  const { options } = rankOptions({
    legs: [LEGS[0]],
    arrivalsByStop: { '07361': [entry('13', 0)] },
  });
  assert.equal(options.length, 1);
});

test('services that do not reach the destination are excluded entirely', () => {
  // 61 stops at 07369 but is not in that leg's service list.
  const { options } = rankOptions({
    legs: [LEGS[1]],
    arrivalsByStop: { '07369': [entry('61', 10), entry('145', 12)] },
  });
  assert.deepEqual(options.map((o) => o.service), ['145']);
});

test('a stop with no live data at all does not break ranking', () => {
  const { options, best } = rankOptions({
    legs: LEGS,
    arrivalsByStop: { '07361': [entry('13', 10)] }, // 07369 missing entirely
  });
  assert.equal(options.length, 1);
  assert.equal(best.service, '13');
});

test('each stop is judged independently before same-vehicle deduping', () => {
  const { options, allOptions } = rankOptions({
    legs: LEGS,
    arrivalsByStop: { '07361': [entry('13', 5)], '07369': [entry('13', 5)] },
  });
  // Same arrival time (5 min), different walks: 3 min walk makes it, 5 min does not.
  assert.deepEqual(allOptions.map((o) => o.catchable).sort(), [false, true]);
  // One vehicle, so one row survives -- the stop that is actually catchable.
  assert.equal(options.length, 1);
  assert.equal(options[0].stopCode, '07361');
  assert.equal(options[0].catchable, true);
});

test('options are ordered by arrival time across all stops', () => {
  const { options } = rankOptions({
    legs: LEGS,
    arrivalsByStop: { '07361': [entry('13', 20, 30)], '07369': [entry('145', 10)] },
  });
  assert.deepEqual(options.map((o) => o.arrival.minutesAway), [10, 20, 30]);
});

// --- same-vehicle deduping ---

/** Arrival carrying a destination code, so dedupe can tell vehicles apart. */
const arr = (minutesAway, destinationCode = '99999') => ({
  secondsAway: minutesAway * 60,
  minutesAway,
  live: true,
  load: 'SEA',
  destinationCode,
});

test('one bus passing both origin stops is listed once, not twice', () => {
  const { options } = rankOptions({
    legs: LEGS,
    arrivalsByStop: {
      '07361': [{ service: '13', operator: 'SBST', arrivals: [arr(11)] }],
      '07369': [{ service: '13', operator: 'SBST', arrivals: [arr(12)] }],
    },
  });
  assert.equal(options.length, 1);
  // The 3 min walk leaves more slack than the 5 min walk, so the near stop wins.
  assert.equal(options[0].stopCode, '07361');
});

test('deduping keeps the stop with more slack, not merely the earlier arrival', () => {
  const { options } = rankOptions({
    legs: LEGS,
    arrivalsByStop: {
      // Far stop sees the bus first, but a 5 min walk leaves less room.
      '07369': [{ service: '13', operator: 'SBST', arrivals: [arr(8)] }],
      '07361': [{ service: '13', operator: 'SBST', arrivals: [arr(9)] }],
    },
  });
  assert.equal(options.length, 1);
  assert.equal(options[0].stopCode, '07361');
  assert.equal(options[0].spareMinutes, 5);
});

test('different destination codes are different vehicles and both survive', () => {
  const { options } = rankOptions({
    legs: [LEGS[0]],
    arrivalsByStop: {
      '07361': [
        { service: '13', operator: 'SBST', arrivals: [arr(10, '11111')] },
        { service: '13', operator: 'SBST', arrivals: [arr(12, '22222')] },
      ],
    },
  });
  assert.equal(options.length, 2);
});

test('later runs of the same service are kept as separate rows', () => {
  const { options } = rankOptions({
    legs: [LEGS[0]],
    arrivalsByStop: {
      '07361': [{ service: '13', operator: 'SBST', arrivals: [arr(10), arr(25), arr(40)] }],
    },
  });
  assert.deepEqual(options.map((o) => o.arrival.minutesAway), [10, 25, 40]);
});

test('allOptions still exposes the pre-dedupe rows', () => {
  const { options, allOptions } = rankOptions({
    legs: LEGS,
    arrivalsByStop: {
      '07361': [{ service: '13', operator: 'SBST', arrivals: [arr(11)] }],
      '07369': [{ service: '13', operator: 'SBST', arrivals: [arr(12)] }],
    },
  });
  assert.equal(options.length, 1);
  assert.equal(allOptions.length, 2);
});

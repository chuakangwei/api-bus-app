/**
 * Comparing whole journeys, not ride lengths.
 *
 * A stop-count threshold is the wrong way to reject a detour. Riding nine extra
 * stops to save twelve minutes of walking along an arterial is a fair trade, and
 * a blunt cap would throw it away. So options are scored end to end and judged
 * against the best option for that destination rather than an absolute rule.
 */

/**
 * Rough minutes per stop for an urban bus, including dwell time and traffic.
 * The busrouter dataset carries no timings, so this is the only lever available
 * for turning a stop count into something comparable with a walk.
 */
export const MIN_PER_STOP = 1.3;

/**
 * How much worse than the best option a journey may be and still be offered.
 * Generous, because "one bus, longer ride" genuinely suits some trips -- rain,
 * luggage, or simply not wanting to walk an arterial.
 */
export const TOLERANCE_MIN = 10;

/**
 * Hard ceiling regardless of comparison, so a destination with only terrible
 * direct options says so instead of recommending an hour-long ride.
 */
export const MAX_STOPS = 40;

/** Estimated door-to-door minutes after boarding: ride, then the final walk. */
export function journeyCost({ stopsTravelled, alightWalkMinutes }) {
  return stopsTravelled * MIN_PER_STOP + alightWalkMinutes;
}

/**
 * Split options into those worth offering and those that are genuinely detours.
 *
 * @param {Array} options - each needs { stopsTravelled, alight: { walkMinutes } }
 * @returns {{ keep: Array, drop: Array }}
 */
export function rejectDetours(options) {
  if (options.length === 0) return { keep: [], drop: [] };

  const scored = options.map((o) => ({
    option: o,
    cost: journeyCost({
      stopsTravelled: o.stopsTravelled,
      alightWalkMinutes: o.alight.walkMinutes,
    }),
  }));

  const bestCost = Math.min(...scored.map((s) => s.cost));
  const keep = [];
  const drop = [];
  for (const s of scored) {
    const withinTolerance = s.cost - bestCost <= TOLERANCE_MIN;
    const withinCap = s.option.stopsTravelled <= MAX_STOPS;
    (withinTolerance && withinCap ? keep : drop).push(
      Object.assign(s.option, { estimatedMinutes: Math.round(s.cost) }),
    );
  }
  return { keep, drop };
}

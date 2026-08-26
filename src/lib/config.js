/** Fixed configuration: where you start from, and where you go. */

/** CT Hub 2, 114 Lavender Street, Singapore 338729 (OneMap geocode). */
export const ORIGIN = {
  name: 'CT Hub 2',
  address: '114 Lavender Street, S338729',
  lat: 1.311588,
  lng: 103.863375,
};

/**
 * The four usable stops, as two opposing pairs on Lavender Street. Direction
 * matters: boarding the wrong pair takes you the opposite way.
 *
 * `walkMinutes` is a hand-set constant, not a computed distance. The far pair
 * includes time to cross Lavender Street at the signalised junction, which a
 * straight-line estimate would miss entirely. Correct these values if you time
 * the walk yourself -- they are the one input the app cannot derive.
 */
export const ORIGIN_STOPS = [
  { code: '07361', name: 'Bef Kallang Bahru', road: 'Lavender St', heading: 'NW', walkMinutes: 3 },
  { code: '07371', name: 'Aft Kallang Rd', road: 'Lavender St', heading: 'NW', walkMinutes: 4 },
  { code: '07369', name: 'Aft Kallang Bahru', road: 'Lavender St', heading: 'SE', walkMinutes: 5 },
  { code: '07379', name: 'Aperia / Bef Kallang Rd', road: 'Lavender St', heading: 'SE', walkMinutes: 5 },
];

/**
 * Saved destinations. Each is an anchor point plus how far you are willing to
 * walk at the far end -- so a destination is a *catchment* of acceptable
 * alighting stops, not a single stop. `fallback` is shown when no direct bus
 * reaches the catchment.
 */
export const DESTINATIONS = [
  {
    id: 'tiong-bahru',
    name: 'Tiong Bahru',
    anchors: [
      { name: 'Tiong Bahru MRT (EW17)', lat: 1.28597, lng: 103.82700 },
      { name: 'Tiong Bahru Market', lat: 1.28550, lng: 103.83240 },
    ],
    maxWalkMinutes: 10,
    // Direct buses land at the edges of the estate, never on the Tiong Bahru Rd
    // trunk -- that belongs to 5/16/33/63/121/122/123/195/851, none of which
    // serve CT Hub 2. So for the MRT itself, a transfer genuinely beats the
    // direct options, and saying so is more useful than hiding it.
    fallback: {
      note:
        'Direct buses only reach the edge of the estate. For Tiong Bahru MRT itself, ' +
        '61 then 63 (change at Bef Crawford Bridge, 1 stop away) is 18 stops and ' +
        'drops you at the station door. Or take 107 two stops to Lavender MRT and ' +
        'ride the East-West line straight through.',
      transfer: {
        legs: [
          { service: '61', from: '07379', to: '01339', stops: 1 },
          { service: '63', from: '01339', to: '10161', stops: 16 },
        ],
        alightName: 'Opp Tiong Bahru Stn/Plaza',
        metresToStation: 35,
      },
    },
  },
  {
    id: 'redhill-mrt',
    name: 'Redhill MRT',
    // A single anchor: the station itself. Stop 10209 sits 16 m from the
    // entrance, so anything reaching it is effectively door-to-door.
    anchors: [{ name: 'Redhill MRT (EW18)', lat: 1.28966, lng: 103.81682 }],
    maxWalkMinutes: 10,
    // Redhill is on the same East-West line as Lavender, so rail is the fast
    // route and the direct buses are both ~43 min. Worth saying outright.
    fallback: {
      note:
        'Both direct buses take about 45 minutes. Rail is much faster: 107 two ' +
        'stops to Lavender MRT, then the East-West line seven stations straight ' +
        'to Redhill, no change. Of the buses, 145 is a longer ride but stops 47 m ' +
        'from the station; 961 is shorter but leaves a 13 min walk across Jln Bt Merah.',
    },
  },
];

/**
 * Extra minutes added to specific final walks where a straight-line estimate
 * with a uniform circuity factor is too optimistic, because the walk crosses
 * something a crow would not care about. Verified by inspecting the junctions.
 */
export const WALK_PENALTY_MINUTES = {
  // Crosses the wide signalised Outram Rd / Tiong Bahru Rd junction.
  '06069': 2,
  // Crosses Jln Bt Merah, a divided arterial, then works north via Kim Tian.
  '10501': 3,
  '10071': 3,
  '10081': 3,
  // Also on Jln Bt Merah; the walk to Redhill Stn crosses it.
  '10101': 3,
};

# api-bus-app

A direct-bus departure planner for Singapore.

Live at **https://chuakangwei.github.io/api-bus-app/**

It answers one question: *which bus do I walk out and catch right now?* — between any
two places, accounting for the walk to the stop, so it never recommends a bus you
cannot physically reach.

## How it works

`arrivelah2` only answers "when do buses arrive at stop X" — it has no concept of
destinations or journeys. So the app has two layers:

1. **Route layer.** The busrouter.sg stop and route datasets (~133 KB gzipped, cached
   24 h upstream) are loaded once, then every query is planned in the browser: which
   services connect a stop near you to a stop near your destination, *in the correct
   direction of travel*.
2. **Timing layer.** One `arrivelah2` call per boarding stop, polled every 15 s. No API
   key and no server anywhere in the stack.

Ranking is **leave-now soonest**: options are listed by real arrival time, and each is
judged catchable or not against `walk time + 1 min buffer`. The recommendation is the
soonest option you can actually make. Buses you have already missed stay visible but
greyed — seeing them is what explains the recommendation.

## Choosing where you are and where you are going

Both endpoints are free-form. Three ways to set either one:

- **GPS** — one tap, labelled by the nearest stop, with the accuracy shown.
- **Typing** — resolved by two sources at once. The in-memory stop dataset matches stop
  and road names instantly and offline; **OneMap** resolves real addresses, postal codes
  and building names. OneMap is keyless and CORS-open, so a static page can call it —
  but that is not a contractual guarantee, so a failure degrades to stop search rather
  than breaking the field.
- **Saved chips** — one tap for a regular origin or destination, from `src/lib/config.js`.

The **max walk to stop** slider is the most consequential control. It decides how far the
planner will look for a boarding stop, and widening it can change the answer completely
— see the Crawford Bridge note below.

## Running it

```bash
npm install
npm run serve        # http://localhost:8099
npm test             # 57 unit tests
npm run lint         # syntax gate

npm start                                # config defaults
npm start -- "CT Hub 2" "Redhill MRT"    # any two places
npm start -- 338729 "Tiong Bahru"        # postal codes work
WALK_MIN=12 npm start                    # widen the walk budget
```

`index.html` must be served over HTTP — `file://` breaks both module imports and `fetch`.

## Architecture

| File | Role |
| --- | --- |
| `src/lib/plan.js` | The planner. Catchment, direction-valid pairing, journey assembly. |
| `src/lib/journey.js` | Detour rejection by estimated door-to-door time. |
| `src/lib/rank.js` | Leave-now-soonest ranking, catchability, same-vehicle deduping. |
| `src/lib/arrivals.js` | `arrivelah2` parsing and its many edge cases. |
| `src/lib/places.js` | Geocoding, stop search, nearest stops, geolocation. |
| `src/lib/data.js` | Dataset loading and memoisation. |
| `src/lib/geo.js` | Haversine, walk-time model. |
| `src/lib/config.js` | Saved places and per-stop walk penalties. |
| `app.js` | Browser UI. `src/index.js` | Terminal UI. |

Both front ends call the same planner, so the CLI and the web app cannot disagree.

## Things the data taught us

**The walk budget changes the answer more than anything else.** With the origin pinned to
the four Lavender Street stops, no bus reaches Tiong Bahru MRT at all — that trunk
belongs to services 5/16/33/63/121/122/123/195/851, none of which serve Lavender Street.
Allow an 8-minute walk and **63 from Bef Crawford Bridge goes there directly**, 16 stops,
alighting 35 m from the station, about 22 minutes. That is roughly ten minutes faster
than the best option available from the Lavender Street stops, and it needs no transfer.
An artificially narrow origin catchment does not merely miss options; it produces
confidently wrong advice.

**Detours must be judged end to end, not by stop count.** Redhill MRT has two direct
options that look nothing alike and take almost exactly the same time: 961 is 23 stops
but leaves a 13 min walk across Jln Bt Merah, while 145 is 32 stops and stops 47 m from
the station entrance — both about 43 minutes from the Lavender Street stops. A fixed
stop-count cap discarded the one that lands at the door. `journey.js` scores
`stops × 1.3 min + final walk` and keeps anything within 10 min of the best option, which
correctly keeps 145 for Redhill and still drops it for Tiong Bahru, where it is worse on
both ride *and* walk.

**Straight lines lie about walking.** A uniform circuity factor of 1.3 understates any
walk that crosses a divided arterial or a wide signalised junction, so
`WALK_PENALTY_MINUTES` corrects specific stops. Without it the app promises a 10-minute
walk that is really 13.

## Deploying

`.github/workflows/pages.yml` publishes the repo root to GitHub Pages on every push to
`main`, gated on lint and tests so a broken push cannot reach the live site. It stays
dispatchable via `gh workflow run pages.yml`.

## Known limits

- **Direct buses only.** No transfers, and no rail. When there is no direct option the
  app says so rather than guessing.
- **Ride times are estimated**, not scheduled — the dataset carries no timings, so
  `1.3 min/stop` is the only lever available for comparing a long ride against a long
  walk. Treat totals as rough.
- **Polling is capped** at the best 6 boarding stops. A wide walk budget can surface a
  dozen candidates, and `arrivelah2` is an unpaid courtesy service.
- **`arrivelah2` has no SLA** and no stated fair-use policy; its v1 predecessor currently
  returns HTTP 500. Self-hosting is one MIT-licensed serverless function and a free
  DataMall key.
- Route data is a snapshot that upstream refreshes periodically; the footer shows its date.

## Attribution

Arrivals via [arrivelah](https://github.com/cheeaun/arrivelah) (MIT); stop and route data
via [busrouter.sg](https://data.busrouter.sg/); search via
[OneMap](https://www.onemap.gov.sg/).

Contains information from LTA DataMall, made available under the
[Singapore Open Data Licence v1.0](https://datamall.lta.gov.sg/content/datamall/en/SingaporeOpenDataLicence.html).
Also contains data © [OneMap](https://www.onemap.gov.sg/legal/termsofuse.html) and
© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
Not affiliated with or endorsed by any transport agency.

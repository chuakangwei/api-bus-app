# api-bus-app

A live bus departure board for **CT Hub 2** (114 Lavender Street, Singapore 338729).

It answers one question: *which bus do I walk out and catch right now?* — accounting
for the walk to the stop, so it never recommends a bus you cannot physically reach.

## How it works

`arrivelah2` only answers "when do buses arrive at stop X" — it has no concept of
destinations or journeys. So the app has two layers:

1. **Route layer (build time).** `scripts/build-routes.mjs` pulls the busrouter.sg
   stop and route datasets and works out which services connect a CT Hub 2 stop to a
   destination *in the correct direction of travel*. The result is baked into
   `data/routes.json` (~6 KB), so the browser never downloads the 573 KB of raw data.
2. **Timing layer (runtime).** One `arrivelah2` call per boarding stop, polled every
   15 s. No API key, no server, no build step.

Ranking is **leave-now soonest**: options are listed by real arrival time, and each is
judged catchable or not against `walk time + 1 min buffer`. The recommendation is the
soonest option you can actually make. Buses you have already missed stay visible but
greyed out — seeing them is what explains the recommendation.

## Running it

```bash
npm install
npm run build:routes   # regenerate data/routes.json from busrouter.sg
npm run serve          # http://localhost:8099
npm start              # same board, in the terminal
npm test               # unit tests
npm run lint           # syntax gate
```

`index.html` must be served over HTTP — opening it via `file://` breaks both ES module
imports and `fetch`.

## Configuration

Everything you would want to change lives in `src/lib/config.js`:

- `ORIGIN_STOPS` — the four Lavender Street stops and the **walk time to each**. These
  are hand-set constants, not computed distances, because a straight line misses the
  signalised crossing on Lavender Street. Correct them if you time the walk yourself;
  they are the one input the app cannot derive.
- `DESTINATIONS` — each is an anchor point (or several) plus `maxWalkMinutes`. A
  destination is therefore a *catchment* of acceptable alighting stops, not a single
  stop. Add one and re-run `npm run build:routes`.
- `src/lib/journey.js` — how detours are rejected. Options are scored end to end
  (`stops × 1.3 min + final walk`) and kept if they are within 10 min of the best
  option for that destination. A fixed stop-count cap would wrongly discard a long
  ride that drops you at the door; see the Redhill note below.
- `WALK_PENALTY_MINUTES` — per-stop corrections where a uniform circuity factor is too
  optimistic because the walk crosses a major road.

## Findings worth knowing

These came out of the route data and shaped the defaults:

- **No bus from CT Hub 2 reaches Tiong Bahru MRT.** The Tiong Bahru Road trunk belongs
  to services 5/16/33/63/121/122/123/195/851, none of which serve Lavender Street. The
  service sets are provably disjoint.
- **175 is the one defensible direct option** — 19 stops from Aperia/Bef Kallang Rd to
  Aft Furama RiverFront on Outram Rd, then a ~7 min walk to Tiong Bahru Market. The
  corridor is coherent (Bugis → Dhoby Ghaut → Orchard → Great World → Outram), but it
  passes through Orchard, so peak-hour traffic is its weak point.
- **Service 145 is deliberately suppressed.** It technically reaches Tiong Bahru Road,
  but only after 29 stops via Tanjong Pagar, HarbourFront and Telok Blangah, arriving
  at the wrong end of the estate. Offering it as "your direct bus" would mislead.
- **For Tiong Bahru MRT itself, a transfer beats every direct option**: 61 then 63,
  changing at Bef Crawford Bridge (one stop from the office), 18 stops total, alighting
  35 m from the station. The app surfaces this as a note rather than pretending otherwise.

### Redhill MRT

- Two direct options, and they are **near-identical end to end (~43 min)** despite
  looking very different: 961 is 23 stops but leaves a 13 min walk across Jln Bt Merah,
  while 145 is 32 stops and stops 47 m from the station entrance.
- This pair is why detour rejection compares whole journeys rather than counting stops.
  145 is correctly suppressed for Tiong Bahru (worse on both ride *and* walk) and
  correctly kept for Redhill (much worse ride, far better walk).
- **Rail is genuinely faster**: Redhill is on the same East-West line as Lavender, so
  107 two stops to Lavender MRT then seven stations to Redhill beats both buses. The
  app says so rather than pretending the bus is the answer.

## Deploying

Live at **https://chuakangwei.github.io/api-bus-app/**

`.github/workflows/pages.yml` publishes the repo root to GitHub Pages on every push to
`main`, gated on lint and tests so a broken push cannot reach the live site. It stays
dispatchable (`gh workflow run pages.yml`) for redeploying without a code change —
useful because the workflow regenerates `data/routes.json` at deploy time, so a
redeploy alone picks up fresher busrouter.sg data.

## Attribution

Live arrivals via [arrivelah](https://github.com/cheeaun/arrivelah) (MIT); stop and
route data via [busrouter.sg](https://data.busrouter.sg/).

Contains information from LTA DataMall, made available under the
[Singapore Open Data Licence v1.0](https://datamall.lta.gov.sg/content/datamall/en/SingaporeOpenDataLicence.html).
Also contains data © [OneMap](https://www.onemap.gov.sg/legal/termsofuse.html) and
© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
Not affiliated with or endorsed by any transport agency.

`arrivelah2` is an informal courtesy service with no SLA or stated fair-use policy, and
its v1 predecessor is currently offline. If this becomes something you rely on,
self-hosting it is one MIT-licensed serverless function and a free DataMall key.

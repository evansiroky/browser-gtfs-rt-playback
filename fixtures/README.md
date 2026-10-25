# fixtures

Deterministic test data for the rest of the repo: a synthetic GTFS Schedule zip, GTFS-RT
VehiclePositions and TripUpdates feeds, the **ground truth** of what the app should report for them,
and a fake feed host. Package `@gtfs-rt-debugger/fixtures`.

## Use from tests

```ts
import { scenario, agencyInstant, TIMEZONE } from '@gtfs-rt-debugger/fixtures';

const sc = scenario(new Date('2026-10-14T19:07:42Z')); // Wed 12:07:42 PDT
sc.scheduleZip; // Uint8Array, a GTFS Schedule zip
sc.vehiclePositions; // Uint8Array, GTFS-RT protobuf at `now`
sc.tripUpdates; // Uint8Array
sc.expected; // ground truth, see below
sc.advance(30); // { now, vehiclePositions, tripUpdates } 30 s later: same schedule and references,
//   vehicles further along their shapes, newer timestamps (pure; negative looks back)

// aim at midnight rollover: 00:20 on 14 Oct, with yesterday's 23:30-25:30 trip still running
scenario(agencyInstant('20261014', '00:20:00', TIMEZONE));
scenario(now, { includeMisconfiguredTrip: false }); // leave out the mixed-exact_times trip
```

`scenario(now, options)` is pure: the same `now` (to the minute) gives byte-identical zips and
feeds. It works for any instant. Daylight-saving days are supported because GTFS times count from
noon minus 12 h; avoid them unless a test targets them.

`expected` (type `ScenarioExpected`):

| Field                                                                            | Meaning                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stats`                                                                          | `tripsToday`, `tripsActiveNow`, `vehicles`, `vehiclesWithTripId`, `tripUpdates`, `activeTripsWithRealtime`, as in `api/dashboard.md`                                                                                                                                                  |
| `lists.activeWithRealtime` / `activeWithoutRealtime` / `unscheduledWithRealtime` | the three trip lists in the order the spec defines; rows carry `tripId`, `serviceDate`, route/headsign fields, the entry's span (epoch seconds), `frequency`, `realtime`, and for list 3 the `reason`                                                                                 |
| `configurationErrors`                                                            | trips with mixed `exact_times`                                                                                                                                                                                                                                                        |
| `schedule`                                                                       | what a loader must find in the zip: agency names/timezone, every route, trip and frequency row, first/last stop time per trip, **the precision-6 polyline each shape encodes to** (after sorting by `shape_pt_sequence`), trips with no shape, which services operate yesterday/today |
| `today`, `yesterday`                                                             | service dates (`YYYYMMDD`)                                                                                                                                                                                                                                                            |

## The scenario

[`SCENARIO.md`](SCENARIO.md) lists every case with the rule it exercises and the derivation of its
place in the lists. In short:

| Trip(s)                                            | Exercises                                                                                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plain-active-*`                                   | plain trips active now; with/without VP/TU; dwell at terminals; arrival-only / departure-only stop times; a `shape_id` missing from `shapes.txt`; a service that exists only in `calendar_dates.txt` |
| `plain-future`, `plain-past`                       | scheduled today but not active; realtime for them is `outside_scheduled_time`                                                                                                                        |
| `edge-*`                                           | the boundaries of "overlaps the current minute"                                                                                                                                                      |
| `plain-nis-removed-today`, `plain-nis-off-weekday` | `not_in_service`: a `calendar_dates` removal; a weekday flag                                                                                                                                         |
| `overnight-from-yesterday`                         | `23:30:00`-`25:30:00` on a service that ended yesterday: active after midnight on yesterday's service date, not counted as scheduled today                                                           |
| `freq-exact`                                       | frequency instances with `exact_times=1`: matching, `unmatched_start_time`, `outside_scheduled_time`                                                                                                 |
| `freq-nominal`                                     | `exact_times` `0` and absent (equal, not an error); two windows; an active instance with no realtime; `missing_start_time`                                                                           |
| `freq-mixed`                                       | `exact_times` `1` and absent: `configuration_error`                                                                                                                                                  |
| ghost trips, vehicles without a trip ID            | `unknown_trip`; vehicles counted but unlisted                                                                                                                                                        |

`shapes.txt` has four shapes of 22-30 points near San Francisco. Two are grouped and ordered; the
other two are shuffled out of `shape_pt_sequence` order and interleaved with each other.

## Fake feed host

```bash
npm run fake-feeds -w fixtures                 # builds, then runs dist/server.js
PORT=4210 npm run fake-feeds -w fixtures       # default port 4200
npm run fake-feeds -w fixtures -- --now=2026-10-14T19:07:42Z   # freeze the clock for a deterministic run
```

(It compiles with `tsc -b` and runs the output with `node`, so it needs no extra runtime. `shared`
is built along with it.) It prints the URLs:

| URL                                         | Body                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/schedule.zip`                             | the schedule zip (built once, at startup)                                                     |
| `/vehicle-positions.pb`, `/trip-updates.pb` | protobuf feeds regenerated on every request from the clock, so vehicles advance between polls |
| `/__scenario`                               | JSON `{ now, expected }`: the ground truth for the scenario being served                      |
| `/__control`                                | `GET` shows the state; `POST` (or `PUT`) a JSON object to change it                           |

Control body (all fields optional):

| Field                                           | Effect                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `feed`: `vp` \| `tu` \| `schedule`, with `mode` | sets that feed's mode                                                                                                    |
| `now`: ISO instant, or `null`                   | rebuilds the scenario for that instant and **freezes** the clock there; `null` rebuilds for the wall clock and unfreezes |
| `advance`: seconds                              | moves the clock forward (frozen or not)                                                                                  |
| `slowMs`: number                                | delay used by `slow` (default 3000 ms, or env `FAKE_FEEDS_SLOW_MS`)                                                      |

Modes: `ok` (default); `http500` (status 500); `timeout` (accepts the request and never answers);
`garbage` (status 200, a body that is neither a feed nor a zip); `slow` (answers after `slowMs`);
`stale` (realtime feeds only: the feed as of one hour earlier, the same bytes on every request
until the mode changes; on `schedule` it behaves as `ok`).

```bash
curl -XPOST localhost:4200/__control -d '{"feed":"vp","mode":"http500"}'
curl -XPOST localhost:4200/__control -d '{"now":"2026-10-14T07:20:00Z"}'   # 00:20 PDT, overnight trip active
```

In tests, start it in-process on an ephemeral port:

```ts
import { startFakeFeeds } from '@gtfs-rt-debugger/fixtures';

const feeds = await startFakeFeeds({ now: new Date('2026-10-14T19:07:42Z') }); // port 0 by default
feeds.urls; // { schedule, vehiclePositions, tripUpdates, control }
feeds.scenario().expected;
await feeds.close();
```

## Decoding

`decodeFeed(bytes)` decodes a feed with `gtfs-realtime-bindings` and throws on a body that is not
one; `toSeconds` turns the `uint64` fields it returns (a number or a `Long`) into a number.

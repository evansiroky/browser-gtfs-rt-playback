# API: Dashboard

## Endpoint

`GET /api/v1/dashboard` — no parameters. `409 session_not_active` while dormant.
Succeeds while the schedule is still loading, with schedule-dependent fields null.

## Response

```
now: epoch seconds                                  // server clock at computation
agency: { names: string[], timezone: string } | null   // null until the schedule is ready
schedule: {                                         // null until the schedule is ready
  tripsToday:     integer
  tripsActiveNow: integer
} | null
realtime: {
  vehicles:                integer | null           // null: feed unconfigured or no snapshot yet
  vehiclesWithTripId:      integer | null
  tripUpdates:             integer | null
  activeTripsWithRealtime: integer | null           // also null while schedule not ready
}
lists: {                                            // null until the schedule is ready
  activeWithRealtime:      integer
  activeWithoutRealtime:   integer
  unscheduledWithRealtime: integer
} | null
configurationErrors: {                              // null until the schedule is ready
  total: integer                                    // number of errors; a trip with both codes counts twice
  items: [{ code: "mixed_exact_times" | "unusable_stop_times" | "frequency_too_dense", tripId: string, message: string }]   // first 100, in trips.txt order
} | null
```

Definitions of each figure are in [trip-activity](../behaviors/trip-activity.md#statistics).
`lists.activeWithRealtime` equals `realtime.activeTripsWithRealtime` whenever the latter is not
null (it is null until every configured realtime feed has a snapshot, [trip-activity](../behaviors/trip-activity.md#statistics)); counts in `lists`
equal the lengths of the corresponding [trip lists](trips.md#list). `agency.timezone` is an
IANA timezone name. `configurationErrors` lists schedule problems found when the schedule was
loaded ([trip-activity](../behaviors/trip-activity.md#schedule-entries)); trips named there
are excluded from the scheduled and active counts and from lists 1 and 2, and appear in list 3
only when the feed references them.

## Principles

**Inherited**

- [Stale-with-age beats blocking](../principles.md#stale-with-age-beats-blocking) — the
  response never fails because a feed is stale or erroring; freshness is reported in
  [session status](session.md#response-sessionstatus).

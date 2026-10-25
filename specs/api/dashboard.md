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
```
Definitions of each figure are in [trip-activity](../behaviors/trip-activity.md#statistics).
`lists.activeWithRealtime` equals `realtime.activeTripsWithRealtime`; counts in `lists`
equal the lengths of the corresponding [trip lists](trips.md#list). `agency.timezone` is an
IANA timezone name.

## Principles
**Inherited**
- [Stale-with-age beats blocking](../principles.md#stale-with-age-beats-blocking) — the
  response never fails because a feed is stale or erroring; freshness is reported in
  [session status](session.md#response-sessionstatus).

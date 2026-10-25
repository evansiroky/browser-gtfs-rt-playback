# API: Shapes

## Endpoint
`GET /api/v1/shapes/{shapeId}` — `shapeId` is percent-encoded. No query parameters (any →
`400 bad_request`). `409 session_not_active` while dormant; `409 schedule_not_ready` until the
schedule has loaded; `404 shape_not_found` when the schedule has no such shape.

## Response
```
shapeId: string
points:  [[latitude, longitude], ...]    // ordered by shape_pt_sequence; decimal degrees
```
Shape geometry is part of the schedule, which is fixed for the activation, so a shape never
changes while the same activation lasts. It is served separately from the trip detail so the
detail's 10-second refresh does not resend it; the client fetches a shape once per page view
and again only if the session's `activatedAt` changes
([session](session.md#response-sessionstatus)).

## Notes
- Shapes are what the schedule says, not a check against it: points are returned as read,
  with no simplification beyond what the response-size limit requires. A shape may be
  simplified (keeping its endpoints and overall path) if it would otherwise exceed the
  response limit.
- Only `shape_pt_lat`, `shape_pt_lon`, and `shape_pt_sequence` are retained
  ([feed-ingest](../behaviors/feed-ingest.md#schedule)).

## Principles
**Inherited**
- [Retain only what a screen shows](../principles.md#retain-only-what-a-screen-shows) —
  `shape_dist_traveled` and other columns are dropped at parse time.
- [Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience) — large
  geometry is fetched once, not on every refresh.

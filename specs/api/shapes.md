# API: Shapes

## Endpoint

`GET /api/v1/shapes/{shapeId}` — `shapeId` is percent-encoded. No query parameters (any →
`400 bad_request`). `409 session_not_active` while dormant; `409 schedule_not_ready` until the
schedule has loaded; `404 shape_not_found` when the schedule has no such shape.

## Response

```
shapeId:  string
encoding: "polyline6"                    // Google encoded polyline algorithm, 6 decimal places
polyline: string                         // points ordered by shape_pt_sequence
```

The `polyline` string is the one the server holds in memory
([data-model](../data-model.md#shape)); it is served unchanged, not decoded and re-encoded per
request. The client decodes it to latitude/longitude pairs.
Shape geometry is part of the schedule, which is fixed for the activation, so a shape never
changes while the same activation lasts. It is served separately from the trip detail so the
detail's 10-second refresh does not resend it; the client fetches a shape once per page view
and again only if the session's `activatedAt` changes
([session](session.md#response-sessionstatus)).

## Notes

- Shapes are what the schedule says, not a check against it: every valid point is encoded,
  with no simplification. Encoding at precision 6 rounds coordinates to about 0.1 m, which is
  the only loss.
- Only `shape_pt_lat`, `shape_pt_lon`, and `shape_pt_sequence` are read
  ([feed-ingest](../behaviors/feed-ingest.md#schedule)).

## Principles

**Inherited**

- [Retain only what a screen shows](../principles.md#retain-only-what-a-screen-shows) —
  `shape_dist_traveled` and other columns are dropped at parse time.
- [Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience) — large
  geometry is fetched once, not on every refresh, and travels compressed.

**Local**

- **Store shapes in wire format.** Geometry is converted once, at load, into the exact form
  the browser receives; the server never holds raw coordinates and never re-encodes per
  request. Memory and bandwidth shrink together, and the work happens off the request path.

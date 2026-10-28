# API: Session

Governs the server's dormant/active state ([session-lifecycle](../behaviors/session-lifecycle.md)).
These two endpoints are the only ones that count as activity.

## Endpoints
- `POST /api/v1/session/start` — user-initiated start. Wakes a dormant server regardless of
  why it went dormant; retries a failed schedule load on an active server. The web app
  calls it on page load and from its restart/retry controls.
- `POST /api/v1/session/ping` — keepalive. Resets the inactivity timer; wakes a dormant server
  unless the last activation ended with `max-duration`. The web app calls it every 10 s
  while the page is engaged ([client-activity](../behaviors/client-activity.md)).

No request body, no authentication. Both return `200` with a `SessionStatus`, including when
a ping leaves the server dormant (check `state`). If the process had shut down, the request
is served by a freshly started one (a slower first response is expected).

## Response: SessionStatus
```
state:           "dormant" | "active"
endedReason:     "idle" | "max-duration" | null     // why the last activation ended (a restarted
                                                    // process reports null)
activatedAt:     epoch seconds | null               // start of the current activation
expiresAt:       epoch seconds | null               // activatedAt + maximum duration
historyStartsAt: epoch seconds | null               // oldest retained realtime snapshot
schedule: {
  state:    "idle" | "loading" | "ready" | "failed" // "idle" only while dormant
  loadedAt: epoch seconds | null
  error:    { code, message } | null
}
realtime: {
  vehiclePositions: FeedStatus | null               // null when not configured
  tripUpdates:      FeedStatus | null
}

FeedStatus: {
  lastAttemptAt:  epoch seconds | null
  lastSuccessAt:  epoch seconds | null
  feedTimestamp:  epoch seconds | null              // header timestamp of the latest snapshot
  stale:          boolean                           // see feed-ingest
  error:          { code, message } | null          // most recent failure, cleared on success
}
```
While dormant, all nullable fields are null except `endedReason`, and `schedule.state` is
`"idle"`.

## Data endpoints and state
Data endpoints ([dashboard.md](dashboard.md), [trips.md](trips.md)) never wake the server or
reset the inactivity timer; while dormant they return `409 session_not_active`.

## Principles
**Inherited**
- [Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience) — data
  reads cannot keep the server awake, so only a page that is actively pinging does.

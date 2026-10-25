# API: Conventions

Shared rules for every endpoint under `/api/v1`. The API serves only this app's web client;
it is same-origin and sends no CORS headers.

## Format
- JSON request and response bodies (`application/json; charset=utf-8`), camelCase fields.
- Instants are integers: Unix epoch **seconds** (UTC). The server never formats times; the
  client renders them in the agency timezone returned by
  [`GET /dashboard`](dashboard.md).
- Service dates are strings `YYYYMMDD`, returned for information only; no endpoint accepts a
  date.
- Every response carries `Cache-Control: no-store`.
- Unknown fields in a response are to be ignored by clients; fields documented as nullable
  are always present.

## Errors
Non-2xx responses use one envelope:

```json
{ "error": { "code": "session_not_active", "message": "Human-readable, URL-free text." } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed or invalid parameter, or any query parameter an endpoint does not define |
| 404 | `trip_not_found` | See [trips.md](trips.md) |
| 404 | `shape_not_found` | See [shapes.md](shapes.md) |
| 409 | `session_not_active` | The server is dormant; start or ping first |
| 409 | `schedule_not_ready` | The endpoint needs the schedule and it is loading or failed |
| 429 | `rate_limited` | Client exceeded the per-address limit; `Retry-After` is set |
| 500 | `internal_error` | Unexpected failure; no internals leaked |

Error text never contains a feed URL, credential, or stack trace.

## Rate limiting
Each client address (taken from the platform's forwarded-address header) may make at most
the configured number of `/api/v1` requests per minute (default 120,
[configuration](../behaviors/configuration.md#tunables-and-defaults)). A normal browser
issues about a dozen per minute.

## Principles
**Inherited**
- [Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience) —
  rate limiting and `no-store` keep every request cheap and unamplified.
- [The server fetches](../principles.md#the-server-fetches-the-browser-never-talks-to-feed-hosts)
  — no endpoint accepts or returns a feed URL.

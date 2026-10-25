# Behavior: Configuration

## Rule
Which feeds the app watches, and every tunable limit, is fixed by the deployment's
configuration. Visitors cannot read, change, or supply any of it: there is no UI, API, or
query parameter that accepts a feed URL.

## Feeds
| Setting | Required | Meaning |
|---|---|---|
| Schedule URL | yes | GTFS Schedule zip |
| Vehicle positions URL | one of the two realtime URLs is required | GTFS-RT VehiclePositions feed |
| Trip updates URL | (see left) | GTFS-RT TripUpdates feed |

If only one realtime feed is configured, the statistics and lists that depend on the other
are reported as not configured (null in the API, "Not configured" on screen) and trip
association uses the configured feed alone.

Feed URLs are secrets ([The server fetches](../principles.md#the-server-fetches-the-browser-never-talks-to-feed-hosts)).
The server refuses to start if the schedule URL or both realtime URLs are missing, or any
configured URL is not `https` or `http`.

## Tunables and defaults
| Setting | Default | Governs |
|---|---|---|
| Realtime poll interval | 10 s | [feed-ingest](feed-ingest.md) |
| Realtime fetch timeout | 8 s | feed-ingest |
| Realtime response size limit | 25 MiB | feed-ingest |
| Schedule fetch timeout | 120 s | feed-ingest |
| Schedule download size limit | 100 MiB | feed-ingest |
| Idle timeout | 15 min | [session-lifecycle](session-lifecycle.md) |
| Maximum activation duration | 2 h | session-lifecycle |
| Exit on idle | on when deployed, off for local development | session-lifecycle |
| Realtime retention | 60 min | [data-retention](data-retention.md) |
| Realtime history memory limit | 512 MiB | data-retention |
| API rate limit | 120 requests/min per client address | [api/conventions](../api/conventions.md) |

The retention default is also a ceiling: configuration may lower it but the server clamps
any value above 60 minutes to 60 ([Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience)).

## Principles
**Inherited**
- [The server fetches](../principles.md#the-server-fetches-the-browser-never-talks-to-feed-hosts)
  — config is the only place feed URLs exist, and it never flows outward.
- [Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience) — every
  limit above is a cost guard, and the retention ceiling cannot be configured away.

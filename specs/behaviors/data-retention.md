# Behavior: Data retention

## Rule
The app never stores more than one hour of realtime data, never writes anything to disk or
an external store, and forgets everything when it goes dormant or shuts down.

## Realtime history
- Snapshots (and the pings derived from them) are kept for at most the **retention window**
  — 60 minutes, measured from each snapshot's server receive time. Older ones are discarded
  as new ones arrive, and no later than the next poll tick.
- A **memory limit** (default 512 MiB) bounds the realtime history in total. When retained
  history would exceed it, the oldest snapshots are discarded first until it fits, even if
  they are younger than the retention window. The effective start of history is exposed
  (`historyStartsAt`, [api/session.md](../api/session.md)) so screens can say when history
  is shorter than the full hour.
- Ping sequence numbers keep counting up for the activation; expiring a ping never
  renumbers the others ([data-model](../data-model.md#ping)).
- Snapshots may be kept in a compact form (for example the raw protobuf bytes) and decoded
  on demand; the representation is an implementation decision so long as the limit above
  holds.

## Schedule
Held for the life of the activation (not subject to the one-hour window, because it is
reference data rather than history) and bounded by the download size limit, the schedule
memory limit, and the reduction rules in [feed-ingest](feed-ingest.md).

## Forgetting
On shutdown or dormancy ([session-lifecycle](session-lifecycle.md#shutting-down)) the server discards the
schedule, every snapshot, ping sequences, feed statuses, and any derived caches. After
that the process holds none of that data; the next activation starts empty. No
data is written to disk, a database, a cache service, or object storage at any time.

## Principles
**Inherited**
- [Forget by default](../principles.md#forget-by-default) — the whole behavior.
- [Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience) — the
  memory limit evicts history early rather than letting memory (and instance size) grow.

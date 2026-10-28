# Behavior: Session lifecycle

## Rule

The server is either **dormant** (holding no data, fetching nothing) or **active**
(ingesting). Browser pings move it between the two, and 15 minutes without a ping shuts it
down entirely. There is one server-wide activation
shared by every visitor — not one per browser.

## States

- **dormant** — no schedule, no snapshots, no ingestion timers. Holds only the reason the
  last activation ended (`max-duration`, or none if there has been no activation since the
  process started). A process that shuts down on idle exits, so it never lingers dormant
  with reason `idle` when exit-on-idle is enabled.
- **active** — an activation is in progress: the schedule is loading or loaded, and realtime
  feeds are being polled.

## Waking

A **start** wakes a dormant server unconditionally and begins an activation. A **ping**
wakes a dormant server unless the last activation ended by `max-duration`. Waking:

1. Records the activation start time.
2. Begins the schedule download (once per activation — [feed-ingest](feed-ingest.md)).
3. Begins polling the realtime feeds immediately, without waiting for the schedule, so
   retained history starts accumulating as early as possible.

Starting or pinging an already-active server does not restart anything. A **start** received
while the schedule load has failed retries the schedule load (once per start).

## Staying awake

Every ping and start resets the **inactivity timer**, in every state (including dormant).
The web app sends a ping every 10 seconds only while its page is engaged — visible and
interacted with in the last minute — so hidden or untouched pages do not keep the server
awake ([client-activity](client-activity.md);
[Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience)).
Reading data endpoints does **not** reset the timer; only the session endpoints do
([api/session.md](../api/session.md)).

## Shutting down

The server **shuts down** when no ping or start has arrived for the idle timeout (default
15 minutes), in whatever state it is in:

1. It abandons any in-flight fetch and discards the result.
2. It discards the schedule, all snapshots, ping sequences, feed statuses, derived caches,
   and timers ([data-retention](data-retention.md)). If it was active, the ending reason is
   `idle`.
3. When exit-on-idle is enabled (the deployed default), the process then exits cleanly so
   the platform scales to zero and stops billing; the next ping or start is served by a
   fresh process that begins dormant with no ending reason. With exit-on-idle disabled
   (local development) the process stays up, dormant.

## Maximum duration

Independently, an activation that has lasted the maximum activation duration (default 2 h)
since it began ends regardless of ongoing pings: the server goes **dormant** — discarding
everything exactly as in step 2 above, with ending reason `max-duration` — but the process
stays up and continues to receive pings.

After a `max-duration` end, pings no longer wake the server; only an explicit start does.
A browser tab left open overnight therefore cannot restart the server on its own: it keeps
the (empty, dormant) process alive with its pings, the web app shows that the session ended
and offers a restart control, and the lock holds for as long as pings keep arriving. When
pings stop for the idle timeout the process shuts down as above, which also clears the lock.

## Concurrent visitors

All browsers observe the same activation. A second visitor arriving mid-activation sees the
data already accumulated; it does not trigger a second schedule download. The maximum
duration is measured from the activation's start, not from the latest visitor's arrival.

## Principles

**Inherited**

- [Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience) — the
  maximum-duration cap and the no-auto-rewake rule exist so an unattended tab cannot
  generate unbounded spend.
- [Forget by default](../principles.md#forget-by-default) — shutting down or going dormant
  discards everything; there is no warm cache to resume from.

# Principles

The project's philosophy, written down as principles. Each is decisive: it picks a side of
a real trade-off so an implementer can resolve an unspecified case the way the author would.

## Cost ceiling beats convenience
This app is a personal debugging tool with no revenue, so a bounded cloud bill matters more
than a smooth experience. When cost and convenience conflict, choose the option with the
lower worst-case spend: go dormant sooner, retain less, refuse more, and cap everything
(instances, memory, request sizes, activation length). Never add a feature whose cost grows
without a hard limit. A user having to click "restart" is acceptable; an unattended browser
tab running up a bill is not.

## Forget by default
Nothing outlives its usefulness. All data lives in the memory of a single server process —
no database, no files, no object storage, no cache that survives a restart. When the system
goes dormant it forgets everything it fetched, and the next visit starts from scratch. When
deciding whether to keep something, the answer is no unless a screen needs it right now.

## The server fetches; the browser never talks to feed hosts
GTFS and GTFS-RT hosts do not send CORS headers and may require credentials in the URL.
Only the server contacts them, only at URLs fixed in its configuration. The browser talks
only to this app's own origin (plus map tiles), and no feed URL or credential ever reaches
the browser, a log line, or an error message.

## Show the feed as it is
This is a debugger. When feed data is odd — an unknown trip ID, a vehicle with no trip, a
stale timestamp, a trip running outside its scheduled window — surface it and label it;
never silently drop, repair, or normalize it. Prefer showing a questionable row with a
reason over hiding it to keep the screen tidy.

## Stale-with-age beats blocking
When a refresh fails or lags, keep showing the last good data and say how old it is. Never
blank a screen or block on a spinner because the latest fetch failed. A user debugging a
flaky feed needs the last-known state more than a clean error page.

## Agency-local time
Transit data is understood in the agency's own clock. Every time shown to a user is
rendered in the agency's timezone (from `agency.txt`), never the browser's or the server's,
so a person debugging from another timezone sees what riders and operators see.

## Retain only what a screen shows
Parse the large inputs (especially the GTFS Schedule) down to the fields the screens and
rules actually use and discard the rest. Memory is bounded and billed; unused columns,
files, and history are cost with no benefit.

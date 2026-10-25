# Behavior: Client activity

## Rule
The web app only pings the server, and only polls for data, while a person is actually
using the page. A visible page that nobody touches stops pinging after one minute.

## Definitions
- **Visible** — the browser reports the page as visible (not a hidden or background tab,
  not a minimized window).
- **Interaction** — any pointer movement, click, touch, scroll, wheel, or key press on the
  page (map panning and zooming included).
- **Engaged** — visible **and** the last interaction (or the page load) was less than
  **60 seconds** ago.

## Engaged
While engaged the app sends a ping every 10 seconds
([api/session.md](../api/session.md)) and refreshes its data every 10 seconds. The first
ping is sent on page load as a **start**. A page loaded in a hidden tab is not engaged, so it
sends nothing until the tab becomes visible; its first request is then the start.

## Paused
When the page stops being engaged — the tab is hidden, or 60 seconds pass with no
interaction — the app immediately stops all pings and all data polling. It keeps showing the
last data it received, with ages, and shows a **paused** notice stating why ("Paused — no
activity for a minute" or "Paused — tab hidden") and that any interaction resumes it
([Stale-with-age beats blocking](../principles.md#stale-with-age-beats-blocking)).

## Resuming
As soon as the page becomes engaged again — the tab becomes visible (which counts as an
interaction), or the first interaction occurs on a visible page — the app sends one **ping**
(not a start), refetches its data as soon as that ping is answered (so a server the ping just
woke is ready to serve it), and resumes the 10-second cadence. Until a start has succeeded,
the request sent on resuming, and on each cadence tick, is a start instead of a ping. A ping
wakes the server if it was dormant for any reason except the maximum-duration end; in that
case the app shows the session-ended banner with its **Restart** action instead
([session-lifecycle](session-lifecycle.md#maximum-duration)). While the session is ended the
app sends nothing at all until Restart.

## Effect on the server
Because a paused page sends nothing, a browser left open and untouched lets the server's
15-minute inactivity timer run out and the server shut down
([session-lifecycle](session-lifecycle.md#shutting-down)): about 16 minutes after the last
interaction, at most.

## Principles
**Inherited**
- [Cost ceiling beats convenience](../principles.md#cost-ceiling-beats-convenience) — an
  unattended page must never be what keeps a billed server awake; resuming costs the user one
  touch.
- [Stale-with-age beats blocking](../principles.md#stale-with-age-beats-blocking) — pausing
  freezes the screen at its last data with visible ages rather than clearing it.

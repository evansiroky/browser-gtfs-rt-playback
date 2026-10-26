import type { Browser, ConsoleMessage } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePolyline6, type TripDetailResponse } from '@gtfs-rt-debugger/shared';
import type { Scenario } from '@gtfs-rt-debugger/fixtures';
import {
  DESKTOP,
  PHONE,
  advanceClock,
  launchBrowser,
  openApp,
  screenshot,
  type AppPage,
} from './harness/browser.js';
import { alignToMinute, startStack, type Stack } from './harness/stack.js';
import { agencyClock } from './dashboard-reader.js';
import {
  clockWithSeconds,
  duration,
  readFrequencies,
  readKeyValues,
  readMap,
  readPings,
  recordTripResponses,
} from './trip-detail-reader.js';

let browser: Browser;
let stack: Stack;
let truth: Scenario['expected'];

beforeAll(async () => {
  browser = await launchBrowser();
  await alignToMinute();
  stack = await startStack();
  truth = stack.feeds.scenario().expected;
});

afterAll(async () => {
  await browser?.close();
  await stack?.close();
});

/** Opens the trip page and records every trip detail response the page receives. */
async function openTrip(
  tripId: string,
  options: Pick<Parameters<typeof openApp>[2] & object, 'viewport' | 'fakeClock'> = {},
) {
  let responses: TripDetailResponse[] = [];
  const app = await openApp(browser, stack, {
    ...options,
    path: `/trips/${encodeURIComponent(tripId)}`,
    beforeGoto: (page) => {
      responses = recordTripResponses(page, tripId);
    },
  });
  const problems: string[] = [];
  app.page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });
  app.page.on('pageerror', (error) => problems.push(error.message));
  return { app, problems, responses: () => responses };
}

/** Resolves once the page shows the newest response it received: its pings, as listed. */
async function shown(app: AppPage, responses: () => TripDetailResponse[]) {
  await app.page.locator('[data-card=pings]').waitFor();
  await expect
    .poll(async () => {
      const latest = responses().at(-1);
      if (!latest) return 'no response yet';
      const heading = (await readPings(app.page)).heading;
      return heading === `Vehicle positions (${latest.realtime.pings.length})` ? 'ok' : heading;
    })
    .toBe('ok');
  // The agency timezone comes from the dashboard request; times show once it has answered.
  await app.page.waitForLoadState('networkidle');
  return responses().at(-1)!;
}

async function mapReady(app: AppPage) {
  await expect.poll(async () => (await readMap(app.page)).styleLoaded).toBe(true);
}

const apiJson = async <T>(path: string): Promise<T> =>
  (await fetch(`${stack.baseUrl}/api/v1${path}`)).json() as Promise<T>;

const trip = (id: string) => truth.schedule.trips.find((row) => row.trip_id === id)!;
const withCoordinates = (detail: TripDetailResponse) =>
  detail.realtime.pings.filter((ping) => ping.latitude !== null && ping.longitude !== null);

describe('a plain trip with pings and a shape', () => {
  const TRIP = 'plain-active-vp-tu';

  it('shows the header, every trips.txt and routes.txt column, and the computed values', async () => {
    const { app, problems, responses } = await openTrip(TRIP);
    const detail = await shown(app, responses);

    expect(await app.page.locator('h1').innerText()).toBe(`Trip ${TRIP}`);
    const date = detail.serviceDate;
    expect(await app.page.locator('[data-field=service-date]').innerText()).toBe(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`,
    );
    const row = truth.lists.activeWithRealtime.find((r) => r.tripId === TRIP)!;
    const label = app.page.locator('[data-card=header] [data-list]');
    expect(await label.count()).toBe(1);
    expect(await label.first().getAttribute('data-list')).toBe('active-with-realtime');
    expect(await label.first().innerText()).toContain(
      `${agencyClock(row.scheduledStart)}–${agencyClock(row.scheduledEnd)}`,
    );

    const tripRows = await readKeyValues(app.page, 'scheduled');
    for (const [column, value] of Object.entries(trip(TRIP))) {
      expect(tripRows[column], `trips.txt ${column}`).toBe(value);
    }
    expect(tripRows['Scheduled start']).toContain(clockWithSeconds(row.scheduledStart));
    expect(tripRows['Scheduled end']).toContain(clockWithSeconds(row.scheduledEnd));
    expect(tripRows['Operates on the service date']).toBe('yes');
    expect(tripRows['Active now']).toBe('yes');

    const route = truth.schedule.routes.find((r) => r.route_id === trip(TRIP).route_id)!;
    const routeRows = await readKeyValues(app.page, 'route');
    expect(routeRows).toEqual(route);
    expect(await app.page.locator('[data-slot=route-heading]').innerText()).toBe(
      `Route ${route.route_short_name} — ${route.route_long_name}`,
    );
    expect(await app.page.locator('[data-card=frequencies]').count()).toBe(0);

    expect(problems).toEqual([]);
    await app.context.close();
  });

  it('draws the shape from the decoded polyline and numbers the markers with the ping sequences', async () => {
    const { app, problems, responses } = await openTrip(TRIP);
    const detail = await shown(app, responses);
    await mapReady(app);

    const shape = await apiJson<{ polyline: string }>('/shapes/shape-market');
    expect(shape.polyline).toBe(truth.schedule.shapes['shape-market']);
    const points = decodePolyline6(shape.polyline);
    const view = await readMap(app.page);
    expect(view.shapePoints).toBe(points.length);
    expect(view.shapeFirst).toBe(points[0]!.join(','));
    expect(view.shapeLast).toBe(points.at(-1)!.join(','));

    const expected = withCoordinates(detail).map((ping) => ping.sequence);
    expect(expected.length).toBeGreaterThanOrEqual(2);
    await expect
      .poll(async () => (await readMap(app.page)).markers.map((m) => m.sequence))
      .toEqual(expected);
    for (const marker of (await readMap(app.page)).markers) {
      expect(marker.label).toBe(String(marker.sequence));
      // The map opens fitted to the shape and all markers.
      expect(marker.x).toBeGreaterThan(view.box.x);
      expect(marker.x).toBeLessThan(view.box.x + view.box.width);
      expect(marker.y).toBeGreaterThan(view.box.y);
      expect(marker.y).toBeLessThan(view.box.y + view.box.height);
    }
    // Two vehicles report this trip.
    expect(new Set(detail.realtime.pings.map((p) => p.vehicleId)).size).toBeGreaterThanOrEqual(2);
    await screenshot(app.page, 'trip-detail-desktop');
    expect(problems).toEqual([]);
    await app.context.close();
  });

  it('keeps the pings list collapsed until opened, then lists every ping with its fields', async () => {
    const { app, responses } = await openTrip(TRIP);
    const detail = await shown(app, responses);
    const trigger = app.page.getByRole('button', { name: /^Vehicle positions \(\d+\)$/ });
    expect(await trigger.getAttribute('aria-expanded')).toBe('false');
    expect((await readPings(app.page)).rows).toHaveLength(0);

    await trigger.click();
    expect(await trigger.getAttribute('aria-expanded')).toBe('true');
    const { heading, rows } = await readPings(app.page);
    expect(heading).toBe(`Vehicle positions (${detail.realtime.pings.length})`);
    expect(rows.map((r) => r.sequence)).toEqual(detail.realtime.pings.map((p) => p.sequence));
    detail.realtime.pings.forEach((ping, index) => {
      const view = rows[index]!;
      expect(view.time).toBe(clockWithSeconds(ping.timestamp));
      expect(view.vehicle).toBe(
        ping.vehicleLabel ? `${ping.vehicleId} (${ping.vehicleLabel})` : ping.vehicleId,
      );
      // Present fields are shown, absent ones are omitted.
      expect('latitude' in view.fields).toBe(ping.latitude !== null);
      expect('licensePlate' in view.fields).toBe(ping.licensePlate !== null);
      expect('bearing' in view.fields).toBe(ping.bearing !== null);
      expect('stopId' in view.fields).toBe(ping.stopId !== null);
      expect('startTime' in view.fields).toBe(ping.startTime !== null);
      if (ping.startDate !== null) expect(view.fields.startDate).toBe(ping.startDate);
    });
    expect(rows.some((r) => 'licensePlate' in r.fields)).toBe(true);
    expect(rows.some((r) => !('licensePlate' in r.fields))).toBe(true);
    await screenshot(app.page, 'trip-detail-pings-open');

    await trigger.click();
    expect(await trigger.getAttribute('aria-expanded')).toBe('false');
    await app.context.close();
  });

  it('selects a ping from its marker and from its row', async () => {
    const { app, responses } = await openTrip(TRIP);
    const detail = await shown(app, responses);
    await mapReady(app);
    await expect.poll(async () => (await readMap(app.page)).markers.length).toBeGreaterThan(1);
    // Markers are not clustered: only one that no later marker covers can be clicked.
    const view = await readMap(app.page);
    const clear = view.markers.filter((a) =>
      view.markers.every((b) => b.sequence <= a.sequence || Math.hypot(a.x - b.x, a.y - b.y) > 20),
    );
    expect(clear.length).toBeGreaterThanOrEqual(2);
    const [first, second] = clear.map((m) =>
      detail.realtime.pings.find((ping) => ping.sequence === m.sequence)!,
    );

    // A marker click expands the list, scrolls to and highlights the row, and opens a popup.
    expect((await readPings(app.page)).rows).toHaveLength(0);
    await app.page.locator(`[data-map] button[data-sequence="${first!.sequence}"]`).click();
    await expect.poll(async () => (await readPings(app.page)).rows.length).toBeGreaterThan(0);
    let pings = await readPings(app.page);
    expect(pings.rows.filter((r) => r.selected).map((r) => r.sequence)).toEqual([first!.sequence]);
    await expect
      .poll(async () => (await readPings(app.page)).rows.find((r) => r.selected)!.inView)
      .toBe(true);
    const popup = app.page.locator('.maplibregl-popup-content');
    expect(await popup.innerText()).toContain(`Position ${first!.sequence}`);
    expect(await popup.innerText()).toContain(clockWithSeconds(first!.timestamp));
    expect(await popup.innerText()).toContain(first!.vehicleId);
    expect(
      (await readMap(app.page)).markers.filter((m) => m.selected).map((m) => m.sequence),
    ).toEqual([first!.sequence]);

    // A row click highlights the row and its marker and pans the map to it.
    await app.page.locator(`li[data-sequence="${second!.sequence}"]`).click();
    await expect
      .poll(async () =>
        (await readMap(app.page)).markers.filter((m) => m.selected).map((m) => m.sequence),
      )
      .toEqual([second!.sequence]);
    pings = await readPings(app.page);
    expect(pings.rows.filter((r) => r.selected).map((r) => r.sequence)).toEqual([second!.sequence]);
    expect(await popup.innerText()).toContain(`Position ${second!.sequence}`);
    await expect
      .poll(async () => {
        const view = await readMap(app.page);
        const marker = view.markers.find((m) => m.sequence === second!.sequence)!;
        return Math.hypot(
          marker.x - (view.box.x + view.box.width / 2),
          marker.y - (view.box.y + view.box.height / 2),
        );
      })
      .toBeLessThan(3);
    await screenshot(app.page, 'trip-detail-selected');
    await app.context.close();
  });

  it('adds new pings on refresh without renumbering, fetches the shape once, and does not refit a moved map', async () => {
    const { app, responses } = await openTrip(TRIP, { fakeClock: true });
    const before = await shown(app, responses);
    await mapReady(app);
    await expect
      .poll(async () => (await readMap(app.page)).markers.length)
      .toBe(withCoordinates(before).length);

    // Drag the map by hand: from now on it is the user's view.
    const first = await readMap(app.page);
    const startX = first.box.x + 12;
    const startY = first.box.y + 12;
    await app.page.mouse.move(startX, startY);
    await app.page.mouse.down();
    await app.page.mouse.move(startX + 80, startY + 40, { steps: 8 });
    await app.page.mouse.up();
    // Wait for the drag's inertia to settle.
    let moved = await readMap(app.page);
    await expect
      .poll(async () => {
        const previous = moved;
        moved = await readMap(app.page);
        return moved.markers.every(
          (m, i) => Math.hypot(m.x - previous.markers[i]!.x, m.y - previous.markers[i]!.y) < 0.5,
        );
      })
      .toBe(true);
    const sample = moved.markers[0]!;
    expect(sample.x).not.toBeCloseTo(first.markers[0]!.x, 0);

    for (let refresh = 1; refresh <= 3; refresh++) {
      const count = responses().length;
      await advanceClock(app.page, 10_000);
      await expect.poll(() => responses().length).toBeGreaterThan(count);
    }
    const after = await shown(app, responses);
    expect(after.realtime.pings.length).toBeGreaterThan(before.realtime.pings.length);
    await expect
      .poll(async () => (await readMap(app.page)).markers.length)
      .toBe(withCoordinates(after).length);

    // The numbers noted before the refreshes still point at the same observations.
    const view = await readMap(app.page);
    for (const ping of before.realtime.pings) {
      const old = after.realtime.pings.find((p) => p.sequence === ping.sequence);
      expect(old).toEqual(ping);
    }
    expect(view.markers.map((m) => m.sequence)).toEqual(
      withCoordinates(after).map((p) => p.sequence),
    );
    // The map did not refit: the first marker is where the drag left it.
    const same = view.markers.find((m) => m.sequence === sample.sequence)!;
    expect(same.x).toBeCloseTo(sample.x, 0);
    expect(same.y).toBeCloseTo(sample.y, 0);

    const requests = app.apiRequests().map((r) => `${r.method} ${r.path}`);
    expect(requests.filter((r) => r === 'GET /api/v1/shapes/shape-market')).toHaveLength(1);
    expect(requests.filter((r) => r === `GET /api/v1/trips/${TRIP}`).length).toBeGreaterThanOrEqual(
      4,
    );
    await app.context.close();
  });

  it('shows the latest trip update', async () => {
    const { app, responses } = await openTrip(TRIP);
    const detail = await shown(app, responses);
    const update = detail.realtime.tripUpdate!;
    expect(update).not.toBeNull();
    const rows = await readKeyValues(app.page, 'trip-update');
    expect(rows['Timestamp']).toContain(clockWithSeconds(update.timestamp!));
    expect(rows['Delay']).toBe(`${update.delay! > 0 ? '+' : ''}${update.delay} s`);
    expect(rows['Vehicle ID']).toBe(update.vehicleId);
    expect(rows['Stop time updates']).toBe(String(update.stopTimeUpdateCount));
    await app.context.close();
  });
});

describe('frequency trips', () => {
  it('shows every frequencies.txt column, windows, templates and the nominal-departure note', async () => {
    const { app, problems, responses } = await openTrip('freq-nominal');
    const detail = await shown(app, responses);
    const rows = await readFrequencies(app.page);
    const expected = truth.schedule.frequencies.filter((row) => row.trip_id === 'freq-nominal');
    expect(rows).toHaveLength(expected.length);
    expect(expected.length).toBeGreaterThan(0);
    const times = truth.schedule.tripTimes['freq-nominal']!;
    detail.scheduled!.frequencies!.forEach((frequency, index) => {
      const view = rows[index]!;
      expect(view.columns).toEqual(expected[index]);
      expect(view.readable).toBe(true);
      expect(view.fields.window).toBe(
        `${clockWithSeconds(frequency.windowStart!)}–${clockWithSeconds(frequency.windowEnd!)}`,
      );
      expect(view.fields.template).toBe(duration(times.endSecs - times.startSecs));
      expect(view.fields.active).toBe(frequency.activeNow ? 'yes' : 'no');
      expect(view.fields.starts).toBe(
        frequency.activeInstanceStarts.length > 0
          ? frequency.activeInstanceStarts.map(clockWithSeconds).join(', ')
          : 'none',
      );
      // exact_times is "0" in one row and absent in the other: both carry the note.
      expect(view.fields.note).toBe('Departures are assumed to be exactly on the headway.');
    });
    expect(rows.some((r) => r.fields.active === 'yes')).toBe(true);
    // One label per active instance.
    const row = truth.lists.activeWithRealtime.filter((r) => r.tripId === 'freq-nominal');
    expect(await app.page.locator('[data-card=header] [data-list]').count()).toBe(
      detail.classification.length,
    );
    expect(row.length).toBeGreaterThan(0);
    expect(problems).toEqual([]);
    await screenshot(app.page, 'trip-detail-frequency');
    await app.context.close();
  });

  it('has no nominal-departure note when exact_times is 1', async () => {
    const { app, responses } = await openTrip('freq-exact');
    await shown(app, responses);
    const rows = await readFrequencies(app.page);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.columns.exact_times).toBe('1');
    expect(rows[0]!.fields.note).toBe('');
    await app.context.close();
  });
});

describe('configuration errors', () => {
  const alerts = (app: AppPage) =>
    app.page.locator('[data-error-code]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        code: node.getAttribute('data-error-code'),
        text: (node as HTMLElement).innerText.replace(/\s+/g, ' '),
      })),
    );

  it('shows mixed exact_times prominently while the rows stay as in the feed', async () => {
    const { app, responses } = await openTrip('freq-mixed');
    await shown(app, responses);
    const found = await alerts(app);
    expect(found.map((a) => a.code)).toEqual(['mixed_exact_times']);
    expect(found[0]!.text).toContain('disagree on exact_times');
    expect(found[0]!.text).toContain('activity cannot be determined');
    expect(found[0]!.text).toContain('excluded from the schedule counts');
    const rows = await readFrequencies(app.page);
    const expected = truth.schedule.frequencies.filter((row) => row.trip_id === 'freq-mixed');
    expect(rows.map((r) => r.columns)).toEqual(expected);
    // The rows are readable, but nothing is active.
    expect(rows.every((r) => r.fields.active === 'no' && r.fields.starts === 'none')).toBe(true);
    const label = app.page.locator('[data-card=header] [data-list]');
    expect(await label.count()).toBe(1);
    expect(await label.innerText()).toContain('Schedule configuration error (see trip)');
    await screenshot(app.page, 'trip-detail-config-error');
    await app.context.close();
  });

  it('shows no template duration when the stop times are unusable', async () => {
    const { app, responses } = await openTrip('cfg-freq-first-stop-untimed');
    await shown(app, responses);
    expect((await alerts(app)).map((a) => a.code)).toEqual(['unusable_stop_times']);
    const rows = await readFrequencies(app.page);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields.template).toBe('cannot be computed');
    await app.context.close();
  });

  it('shows frequency_too_dense, and several errors at once', async () => {
    const dense = await openTrip('cfg-too-dense');
    await shown(dense.app, dense.responses);
    const found = await alerts(dense.app);
    expect(found.map((a) => a.code)).toEqual(['frequency_too_dense']);
    expect(found[0]!.text).toContain('more than 2,000 instances');
    await dense.app.context.close();

    const both = await openTrip('cfg-mixed-and-no-stop-times');
    await shown(both.app, both.responses);
    expect(new Set((await alerts(both.app)).map((a) => a.code))).toEqual(
      new Set(['mixed_exact_times', 'unusable_stop_times']),
    );
    await both.app.context.close();
  });
});

describe('trips without a schedule, a shape or pings', () => {
  it('shows an unknown realtime-only trip with markers and no schedule section', async () => {
    const { app, problems, responses } = await openTrip('ghost-vp-trip');
    const detail = await shown(app, responses);
    expect(detail.scheduled).toBeNull();
    const card = app.page.locator('[data-card=scheduled]');
    expect(await card.innerText()).toContain('is not in the schedule');
    expect(await app.page.locator('[data-card=route], [data-card=frequencies]').count()).toBe(0);
    const label = app.page.locator('[data-card=header] [data-list]');
    expect(await label.first().getAttribute('data-list')).toBe('unscheduled-with-realtime');
    expect(await label.first().innerText()).toContain('Trip ID not in schedule');

    await expect
      .poll(async () => (await readMap(app.page)).markers.map((m) => m.sequence))
      .toEqual(withCoordinates(detail).map((p) => p.sequence));
    expect((await readMap(app.page)).shapePoints).toBe(0);
    expect(await app.page.locator('[data-slot=shape-note]').count()).toBe(0);
    expect(await app.page.locator('[data-slot=no-pings]').count()).toBe(0);
    expect(app.apiRequests().some((r) => r.path.startsWith('/api/v1/shapes/'))).toBe(false);
    expect(problems).toEqual([]);
    await app.context.close();
  });

  it('shows a trip update without pings: no map, the no-positions message and when history begins', async () => {
    const { app, responses } = await openTrip('ghost-tu-trip');
    const detail = await shown(app, responses);
    expect(detail.realtime.pings).toHaveLength(0);
    expect(await app.page.locator('[data-map]').count()).toBe(0);
    const status = (await (
      await fetch(`${stack.baseUrl}/api/v1/session/ping`, { method: 'POST' })
    ).json()) as { historyStartsAt: number };
    const text = await app.page.locator('[data-slot=no-pings]').innerText();
    expect(text).toContain('No vehicle positions have been received for this trip');
    expect(text).toContain(`begins at ${clockWithSeconds(status.historyStartsAt)}`);
    const update = await readKeyValues(app.page, 'trip-update');
    expect(update['Stop time updates']).toBe(
      String(detail.realtime.tripUpdate!.stopTimeUpdateCount),
    );
    await app.context.close();
  });

  it('says a scheduled trip has a shape that is not in shapes.txt', async () => {
    const { app, responses } = await openTrip('plain-active-missing-shape');
    const detail = await shown(app, responses);
    expect(detail.scheduled!.shapeId).toBe('shape-gone');
    await expect
      .poll(() => app.page.locator('[data-slot=shape-note]').innerText())
      .toBe('Shape “shape-gone” is not in shapes.txt, so no route line is drawn.');
    expect(await app.page.locator('[data-map]').count()).toBe(0);
    expect(await app.page.locator('[data-slot=no-pings]').count()).toBe(1);
    await app.context.close();
  });
});

describe('not found, paused and layout', () => {
  it('shows a not-found message with a way back to the dashboard', async () => {
    const { app } = await openTrip('no-such-trip');
    await app.page.locator('[data-card=not-found]').waitFor();
    expect(await app.page.locator('h1').innerText()).toBe('Trip not found');
    expect(await app.page.locator('[data-card=not-found]').innerText()).toContain('no-such-trip');
    await app.page.getByRole('link', { name: 'Back to the dashboard' }).click();
    await app.page.waitForURL((url) => url.pathname === '/');
    await app.context.close();
  });

  it('pauses with the last data kept and refreshes nothing until the next interaction', async () => {
    const { app, responses } = await openTrip('plain-active-vp-tu', { fakeClock: true });
    await shown(app, responses);
    await app.page.clock.fastForward(61_000);
    await expect
      .poll(() => app.page.locator('[data-banner=paused-idle]').innerText())
      .toContain('Paused — no activity for a minute');
    await app.page.waitForLoadState('networkidle');
    const paused = responses().length;
    await advanceClock(app.page, 120_000);
    await app.page.waitForLoadState('networkidle');
    expect(responses()).toHaveLength(paused);
    expect(await app.page.locator('h1').innerText()).toBe('Trip plain-active-vp-tu');

    await app.page.mouse.move(40, 40);
    await expect.poll(() => responses().length).toBeGreaterThan(paused);
    await expect.poll(() => app.page.locator('[data-banner]').count()).toBe(0);
    await app.context.close();
  });

  it('has no horizontal page scroll at desktop or phone width', async () => {
    for (const [name, viewport] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      for (const tripId of ['freq-nominal', 'plain-active-vp-tu']) {
        const { app, responses } = await openTrip(tripId, { viewport });
        await shown(app, responses);
        if (tripId === 'plain-active-vp-tu') await mapReady(app);
        const overflow = await app.page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${name} ${tripId}`).toBeLessThanOrEqual(0);
        await screenshot(app.page, `trip-detail-${name}-${tripId}`);
        await app.context.close();
      }
    }
  });
});

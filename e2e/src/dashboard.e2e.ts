import type { Browser, ConsoleMessage } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Scenario } from '@gtfs-rt-debugger/fixtures';
import {
  DESKTOP,
  PHONE,
  advanceClock,
  launchBrowser,
  openApp,
  screenshot,
  setTabHidden,
  type AppPage,
} from './harness/browser.js';
import { alignToMinute, startStack, type Stack } from './harness/stack.js';
import {
  LIST_IDS,
  LIST_TITLES,
  REASON_TEXTS,
  expectedCells,
  normalizeCells,
  readList,
  readStats,
  type ListId,
} from './dashboard-reader.js';

let browser: Browser;
let stack: Stack;
let truth: Scenario['expected'];
/** The wall-clock minute the scenario was built in; checks against `truth` hold only within it. */
let scenarioMinute: number;

const minuteOf = (date: Date) => Math.floor(date.getTime() / 60_000);
const ROWS: Record<ListId, () => unknown[]> = {
  'active-with-realtime': () => truth.lists.activeWithRealtime,
  'active-without-realtime': () => truth.lists.activeWithoutRealtime,
  'unscheduled-with-realtime': () => truth.lists.unscheduledWithRealtime,
};

beforeAll(async () => {
  browser = await launchBrowser();
  await alignToMinute();
  stack = await startStack();
  truth = stack.feeds.scenario().expected;
  scenarioMinute = minuteOf(stack.feeds.scenario().now);
});

afterAll(async () => {
  await browser?.close();
  await stack?.close();
});

/** Fails with the real cause when a check ran in a later minute than the scenario was built for. */
function expectSameMinute() {
  expect(minuteOf(new Date()), 'the run crossed a minute boundary: rerun').toBe(scenarioMinute);
}

/** Resolves when the statistics are numbers and each list shows as many rows as its title counts. */
async function loaded(app: AppPage) {
  await app.page.waitForFunction(() => {
    const stat = document.querySelector('[data-stat="trips-today"] dd');
    const lists = [...document.querySelectorAll('[data-list]')];
    return (
      /^\d+$/.test(stat?.textContent?.trim() ?? '') &&
      lists.length === 3 &&
      lists.every((list) => {
        const count = /\((\d+)\)/.exec(list.querySelector('h2')?.textContent ?? '');
        return count !== null && list.querySelectorAll('li').length === Number(count[1]);
      })
    );
  });
}

async function open(options: Parameters<typeof openApp>[2] = {}) {
  const app = await openApp(browser, stack, options);
  const problems: string[] = [];
  app.page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });
  app.page.on('pageerror', (error) => problems.push(error.message));
  return { app, problems };
}

describe('dashboard against the scenario ground truth', () => {
  it('shows every statistic, the agency and the feed ages as the ground truth says', async () => {
    const { app, problems } = await open();
    await loaded(app);

    const stats = await readStats(app.page);
    expect(stats).toEqual({
      'trips-today': String(truth.stats.tripsToday),
      'trips-active': String(truth.stats.tripsActiveNow),
      vehicles: String(truth.stats.vehicles),
      'vehicles-with-trip-id': String(truth.stats.vehiclesWithTripId),
      'trip-updates': String(truth.stats.tripUpdates),
      'active-with-realtime': String(truth.stats.activeTripsWithRealtime),
    });

    const agency = truth.schedule.agency;
    await expect
      .poll(() => app.page.locator('[data-field=names]').innerText())
      .toBe(agency.names.join(', '));
    expect(await app.page.locator('[data-field=timezone]').innerText()).toBe(agency.timezone);
    expect(await app.page.locator('[data-field=clock]').innerText()).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [A-Z]{2,5}$/,
    );
    const ages = await app.page.getByLabel('Feed updates').innerText();
    expect(ages).toMatch(/Vehicle positions: updated \d+ s ago/);
    expect(ages).toMatch(/Trip updates: updated \d+ s ago/);

    expect(await app.page.locator('[data-banner]').count()).toBe(0);
    expect(problems).toEqual([]);
    expectSameMinute();
    await screenshot(app.page, 'dashboard-desktop');
    await app.context.close();
  });

  it('shows the three lists with their count titles, columns and order', async () => {
    const { app, problems } = await open();
    await loaded(app);

    for (const list of LIST_IDS) {
      const expectedRows = ROWS[list]() as Parameters<typeof expectedCells>[0][];
      const view = await readList(app.page, list);
      expect(view.heading).toBe(`${LIST_TITLES[list]} (${expectedRows.length})`);
      expect(view.rows.map((row) => normalizeCells(row.cells))).toEqual(
        expectedRows.map((row) => expectedCells(row, list)),
      );
      view.rows.forEach((row, index) => {
        const { tripId } = expectedRows[index] as { tripId: string };
        expect(row.href).toBe(`/trips/${encodeURIComponent(tripId)}`);
        if (list !== 'active-without-realtime')
          expect(row.cells['last-seen']).toMatch(/^\d+ (s|min|h)\b.*ago$/);
      });
    }
    expect(problems).toEqual([]);
    expectSameMinute();
    await app.context.close();
  });

  it('gives every reason its exact text', async () => {
    const { app } = await open();
    await loaded(app);
    const view = await readList(app.page, 'unscheduled-with-realtime');
    const shown = new Set(
      Object.keys(REASON_TEXTS).filter((reason) =>
        view.rows.some((row) => row.cells.reason?.startsWith(REASON_TEXTS[reason]!)),
      ),
    );
    const expected = new Set(truth.lists.unscheduledWithRealtime.map((row) => row.reason));
    expect(shown).toEqual(expected);
    // The scenario must exercise the table for this to mean something.
    expect(expected.size).toBeGreaterThanOrEqual(5);
    await app.context.close();
  });

  it('lists each frequency instance as its own row with its headway', async () => {
    const { app, problems } = await open();
    await loaded(app);
    const rows = [
      ...(await readList(app.page, 'active-with-realtime')).rows,
      ...(await readList(app.page, 'active-without-realtime')).rows,
    ];
    const frequency = [
      ...truth.lists.activeWithRealtime,
      ...truth.lists.activeWithoutRealtime,
    ].filter((row) => row.frequency);
    expect(frequency.length).toBeGreaterThan(0);
    const frequencyRows = rows.filter((row) => row.cells.schedule?.includes('departs every'));
    expect(frequencyRows).toHaveLength(frequency.length);
    const ids = frequencyRows.map((row) => row.cells.trip);
    expect(new Set(ids).size).toBeLessThan(ids.length); // instances share a trip ID
    expect(problems).toEqual([]);
    expectSameMinute();
    await app.context.close();
  });

  it('shows the configuration errors by error, not by trip, with each message', async () => {
    const { app } = await open();
    await loaded(app);
    const errors = truth.configurationErrors;
    const notice = app.page.locator('[data-notice=configuration-errors]');
    await expect
      .poll(() => notice.innerText())
      .toContain(
        `${errors.length} schedule configuration errors: the trips concerned are excluded from the counts and lists`,
      );
    // A trip with two codes counts twice.
    expect(new Set(errors.map((e) => e.tripId)).size).toBeLessThan(errors.length);

    expect(await notice.locator('li').count()).toBe(0);
    await notice.getByRole('button', { name: /show the trips/i }).click();
    const items = await notice.locator('li').evaluateAll((nodes) =>
      nodes.map((node) => ({
        code: node.getAttribute('data-code'),
        tripId: node.querySelector('a')!.textContent,
        href: node.querySelector('a')!.getAttribute('href'),
        message: (node.textContent ?? '')
          .replace(node.querySelector('a')!.textContent ?? '', '')
          .trim(),
      })),
    );
    expect(items.map(({ code, tripId }) => ({ code, tripId }))).toEqual(
      errors.map(({ code, tripId }) => ({ code, tripId })),
    );
    expect(new Set(items.map((item) => item.code))).toEqual(
      new Set(['mixed_exact_times', 'unusable_stop_times', 'frequency_too_dense']),
    );
    for (const item of items) {
      expect(item.href).toBe(`/trips/${encodeURIComponent(item.tripId!)}`);
      expect(item.message.length).toBeGreaterThan(10);
    }
    await screenshot(app.page, 'config-errors-open');
    await app.context.close();
  });

  it('filters each list on its own by trip ID and route', async () => {
    const { app } = await open();
    await loaded(app);
    const list = 'active-with-realtime';
    const rows = truth.lists.activeWithRealtime;
    const first = rows[0]!;
    const box = app.page.getByRole('searchbox', { name: `Search ${LIST_TITLES[list]}` });

    await box.fill(first.tripId.toUpperCase());
    const byTrip = rows.filter((r) => r.tripId.toLowerCase().includes(first.tripId.toLowerCase()));
    await expect.poll(async () => (await readList(app.page, list)).rows.length).toBe(byTrip.length);
    // The title keeps counting the whole list.
    expect((await readList(app.page, list)).heading).toBe(`${LIST_TITLES[list]} (${rows.length})`);

    const routeText = first.routeShortName ?? first.routeLongName ?? first.routeId!;
    await box.fill(routeText);
    const needle = routeText.toLowerCase();
    const byRoute = rows.filter((r) =>
      [r.tripId, r.routeId, r.routeShortName, r.routeLongName].some((f) =>
        f?.toLowerCase().includes(needle),
      ),
    );
    await expect
      .poll(async () => (await readList(app.page, list)).rows.length)
      .toBe(byRoute.length);

    // Other lists are untouched.
    expect((await readList(app.page, 'active-without-realtime')).rows).toHaveLength(
      truth.lists.activeWithoutRealtime.length,
    );

    await box.fill('no-such-trip-anywhere');
    await expect
      .poll(() => app.page.locator(`[data-list=${list}] [data-slot=empty]`).innerText())
      .toBe('No trips match “no-such-trip-anywhere”.');
    await box.fill('');
    await expect.poll(async () => (await readList(app.page, list)).rows.length).toBe(rows.length);
    await app.context.close();
  });

  it('opens the trip detail from a row, with no query', async () => {
    const { app } = await open();
    await loaded(app);
    const target = truth.lists.unscheduledWithRealtime.find((row) =>
      /[^A-Za-z0-9_-]/.test(row.tripId),
    );
    const row = target ?? truth.lists.unscheduledWithRealtime[0]!;
    await app.page
      .locator(`[data-list=unscheduled-with-realtime] a[data-trip-id="${row.tripId}"]`)
      .first()
      .click();
    await app.page.waitForURL(/\/trips\//);
    const url = new URL(app.page.url());
    expect(url.pathname).toBe(`/trips/${encodeURIComponent(row.tripId)}`);
    expect(url.search).toBe('');
    await app.page.getByText(`Trip ${row.tripId}`).waitFor();
    await app.context.close();
  });

  it('has no horizontal page scroll at desktop or phone width, and screenshots both', async () => {
    for (const [name, viewport] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      const { app } = await open({ viewport });
      await loaded(app);
      const overflow = await app.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${name} overflow`).toBeLessThanOrEqual(0);
      await screenshot(app.page, `dashboard-${name}-full`);
      await screenshot(app.page, `dashboard-${name}-top`, {
        x: 0,
        y: 0,
        width: viewport.width,
        height: 1400,
      });
      await app.context.close();
    }
  });
});

describe('pausing', () => {
  it('stops all requests after 60 s without interaction, and resumes with a ping on the next one', async () => {
    const { app } = await open({ fakeClock: true });
    await loaded(app);
    const before = app.apiRequests().length;
    expect(app.apiRequests()[0]).toEqual({ method: 'POST', path: '/api/v1/session/start' });

    await app.page.clock.fastForward(61_000);
    await expect
      .poll(() => app.page.locator('[data-banner=paused-idle]').innerText())
      .toContain('Paused — no activity for a minute');
    await screenshot(app.page, 'paused-idle');

    // Let any request already on its way finish, then measure.
    await app.page.waitForLoadState('networkidle');
    const paused = app.apiRequests().length;
    expect(paused).toBeGreaterThanOrEqual(before);
    await advanceClock(app.page, 120_000);
    await app.page.waitForLoadState('networkidle');
    expect(app.apiRequests()).toHaveLength(paused);
    // The last data stays on screen.
    expect((await readStats(app.page))['trips-today']).toMatch(/^\d+$/);

    await app.page.mouse.move(40, 40);
    await expect.poll(() => app.page.locator('[data-banner]').count()).toBe(0);
    // The ping, then the dashboard and the three lists.
    await expect.poll(() => app.apiRequests().length - paused).toBeGreaterThanOrEqual(5);
    const after = app
      .apiRequests()
      .slice(paused)
      .map((r) => `${r.method} ${r.path}`);
    expect(after[0]).toBe('POST /api/v1/session/ping');
    expect(after).toContain('GET /api/v1/dashboard');
    expect(after.some((r) => r.startsWith('GET /api/v1/trips?list='))).toBe(true);
    expect(after).not.toContain('POST /api/v1/session/start');
    await app.context.close();
  });

  it('stops all requests while the tab is hidden, and resumes when it is shown', async () => {
    const { app } = await open({ fakeClock: true });
    await loaded(app);
    await setTabHidden(app.page, true);
    await expect
      .poll(() => app.page.locator('[data-banner=paused-hidden]').innerText())
      .toContain('Paused — tab hidden');
    await app.page.waitForLoadState('networkidle');
    const paused = app.apiRequests().length;
    await advanceClock(app.page, 120_000);
    await app.page.waitForLoadState('networkidle');
    expect(app.apiRequests()).toHaveLength(paused);

    await setTabHidden(app.page, false);
    await expect.poll(() => app.page.locator('[data-banner]').count()).toBe(0);
    await expect.poll(() => app.apiRequests().length).toBeGreaterThan(paused);
    expect(app.apiRequests()[paused]).toEqual({ method: 'POST', path: '/api/v1/session/ping' });
    await app.context.close();
  });
});

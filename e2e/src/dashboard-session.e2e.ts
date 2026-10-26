import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DashboardResponse, SessionStatus } from '@gtfs-rt-debugger/shared';
import {
  advanceClock,
  launchBrowser,
  openApp,
  screenshot,
  type AppPage,
} from './harness/browser.js';
import { startStack, type Stack } from './harness/stack.js';
import { readList, readStats } from './dashboard-reader.js';

let browser: Browser;
const stacks: Stack[] = [];

beforeAll(async () => {
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await Promise.all(stacks.map((stack) => stack.close()));
});

async function boot(options: Parameters<typeof startStack>[0] = {}) {
  const stack = await startStack(options);
  stacks.push(stack);
  return stack;
}

const session = (stack: Stack, kind: 'start' | 'ping') =>
  fetch(`${stack.baseUrl}/api/v1/session/${kind}`, { method: 'POST' }).then(
    (response) => response.json() as Promise<SessionStatus>,
  );

const dashboard = (stack: Stack) =>
  fetch(`${stack.baseUrl}/api/v1/dashboard`).then(async (response) => ({
    status: response.status,
    body: (await response.json()) as DashboardResponse,
  }));

/** Polls `check` until it returns a value; the server's own timers are what is being waited for. */
async function until<T>(check: () => Promise<T | false | null | undefined>): Promise<T> {
  let value: T | false | null | undefined;
  await expect.poll(async () => (value = await check()), { timeout: 30_000 }).toBeTruthy();
  return value as T;
}

const banner = (app: AppPage, id: string) => app.page.locator(`[data-banner=${id}]`);
const noBanner = (app: AppPage) =>
  expect.poll(() => app.page.locator('[data-banner]').count()).toBe(0);

describe('schedule loading, a flaky feed, and an unreachable server', () => {
  it('walks from loading to ready, then to a stale feed and an unreachable server, keeping its data', async () => {
    const stack = await boot({ feeds: { slowMs: 4000 } });
    await stack.setFeedMode('schedule', 'slow');
    // Wake the server and let the first vehicle snapshot arrive while the schedule still downloads.
    await session(stack, 'start');
    await until(async () => (await dashboard(stack)).body.realtime.vehicles !== null);

    const app = await openApp(browser, stack, { fakeClock: true });
    await expect
      .poll(() => banner(app, 'schedule-loading').innerText())
      .toContain('Downloading the schedule…');
    await expect.poll(async () => (await readStats(app.page)).vehicles).toMatch(/^\d+$/); // realtime statistics already show
    expect(await readStats(app.page)).toMatchObject({
      'trips-today': 'Loading',
      'active-with-realtime': 'Loading',
    });
    expect(app.apiRequests().filter((r) => r.path.startsWith('/api/v1/trips'))).toEqual([]);
    await screenshot(app.page, 'schedule-loading');

    // The schedule becomes ready; the page learns of it with its next ping.
    await until(async () => (await dashboard(stack)).body.schedule);
    await advanceClock(app.page, 10_000);
    await noBanner(app);
    await expect.poll(async () => (await readStats(app.page))['trips-today']).toMatch(/^\d+$/);
    await expect
      .poll(async () => (await readList(app.page, 'active-with-realtime')).rows.length)
      .toBeGreaterThan(0);
    const statsBefore = await readStats(app.page);
    const rowsBefore = (await readList(app.page, 'active-with-realtime')).rows.length;

    // The vehicle positions feed starts failing and turns stale within a few poll intervals.
    await stack.setFeedMode('vp', 'http500');
    await until(async () => (await session(stack, 'ping')).realtime.vehiclePositions?.stale);
    await advanceClock(app.page, 10_000);
    await expect
      .poll(() => banner(app, 'stale-feed').innerText())
      .toContain('Vehicle positions feed is stale.');
    expect(await banner(app, 'stale-feed').innerText()).toMatch(
      /last successful update \d+ (s|min) ago/,
    );
    expect(await readStats(app.page)).toEqual(statsBefore);
    expect((await readList(app.page, 'active-with-realtime')).rows).toHaveLength(rowsBefore);
    await screenshot(app.page, 'stale-feed');

    // The API stops answering altogether: that outranks the stale notice, and the data stays.
    await app.context.route('**/api/**', (route) => route.abort());
    await advanceClock(app.page, 10_000);
    await expect
      .poll(() => banner(app, 'unreachable').innerText())
      .toContain("Can't reach the server.");
    expect(await readStats(app.page)).toEqual(statsBefore);
    expect((await readList(app.page, 'active-with-realtime')).rows).toHaveLength(rowsBefore);
    await screenshot(app.page, 'unreachable');

    await app.context.unroute('**/api/**');
    await advanceClock(app.page, 10_000);
    await expect.poll(() => banner(app, 'stale-feed').count()).toBe(1);
    await app.context.close();
  });
});

describe('schedule failure', () => {
  it('shows the error with Retry, and Retry loads the schedule', async () => {
    const stack = await boot();
    await stack.setFeedMode('schedule', 'http500');
    const app = await openApp(browser, stack, { fakeClock: true });
    await expect
      .poll(() => banner(app, 'schedule-failed').innerText())
      .toContain("Couldn't load the schedule.");
    expect(await banner(app, 'schedule-failed').innerText()).toMatch(/500/);
    await screenshot(app.page, 'schedule-failed');
    expect(await readStats(app.page)).toMatchObject({ 'trips-today': 'Loading' });

    await stack.setFeedMode('schedule', 'ok');
    const startsBefore = app.apiRequests().filter((r) => r.path.endsWith('/session/start')).length;
    await app.page.getByRole('button', { name: 'Retry' }).click();
    await expect
      .poll(() => app.apiRequests().filter((r) => r.path.endsWith('/session/start')).length)
      .toBe(startsBefore + 1);
    await until(async () => (await dashboard(stack)).body.schedule);
    await advanceClock(app.page, 10_000);
    await noBanner(app);
    await expect.poll(async () => (await readStats(app.page))['trips-today']).toMatch(/^\d+$/);
    await app.context.close();
  });
});

describe('maximum duration', () => {
  it('ends the session with Restart, sends nothing meanwhile, and Restart begins a new one', async () => {
    const stack = await boot({ env: { MAX_ACTIVATION_MS: '8000' } });
    const app = await openApp(browser, stack, { fakeClock: true });
    // The schedule is still downloading at the first poll: move on to the next one.
    await until(async () => (await dashboard(stack)).body.schedule);
    await advanceClock(app.page, 10_000);
    await expect.poll(async () => (await readStats(app.page))['trips-today']).toMatch(/^\d+$/);
    const statsBefore = await readStats(app.page);

    // The activation ends on the server; the page learns with its next ping.
    await until(async () => (await dashboard(stack)).status === 409);
    await advanceClock(app.page, 10_000);
    await expect
      .poll(() => banner(app, 'ended').innerText())
      .toContain('Session ended after the maximum running time.');
    // The ended notice outranks "paused", and the last data stays.
    expect(await app.page.locator('[data-banner]').count()).toBe(1);
    expect(await readStats(app.page)).toEqual(statsBefore);
    await screenshot(app.page, 'session-ended');

    await app.page.waitForLoadState('networkidle');
    const sent = app.apiRequests().length;
    await app.page.mouse.move(30, 30);
    await advanceClock(app.page, 120_000);
    await app.page.waitForLoadState('networkidle');
    expect(app.apiRequests()).toHaveLength(sent);

    await app.page.getByRole('button', { name: 'Restart' }).click();
    await expect
      .poll(() => app.apiRequests().slice(sent)[0])
      .toEqual({
        method: 'POST',
        path: '/api/v1/session/start',
      });
    await expect.poll(() => banner(app, 'ended').count()).toBe(0);
    // A new activation: the data returns once its schedule has loaded.
    await until(async () => (await dashboard(stack)).body.schedule);
    await advanceClock(app.page, 10_000);
    await noBanner(app);
    await expect.poll(async () => (await readStats(app.page))['trips-today']).toMatch(/^\d+$/);
    await app.context.close();
  });
});

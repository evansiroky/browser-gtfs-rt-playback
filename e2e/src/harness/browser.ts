import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { Stack } from './stack.js';

/** A request the page made to the app's own origin. */
export interface LoggedRequest {
  method: string;
  /** Path and query, for example `/api/v1/trips?list=active-with-realtime`. */
  path: string;
}

export interface AppPage {
  page: Page;
  context: BrowserContext;
  /** Every request to the app's own origin so far, in order. */
  requests: LoggedRequest[];
  /** Requests whose path starts with `/api/` so far. */
  apiRequests(): LoggedRequest[];
}

export const DESKTOP = { width: 1280, height: 900 } as const;
export const PHONE = { width: 390, height: 844 } as const;

/** MapLibre needs WebGL; headless Chromium gets it from the software rasterizer. */
const WEBGL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ args: WEBGL_ARGS });
}

/** The origin and style URL the web app's map loads ({@link MAP_STYLE_URL} in the web app). */
const TILE_ORIGIN = 'https://tiles.openfreemap.org';
const STYLE_URL = `${TILE_ORIGIN}/styles/liberty`;

/** A style with a plain background: no tiles, sprites or glyphs to fetch, and nothing to wait for. */
const STUB_STYLE = {
  version: 8,
  name: 'e2e',
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dfe7ee' } }],
};

/**
 * Map tiles, styles, glyphs and sprites live on hosts that are unreachable from the test
 * machine and must not be contacted: the map style resolves to a tiny local one so the map
 * really renders, and every other request to any host but the app's gets an empty success so
 * the page never waits on the network.
 */
async function stubExternalRequests(context: BrowserContext, origin: string): Promise<void> {
  await context.route(
    (url) => url.origin !== origin,
    (route) => {
      const url = route.request().url();
      if (url === STYLE_URL) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(STUB_STYLE),
        });
      }
      if (url.endsWith('.json')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 204, body: '' });
    },
  );
}

export interface OpenOptions {
  viewport?: { width: number; height: number };
  /**
   * Install Playwright's controllable clock before the page loads, so a test can move the page's
   * timers forward ({@link advanceClock}) instead of waiting for real seconds to pass.
   */
  fakeClock?: boolean;
  /** Path and query to open. Default `/`. */
  path?: string;
  /** Runs on the new page before it navigates, to attach listeners that must see every request. */
  beforeGoto?: (page: Page) => void;
}

/** A fresh browser context and page on the app, with the external stubs and a request log. */
export async function openApp(
  browser: Browser,
  stack: Stack,
  options: OpenOptions = {},
): Promise<AppPage> {
  const context = await browser.newContext({ viewport: options.viewport ?? DESKTOP });
  const origin = new URL(stack.baseUrl).origin;
  await stubExternalRequests(context, origin);
  const page = await context.newPage();
  const requests: LoggedRequest[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) {
      requests.push({ method: request.method(), path: url.pathname + url.search });
    }
  });
  if (options.fakeClock) await page.clock.install();
  options.beforeGoto?.(page);
  await page.goto(new URL(options.path ?? '/', stack.baseUrl).toString());
  return {
    page,
    context,
    requests,
    apiRequests: () => requests.filter((request) => request.path.startsWith('/api/')),
  };
}

/** Moves the page's timers forward by `ms`, firing everything that falls due (needs `fakeClock`). */
export async function advanceClock(page: Page, ms: number): Promise<void> {
  await page.clock.runFor(ms);
}

/** Makes the page believe its tab is hidden (or visible again) and tells it so. */
export async function setTabHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((isHidden) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (isHidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** Saves a screenshot when `E2E_SCREENSHOT_DIR` is set; otherwise does nothing. */
export async function screenshot(
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir)
    await page.screenshot({
      path: `${dir}/${name}.png`,
      ...(clip ? { clip, fullPage: true } : { fullPage: true }),
    });
}

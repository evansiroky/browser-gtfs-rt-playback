import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  startFakeFeeds,
  type FakeFeeds,
  type FakeFeedsOptions,
  type FeedMode,
  type FeedName,
} from '@gtfs-rt-debugger/fixtures';
import { freePort } from './ports.js';

const SERVER_MAIN = fileURLToPath(new URL('../../../server/dist/main.js', import.meta.url));
const WEB_DIST = fileURLToPath(new URL('../../../web/dist', import.meta.url));

/**
 * Server settings for tests: short feed polling so a failing feed turns stale within seconds,
 * no rate limit, no exit when idle. Tests override what they exercise through
 * {@link StackOptions.env}.
 */
const TEST_ENV: Record<string, string> = {
  POLL_INTERVAL_MS: '1000',
  RT_TIMEOUT_MS: '2000',
  RATE_LIMIT_PER_MIN: '1000000',
  EXIT_ON_IDLE: 'false',
};

export interface StackOptions {
  /** Forwarded to the fake feeds host (clock, scenario options). */
  feeds?: FakeFeedsOptions;
  /** Server environment variables, over the test defaults. */
  env?: Record<string, string>;
}

export interface Stack {
  /** The app's origin: the server serving the built web app and the API. */
  baseUrl: string;
  feeds: FakeFeeds;
  /** Sets how a fake feed behaves from now on. */
  setFeedMode(feed: FeedName, mode: FeedMode): Promise<void>;
  /** The server's log so far, for failure reports. */
  serverLog(): string;
  close(): Promise<void>;
}

/** Fails early, with the fix, when the build the harness serves is missing. */
function requireBuild(): void {
  for (const path of [SERVER_MAIN, `${WEB_DIST}/index.html`]) {
    if (!existsSync(path)) {
      throw new Error(`${path} is missing: run "npm run build" first (or use "npm run e2e").`);
    }
  }
}

/** Resolves once the server answers HTTP at all (a dormant server answers 409 to data reads). */
async function waitUntilListening(baseUrl: string, child: ChildProcess, log: () => string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the server exited with code ${child.exitCode} before listening:\n${log()}`);
    }
    try {
      await fetch(`${baseUrl}/api/v1/dashboard`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`the server did not start listening within 20 s:\n${log()}`);
}

/**
 * Boots everything an end-to-end check needs: the fake feeds host (in this process), and the
 * built server (a child process) pointed at it, serving the built web app. Close it when done.
 */
export async function startStack(options: StackOptions = {}): Promise<Stack> {
  requireBuild();
  const feeds = await startFakeFeeds(options.feeds);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let log = '';
  const child = spawn(process.execPath, [SERVER_MAIN], {
    env: {
      ...process.env,
      ...TEST_ENV,
      SCHEDULE_URL: feeds.urls.schedule,
      VEHICLE_POSITIONS_URL: feeds.urls.vehiclePositions,
      TRIP_UPDATES_URL: feeds.urls.tripUpdates,
      WEB_DIST_DIR: WEB_DIST,
      PORT: String(port),
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer) => {
    log = (log + chunk.toString('utf8')).slice(-20_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const close = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    await feeds.close();
  };

  try {
    await waitUntilListening(baseUrl, child, () => log);
  } catch (error) {
    await close();
    throw error;
  }

  return {
    baseUrl,
    feeds,
    serverLog: () => log,
    async setFeedMode(feed, mode) {
      const response = await fetch(feeds.urls.control, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feed, mode }),
      });
      if (!response.ok) throw new Error(`fake feeds refused ${feed}=${mode}: ${response.status}`);
    },
    close,
  };
}

/**
 * Waits for the start of a wall-clock minute when fewer than `windowSeconds` of the current one
 * remain. The server decides which trips are active from its own clock, to the minute, so a check
 * of the lists against the scenario's ground truth must not straddle a minute boundary.
 */
export async function alignToMinute(windowSeconds = 35): Promise<void> {
  const now = new Date();
  const second = now.getSeconds() + now.getMilliseconds() / 1000;
  if (second <= 60 - windowSeconds) return;
  await new Promise((resolve) => setTimeout(resolve, (60 - second + 0.5) * 1000));
}

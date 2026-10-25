import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { scenario, type Scenario, type ScenarioOptions } from './scenario.js';
import type { Feeds } from './rt.js';

export type FeedName = 'vp' | 'tu' | 'schedule';
export type FeedMode = 'ok' | 'http500' | 'timeout' | 'garbage' | 'old-data' | 'slow';

const FEEDS: readonly FeedName[] = ['vp', 'tu', 'schedule'];
const MODES: readonly FeedMode[] = ['ok', 'http500', 'timeout', 'garbage', 'old-data', 'slow'];
const OLD_DATA_AGE_SECS = 3600;
const GARBAGE = Buffer.from('this is not a valid feed\n');

const PATHS: Record<string, FeedName> = {
  '/schedule.zip': 'schedule',
  '/vehicle-positions.pb': 'vp',
  '/trip-updates.pb': 'tu',
};

export interface FakeFeedsOptions {
  /** Default 0: let the OS pick a free port. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
  /**
   * Freeze the clock at this instant and build the scenario for it. Without it the scenario is
   * built for the moment of startup and the clock follows the wall clock, so vehicles advance.
   */
  now?: Date;
  /** Delay applied by the `slow` mode. Default 3000 ms. */
  slowMs?: number;
  scenario?: ScenarioOptions;
}

export interface FakeFeeds {
  urls: { schedule: string; vehiclePositions: string; tripUpdates: string; control: string };
  /** The scenario currently being served (replaced when the control endpoint sets `now`). */
  scenario(): Scenario;
  close(): Promise<void>;
}

interface State {
  scenario: Scenario;
  modes: Record<FeedName, FeedMode>;
  slowMs: number;
  /** When set, the clock reads this wall-clock-independent instant (plus `offsetMs`). */
  frozenAt: number | null;
  offsetMs: number;
  /** The bytes `old-data` mode repeats, captured by the first request after the mode was set. */
  oldDataFeeds: Partial<Record<'vp' | 'tu', Uint8Array>>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2) + '\n';
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function send(res: ServerResponse, status: number, type: string, body: Uint8Array): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeFeeds(options: FakeFeedsOptions = {}): Promise<FakeFeeds> {
  const scenarioOptions = options.scenario ?? {};
  const startedAt = options.now ?? new Date();
  const state: State = {
    scenario: scenario(startedAt, scenarioOptions),
    modes: { vp: 'ok', tu: 'ok', schedule: 'ok' },
    slowMs: options.slowMs ?? 3000,
    frozenAt: options.now ? options.now.getTime() : null,
    offsetMs: 0,
    oldDataFeeds: {},
  };

  const clock = (): number => (state.frozenAt ?? Date.now()) + state.offsetMs;
  /** Seconds the clock has moved since the scenario was built. */
  const elapsed = (): number => Math.floor((clock() - state.scenario.now.getTime()) / 1000);
  const feedsAt = (seconds: number): Feeds => state.scenario.advance(seconds);

  const hanging = new Set<ServerResponse>();
  const timers = new Set<NodeJS.Timeout>();

  function status() {
    return {
      modes: state.modes,
      slowMs: state.slowMs,
      now: new Date(clock()).toISOString(),
      scenarioNow: state.scenario.now.toISOString(),
      frozen: state.frozenAt !== null,
    };
  }

  function serve(feed: FeedName, res: ServerResponse): void {
    if (feed === 'schedule') return send(res, 200, 'application/zip', state.scenario.scheduleZip);
    const mode = state.modes[feed];
    const body =
      mode === 'old-data'
        ? (state.oldDataFeeds[feed] ??= pick(feedsAt(elapsed() - OLD_DATA_AGE_SECS), feed))
        : pick(feedsAt(elapsed()), feed);
    send(res, 200, 'application/x-protobuf', body);
  }

  const pick = (feeds: Feeds, feed: 'vp' | 'tu'): Uint8Array =>
    feed === 'vp' ? feeds.vehiclePositions : feeds.tripUpdates;

  function handleFeed(feed: FeedName, res: ServerResponse): void {
    const type = feed === 'schedule' ? 'application/zip' : 'application/x-protobuf';
    switch (state.modes[feed]) {
      case 'http500':
        return send(res, 500, 'text/plain', Buffer.from('fake feed failure\n'));
      case 'timeout':
        // Never answer; the client's own timeout has to fire.
        hanging.add(res);
        res.on('close', () => hanging.delete(res));
        return;
      case 'garbage':
        return send(res, 200, type, GARBAGE);
      case 'slow': {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!res.destroyed) serve(feed, res);
        }, state.slowMs);
        timers.add(timer);
        res.on('close', () => {
          clearTimeout(timer);
          timers.delete(timer);
        });
        return;
      }
      default:
        return serve(feed, res);
    }
  }

  async function handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') return json(res, 200, status());
    if (req.method !== 'POST' && req.method !== 'PUT') {
      return json(res, 405, { error: 'use GET, POST or PUT' });
    }
    // Only a JSON content type: a cross-origin page can send text/plain or a form without a
    // preflight, but not application/json.
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      return json(res, 415, { error: 'send Content-Type: application/json' });
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    } catch {
      return json(res, 400, { error: 'body must be a JSON object' });
    }
    const { feed, mode, now, advance, slowMs } = body;
    if ((feed === undefined) !== (mode === undefined)) {
      return json(res, 400, { error: '`feed` and `mode` go together' });
    }
    if (feed !== undefined && !FEEDS.includes(feed as FeedName)) {
      return json(res, 400, { error: `feed must be one of ${FEEDS.join(', ')}` });
    }
    if (mode !== undefined && !MODES.includes(mode as FeedMode)) {
      return json(res, 400, { error: `mode must be one of ${MODES.join(', ')}` });
    }
    let nextNow: Date | null | undefined;
    if (now !== undefined) {
      nextNow = now === null ? null : new Date(String(now));
      if (nextNow !== null && Number.isNaN(nextNow.getTime())) {
        return json(res, 400, { error: '`now` must be an ISO 8601 instant or null' });
      }
    }
    if (advance !== undefined && (typeof advance !== 'number' || !Number.isFinite(advance))) {
      return json(res, 400, { error: '`advance` must be a number of seconds' });
    }
    if (slowMs !== undefined && (typeof slowMs !== 'number' || !(slowMs >= 0))) {
      return json(res, 400, { error: '`slowMs` must be a non-negative number' });
    }

    if (nextNow !== undefined) {
      // A new instant rebuilds the scenario around it; null returns to the wall clock.
      state.scenario = scenario(nextNow ?? new Date(), scenarioOptions);
      state.frozenAt = nextNow === null ? null : nextNow.getTime();
      state.offsetMs = 0;
      state.oldDataFeeds = {};
    }
    if (typeof advance === 'number') state.offsetMs += advance * 1000;
    if (typeof slowMs === 'number') state.slowMs = slowMs;
    if (feed !== undefined) {
      const name = feed as FeedName;
      state.modes[name] = mode as FeedMode;
      if (name !== 'schedule') delete state.oldDataFeeds[name];
    }
    json(res, 200, status());
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/__control') {
      handleControl(req, res).catch(() => json(res, 500, { error: 'control failed' }));
    } else if (path === '/__scenario') {
      // `expected` describes the instant the scenario was built for, not the (possibly advanced) clock.
      json(res, 200, {
        now: new Date(clock()).toISOString(),
        scenarioNow: state.scenario.now.toISOString(),
        expected: state.scenario.expected,
      });
    } else if (PATHS[path] && (req.method === 'GET' || req.method === 'HEAD')) {
      handleFeed(PATHS[path], res);
    } else {
      json(res, 404, { error: 'not found' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://${options.host ?? '127.0.0.1'}:${port}`;

  return {
    urls: {
      schedule: `${origin}/schedule.zip`,
      vehiclePositions: `${origin}/vehicle-positions.pb`,
      tripUpdates: `${origin}/trip-updates.pb`,
      control: `${origin}/__control`,
    },
    scenario: () => state.scenario,
    close() {
      for (const timer of timers) clearTimeout(timer);
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

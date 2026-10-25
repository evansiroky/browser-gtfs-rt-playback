import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config, type Env } from '../config.js';
import { SecretUrl } from '../secret-url.js';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { transit_realtime } = GtfsRealtimeBindings;
type IFeedHeader = GtfsRealtimeBindings.transit_realtime.IFeedHeader;
type IFeedEntity = GtfsRealtimeBindings.transit_realtime.IFeedEntity;

/** Encodes a minimal valid GTFS-RT FeedMessage. */
export function encodeFeed({
  timestamp = 1_768_478_400,
  vehicles = 1,
  padding = 0,
}: { timestamp?: number | null; vehicles?: number; padding?: number } = {}): Uint8Array {
  const header: IFeedHeader = { gtfsRealtimeVersion: '2.0' };
  if (timestamp !== null) header.timestamp = timestamp;
  const entity: IFeedEntity[] = Array.from({ length: vehicles }, (_, i) => ({
    id: `v${i}`,
    vehicle: {
      trip: { tripId: `trip-${i}` },
      vehicle: { id: `bus-${i}`, label: 'x'.repeat(padding) },
      timestamp,
    },
  }));
  return transit_realtime.FeedMessage.encode(
    transit_realtime.FeedMessage.create({ header, entity }),
  ).finish();
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface FeedHost {
  readonly origin: string;
  /** Requests received so far, by path (including query). */
  readonly requests: string[];
  /** Replaces the handler for a path (matched without the query string). */
  route(path: string, handler: Handler): void;
  /** Resolves when the next request for `path` arrives. */
  nextRequest(path: string): Promise<void>;
  url(path: string): SecretUrl;
  close(): Promise<void>;
}

/** A real HTTP server on an ephemeral localhost port standing in for a feed host. */
export async function startFeedHost(): Promise<FeedHost> {
  const handlers = new Map<string, Handler>();
  const waiters = new Map<string, Array<() => void>>();
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    requests.push(req.url ?? '/');
    for (const resolve of waiters.get(path) ?? []) resolve();
    waiters.delete(path);
    const handler = handlers.get(path);
    if (handler) handler(req, res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    route: (path, handler) => void handlers.set(path, handler),
    nextRequest: (path) =>
      new Promise<void>((resolve) => waiters.set(path, [...(waiters.get(path) ?? []), resolve])),
    url: (path) => new SecretUrl(new URL(path, origin)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function serveBytes(bytes: Uint8Array, headers: Record<string, string> = {}): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-protobuf', ...headers });
    res.end(bytes);
  };
}

/** A config with valid placeholder feed URLs, overridden by `env`. */
export function testConfig(env: Env = {}): Config {
  return loadConfig({
    SCHEDULE_URL: 'https://schedule.example.test/gtfs.zip',
    VEHICLE_POSITIONS_URL: 'https://rt.example.test/vp',
    TRIP_UPDATES_URL: 'https://rt.example.test/tu',
    WEB_DIST_DIR: '/nonexistent-web-dist',
    ...env,
  });
}

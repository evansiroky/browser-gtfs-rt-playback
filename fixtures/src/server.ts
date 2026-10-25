/** `npm run fake-feeds`: serves the fixture scenario over HTTP for development and e2e runs. */
import { startFakeFeeds } from './fake-server.js';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const port = Number(arg('port') ?? process.env.PORT ?? 4200);
const nowArg = arg('now') ?? process.env.FAKE_FEEDS_NOW;
const now = nowArg ? new Date(nowArg) : undefined;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad port: ${port}`);
if (now && Number.isNaN(now.getTime()))
  throw new Error(`--now is not an ISO 8601 instant: ${nowArg}`);

const feeds = await startFakeFeeds({
  port,
  host: arg('host') ?? process.env.HOST,
  now,
  slowMs: process.env.FAKE_FEEDS_SLOW_MS ? Number(process.env.FAKE_FEEDS_SLOW_MS) : undefined,
});

const { urls } = feeds;
console.log(
  `Fake feeds up; scenario built for ${feeds.scenario().now.toISOString()}${now ? ' (clock frozen)' : ''}`,
);
console.log(`  schedule           ${urls.schedule}`);
console.log(`  vehicle positions  ${urls.vehiclePositions}`);
console.log(`  trip updates       ${urls.tripUpdates}`);
console.log(
  `  control            ${urls.control}   (POST {"feed":"vp|tu|schedule","mode":"ok|http500|timeout|garbage|stale|slow"})`,
);
console.log(`  ground truth       ${urls.control.replace('__control', '__scenario')}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void feeds.close().then(() => process.exit(0));
  });
}

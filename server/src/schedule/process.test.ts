import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenario } from '@gtfs-rt-debugger/fixtures';
import type { SessionStatus, ShapeResponse } from '@gtfs-rt-debugger/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFeedHost, type FeedHost } from '../test-support/feeds.js';

// The real entry point, as built by `npm test` (`tsc -b` runs first).
const MAIN = fileURLToPath(new URL('../../dist/main.js', import.meta.url));
const sc = scenario(new Date('2026-10-14T19:07:42Z'));

let child: ChildProcess | undefined;
let host: FeedHost | undefined;
afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
  await host?.close();
  host = undefined;
});

describe('the built server process loads the schedule at session start', () => {
  it('downloads once, serves shapes, and does not download again for later starts and pings', async () => {
    host = await startFeedHost();
    host.route('/schedule.zip', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/zip' }).end(sc.scheduleZip);
    });
    const proc = spawn(process.execPath, [MAIN], {
      env: {
        PATH: process.env.PATH ?? '',
        SCHEDULE_URL: `${host.origin}/schedule.zip?api_key=SUPERSECRET123`,
        VEHICLE_POSITIONS_URL: `${host.origin}/vp`,
        WEB_DIST_DIR: '/nonexistent-web-dist',
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    let output = '';
    const port = await new Promise<number>((resolve, reject) => {
      proc.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = /listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
        if (match?.[1]) resolve(Number(match[1]));
      });
      proc.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      proc.on('exit', () => reject(new Error(`server exited early:\n${output}`)));
    });
    const call = async (method: string, path: string) =>
      fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method });
    const schedule = async (method: string, path: string) =>
      ((await (await call(method, path)).json()) as SessionStatus).schedule;
    const downloads = () => host!.requests.filter((url) => url.startsWith('/schedule.zip'));

    expect(await schedule('POST', '/session/ping')).toMatchObject({ state: 'loading' });
    await vi.waitFor(
      async () => expect((await schedule('POST', '/session/ping')).state).toBe('ready'),
      {
        timeout: 15_000,
      },
    );
    await call('POST', '/session/start');
    await call('POST', '/session/ping');

    const [shapeId, polyline] = Object.entries(sc.expected.schedule.shapes)[0]!;
    const response = await call('GET', `/shapes/${encodeURIComponent(shapeId)}`);
    expect(response.status).toBe(200);
    expect((await response.json()) as ShapeResponse).toEqual({
      shapeId,
      encoding: 'polyline6',
      polyline,
    });
    expect((await call('GET', '/shapes/nope')).status).toBe(404);
    expect(downloads()).toHaveLength(1);

    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.on('exit', resolve));
    expect(output).not.toContain('SUPERSECRET123');
  }, 30_000);
});

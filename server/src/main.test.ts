import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DRAIN_DEADLINE_MS } from './shutdown.js';

// The real entry point, as built by `npm test` (`tsc -b` runs first).
const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const IDLE_MS = 1_000;
/** Generous slack for process start-up and a loaded machine. */
const SLACK_MS = 4_000;

let child: ChildProcess | undefined;
let socket: Socket | undefined;
afterEach(() => {
  socket?.destroy();
  child?.kill('SIGKILL');
  child = socket = undefined;
});

async function startServer(env: Record<string, string>) {
  const started = Date.now();
  const proc = spawn(process.execPath, [MAIN], {
    env: {
      PATH: process.env.PATH ?? '',
      SCHEDULE_URL: 'http://127.0.0.1:9/schedule.zip',
      VEHICLE_POSITIONS_URL: 'http://127.0.0.1:9/vp',
      WEB_DIST_DIR: '/nonexistent-web-dist',
      PORT: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  const exited = new Promise<{ code: number | null; at: number }>((resolve) =>
    proc.on('exit', (code) => resolve({ code, at: Date.now() - started })),
  );
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match?.[1]) resolve(Number(match[1]));
    });
    proc.on('exit', () => reject(new Error(`server exited early:\n${output}`)));
  });
  return { proc, port, exited, started };
}

/** A client that announces a 100-byte body and sends 1 byte: it would hold a request forever. */
async function slowBody(port: number): Promise<Socket> {
  const client = connect(port, '127.0.0.1');
  await new Promise((resolve) => client.once('connect', resolve));
  client.write(
    'POST /api/v1/session/ping HTTP/1.1\r\nHost: localhost\r\n' +
      'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{',
  );
  socket = client;
  return client;
}

describe('process lifecycle (built entry point)', () => {
  it('exits on idle within the drain deadline even while a slow client holds a request', async () => {
    const { port, exited } = await startServer({
      EXIT_ON_IDLE: 'true',
      IDLE_TIMEOUT_MS: String(IDLE_MS),
    });
    await slowBody(port);
    const { code, at } = await exited;
    expect(code).toBe(0);
    expect(at).toBeLessThan(IDLE_MS + DRAIN_DEADLINE_MS + SLACK_MS);
  }, 30_000);

  it('exits 0 on SIGTERM within the drain deadline even while a slow client holds a request', async () => {
    const { proc, port, exited } = await startServer({});
    await slowBody(port);
    const signalled = Date.now();
    proc.kill('SIGTERM');
    const { code } = await exited;
    expect(code).toBe(0);
    expect(Date.now() - signalled).toBeLessThan(DRAIN_DEADLINE_MS + SLACK_MS);
  }, 30_000);

  it('refuses to start on invalid configuration, naming the setting but not the value', async () => {
    const proc = spawn(process.execPath, [MAIN], {
      env: {
        PATH: process.env.PATH ?? '',
        SCHEDULE_URL: 'https://user:hunter2@feeds.example.test/s.zip',
        TRIP_UPDATES_URL: 'https://feeds.example.test/tu',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise((resolve) => proc.on('exit', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('SCHEDULE_URL');
    expect(stderr).not.toContain('hunter2');
  }, 30_000);
});

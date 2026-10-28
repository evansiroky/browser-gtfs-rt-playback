import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApp } from '../test-support/app.js';
import { logEntries } from '../test-support/logger.js';
import type { ApiRoutes } from './api.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const routes: ApiRoutes<undefined> = (api) => {
  api.get('/boom', async () => {
    throw new Error('boom');
  });
  api.get('/hang', () => new Promise(() => undefined));
};

async function setup(env: Record<string, string> = {}) {
  const built = await testApp(env, { routes: [routes] });
  app = built.app;
  const entries = () => logEntries(built.logs);
  const requestLines = () =>
    entries().filter((entry) =>
      /^(api (request|response)|session (ping|start) received)/.test(String(entry['msg'])),
    );
  return { ...built, entries, requestLines };
}

describe('API request logging', () => {
  it('logs a ping as it arrives, in the session, and when its response is sent', async () => {
    const { requestLines } = await setup();
    const res = await app!.inject({ method: 'POST', url: '/api/v1/session/ping' });
    expect(res.statusCode).toBe(200);
    const lines = requestLines();
    expect(lines.map((line) => line['msg'])).toEqual([
      'api request received',
      'session ping received',
      'api response sent',
    ]);
    expect(lines[0]).toMatchObject({ method: 'POST', path: '/api/v1/session/ping', level: 30 });
    expect(lines[1]).toMatchObject({ state: 'dormant', component: 'session' });
    expect(lines[2]).toMatchObject({
      method: 'POST',
      path: '/api/v1/session/ping',
      statusCode: 200,
      level: 30,
    });
    expect(typeof lines[2]!['durationMs']).toBe('number');
    expect(new Set([lines[0]!['reqId'], lines[2]!['reqId']]).size).toBe(1);
  });

  it('logs rejected requests too, without the query string', async () => {
    const { requestLines, logs } = await setup();
    await app!.inject({ method: 'GET', url: '/api/v1/nope?token=SECRETQUERY' });
    expect(requestLines().map((line) => [line['msg'], line['path'], line['statusCode']])).toEqual([
      ['api request received', '/api/v1/nope', undefined],
      ['api response sent', '/api/v1/nope', 404],
    ]);
    expect(logs.join('\n')).not.toContain('SECRETQUERY');
  });

  it('logs a rate-limited request and its 429', async () => {
    const { requestLines } = await setup({ RATE_LIMIT_PER_MIN: '1' });
    await app!.inject({ method: 'GET', url: '/api/v1/nope' });
    await app!.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(requestLines().map((line) => line['statusCode'])).toEqual([
      undefined,
      404,
      undefined,
      429,
    ]);
  });

  it('logs a failing response as a warning', async () => {
    const { requestLines } = await setup();
    await app!.inject({ method: 'GET', url: '/api/v1/boom' });
    expect(requestLines().at(-1)).toMatchObject({
      msg: 'api response sent',
      statusCode: 500,
      level: 40,
    });
  });

  it('does not log static files or the client address', async () => {
    const { requestLines, logs } = await setup();
    await app!.inject({ method: 'GET', url: '/', remoteAddress: '203.0.113.9' });
    await app!.inject({ method: 'GET', url: '/assets/app.js' });
    await app!.inject({ method: 'GET', url: '/apiary' });
    await app!.inject({
      method: 'POST',
      url: '/api/v1/session/ping',
      remoteAddress: '203.0.113.9',
    });
    expect(requestLines().map((line) => line['msg'])).toHaveLength(3);
    expect(logs.join('\n')).not.toContain('203.0.113.9');
  });

  it('logs a request the client abandons before the response', async () => {
    const { requestLines } = await setup();
    await app!.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app!.server.address() as AddressInfo;
    const req = httpRequest({ port, host: '127.0.0.1', path: '/api/v1/hang' });
    req.on('error', () => undefined);
    req.end();
    await vi.waitFor(() => expect(requestLines()).toHaveLength(1));
    req.destroy();
    await vi.waitFor(() =>
      expect(requestLines().map((line) => line['msg'])).toEqual([
        'api request received',
        'api request aborted',
      ]),
    );
    expect(requestLines()[1]).toMatchObject({ method: 'GET', path: '/api/v1/hang', level: 30 });
  });
});

import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { testApp } from '../test-support/app.js';

const WEB_BUILD = fileURLToPath(new URL('../test-support/web-build', import.meta.url));
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(webDistDir: string) {
  ({ app } = await testApp({ WEB_DIST_DIR: webDistDir, TILE_HOST: 'https://tiles.example.test' }));
  return app;
}

describe('static web app', () => {
  it('serves index.html at / and for client routes (SPA fallback)', async () => {
    await setup(WEB_BUILD);
    for (const url of ['/', '/trips/abc', '/trips/a%2Fb?x=1', '/trips/route.7.trip.v2']) {
      const res = await app!.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.body).toContain('fixture app');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['content-security-policy']).toContain(
        "connect-src 'self' https://tiles.example.test",
      );
    }
  });

  it('serves built assets as immutable files and index.html as no-cache', async () => {
    await setup(WEB_BUILD);
    const res = await app!.inject({ url: '/assets/app-1234.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/css/);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const index = await app!.inject({ url: '/index.html' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['cache-control']).toBe('no-cache');
  });

  it('answers a missing static file with a plain 404, never index.html', async () => {
    await setup(WEB_BUILD);
    for (const url of ['/assets/app-OLDHASH.js', '/assets/sub/x', '/favicon.ico', '/robots.txt']) {
      const res = await app!.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.body).not.toContain('fixture app');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    }
  });

  it('answers HEAD on client routes like GET, without a body', async () => {
    await setup(WEB_BUILD);
    const get = await app!.inject({ url: '/trips/abc' });
    const head = await app!.inject({ method: 'HEAD', url: '/trips/abc' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toBe(get.headers['content-type']);
    expect(head.headers['cache-control']).toBe('no-cache');
    expect(head.body).toBe('');
  });

  it('never falls through to the app for /api paths or non-GET requests', async () => {
    await setup(WEB_BUILD);
    for (const [method, url] of [
      ['GET', '/api'],
      ['GET', '/api/'],
      ['GET', '/api/v1'],
      ['GET', '/api/v1/trips/abc'],
      ['GET', '/api/v9/anything'],
      ['POST', '/trips/abc'],
    ] as const) {
      const res = await app!.inject({ method, url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.json()).toEqual({ error: { code: 'not_found', message: 'No such endpoint.' } });
    }
  });

  it('serves only the API when no build exists', async () => {
    await setup('/nonexistent-web-dist');
    const res = await app!.inject({ url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

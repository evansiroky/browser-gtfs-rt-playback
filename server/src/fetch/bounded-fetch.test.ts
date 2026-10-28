import { inspect } from 'node:util';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../clock.js';
import { SecretUrl } from '../secret-url.js';
import { serveBytes, startFeedHost, type FeedHost, type Handler } from '../test-support/feeds.js';
import { fetchAll, FetchError, type BoundedFetchOptions } from './bounded-fetch.js';
import { captureLogger, logEntries, silentLogger } from '../test-support/logger.js';

let host: FeedHost;
let clock: FakeClock;
let options: BoundedFetchOptions;

beforeEach(async () => {
  host = await startFeedHost();
  clock = new FakeClock();
  options = { clock, logger: silentLogger, feed: 'test', timeoutMs: 8_000, maxBytes: 1_000 };
});
afterEach(() => host.close());

async function failure(promise: Promise<unknown>): Promise<FetchError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the fetch to fail');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FetchError);
  const text = `${String(error)} ${inspect(error)} ${JSON.stringify(error)}`;
  expect(text).not.toContain(host.origin);
  expect(text).not.toContain('127.0.0.1');
  expect(text).not.toContain('api_key');
  return error as FetchError;
}

const redirect =
  (location: string): Handler =>
  (_req, res) => {
    res.writeHead(302, { location }).end();
  };

describe('fetchAll', () => {
  it('returns the body', async () => {
    host.route('/feed', serveBytes(new Uint8Array([1, 2, 3])));
    expect(await fetchAll(host.url('/feed?api_key=k'), options)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('decodes a gzip-encoded body', async () => {
    const body = new Uint8Array(500).fill(7);
    host.route('/feed', serveBytes(gzipSync(body), { 'content-encoding': 'gzip' }));
    expect(await fetchAll(host.url('/feed'), options)).toEqual(body);
  });

  it('reports a non-2xx status as http_status_<n>', async () => {
    const error = await failure(fetchAll(host.url('/missing?api_key=SECRET'), options));
    expect(error.code).toBe('http_status_404');
    expect(error.toStatusError()).toEqual({ code: 'http_status_404', message: error.message });
  });

  it('times out while waiting for headers', async () => {
    host.route('/slow', () => {});
    const arrived = host.nextRequest('/slow');
    const result = failure(fetchAll(host.url('/slow?api_key=SECRET'), options));
    await arrived;
    clock.advance(7_999);
    clock.advance(1);
    expect((await result).code).toBe('timeout');
  });

  it('times out while reading the body', async () => {
    host.route('/trickle', (_req, res) => {
      res.writeHead(200);
      res.write(new Uint8Array(10));
    });
    const arrived = host.nextRequest('/trickle');
    const result = failure(fetchAll(host.url('/trickle'), options));
    await arrived;
    await clock.advanceAsync(8_000);
    expect((await result).code).toBe('timeout');
  });

  it('aborts as soon as the body exceeds the size limit, without waiting for the end', async () => {
    // The response never ends: only a limit enforced while reading can finish this fetch.
    host.route('/endless', (_req, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write(new Uint8Array(300)), 1);
      res.on('close', () => clearInterval(timer));
    });
    expect((await failure(fetchAll(host.url('/endless'), options))).code).toBe('too_large');
  });

  it('applies the size limit to the decompressed body', async () => {
    const bomb = gzipSync(new Uint8Array(100_000));
    expect(bomb.byteLength).toBeLessThan(1_000);
    host.route('/bomb', serveBytes(bomb, { 'content-encoding': 'gzip' }));
    expect((await failure(fetchAll(host.url('/bomb'), options))).code).toBe('too_large');
    host.route('/exact', serveBytes(new Uint8Array(1_000)));
    expect((await fetchAll(host.url('/exact'), options)).byteLength).toBe(1_000);
  });

  it('applies the size limit to brotli and stacked gzip encodings too', async () => {
    host.route(
      '/br',
      serveBytes(brotliCompressSync(new Uint8Array(100_000)), { 'content-encoding': 'br' }),
    );
    expect((await failure(fetchAll(host.url('/br'), options))).code).toBe('too_large');
    const twice = gzipSync(gzipSync(new Uint8Array(100_000)));
    host.route('/twice', serveBytes(twice, { 'content-encoding': 'gzip, gzip' }));
    expect((await failure(fetchAll(host.url('/twice'), options))).code).toBe('too_large');
  });

  it('follows up to 3 redirects, including relative ones', async () => {
    host.route('/r1', redirect(`${host.origin}/r2`));
    host.route('/r2', redirect('/r3'));
    host.route('/r3', redirect('r4'));
    host.route('/r4', serveBytes(new Uint8Array([9])));
    expect(await fetchAll(host.url('/r1'), options)).toEqual(new Uint8Array([9]));
  });

  it('refuses a fourth redirect', async () => {
    for (const n of [1, 2, 3, 4]) host.route(`/r${n}`, redirect(`/r${n + 1}`));
    host.route('/r5', serveBytes(new Uint8Array([9])));
    expect((await failure(fetchAll(host.url('/r1?api_key=SECRET'), options))).code).toBe(
      'too_many_redirects',
    );
    expect(host.requests).not.toContain('/r5');
  });

  it('refuses redirects to schemes other than http and https', async () => {
    host.route('/r', redirect('file:///etc/passwd'));
    expect((await failure(fetchAll(host.url('/r'), options))).code).toBe('redirect_not_allowed');
    host.route('/r', redirect('ftp://127.0.0.1/feed'));
    expect((await failure(fetchAll(host.url('/r'), options))).code).toBe('redirect_not_allowed');
  });

  it('reports an unreachable host as network_error without naming it', async () => {
    const closed = await startFeedHost();
    const url = closed.url('/feed?api_key=SECRET');
    await closed.close();
    expect((await failure(fetchAll(url, options))).code).toBe('network_error');
    const dns = new SecretUrl(new URL('http://does-not-exist.invalid/feed?api_key=SECRET'));
    const error = await failure(fetchAll(dns, options));
    expect(error.code).toBe('network_error');
    expect(inspect(error)).not.toContain('does-not-exist');
  });

  it('stops when the caller aborts', async () => {
    host.route('/slow', () => {});
    const arrived = host.nextRequest('/slow');
    const controller = new AbortController();
    const result = failure(fetchAll(host.url('/slow'), { ...options, signal: controller.signal }));
    await arrived;
    controller.abort();
    expect((await result).code).toBe('aborted');
    expect(clock.pendingTimers()).toBe(0);
  });

  it('refuses redirects away from the configured origin to internal hosts', async () => {
    const port = new URL(host.origin).port;
    for (const location of [
      `http://localhost:${port}/feed`,
      `http://127.0.0.1:${Number(port) + 1}/feed`,
      'http://169.254.169.254/computeMetadata/v1/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://10.0.0.8/feed',
      'http://192.168.1.1/feed',
      'http://172.20.0.1/feed',
      `http://[::1]:${port}/feed`,
      'http://[fe80::1]/feed',
    ]) {
      host.route('/r', redirect(location));
      const error = await failure(fetchAll(host.url('/r?api_key=SECRET'), options));
      expect(error.code, location).toBe('redirect_not_allowed');
    }
    expect(host.requests.every((request) => request.startsWith('/r'))).toBe(true);
  });

  it('follows redirects to other public hosts', async () => {
    host.route('/r', redirect('http://feeds.example.invalid/feed'));
    // Resolving the made-up host fails, which proves the redirect was attempted.
    expect((await failure(fetchAll(host.url('/r'), options))).code).toBe('network_error');
  });
});

describe('logging', () => {
  it('logs the start and the completion of a fetch, without the URL', async () => {
    const logs: string[] = [];
    host.route('/feed', serveBytes(new Uint8Array([1, 2, 3])));
    await fetchAll(host.url('/feed?api_key=SECRET'), {
      ...options,
      logger: captureLogger(logs),
      feed: 'tripUpdates',
    });
    const entries = logEntries(logs);
    expect(entries.map((entry) => entry['msg'])).toEqual(['fetch started', 'fetch completed']);
    expect(entries[0]).toMatchObject({ feed: 'tripUpdates', level: 30 });
    expect(entries[1]).toMatchObject({
      feed: 'tripUpdates',
      status: 200,
      bytes: 3,
      redirects: 0,
      durationMs: 0,
    });
    expect(logs.join('\n')).not.toMatch(/api_key|SECRET|127\.0\.0\.1/);
  });

  it('counts redirects', async () => {
    const logs: string[] = [];
    host.route('/r1', redirect('/r2'));
    host.route('/r2', serveBytes(new Uint8Array([9])));
    await fetchAll(host.url('/r1'), { ...options, logger: captureLogger(logs) });
    expect(logEntries(logs).at(-1)).toMatchObject({ msg: 'fetch completed', redirects: 1 });
  });

  it('logs a failed fetch with its code as a warning', async () => {
    const logs: string[] = [];
    await failure(
      fetchAll(host.url('/missing?api_key=SECRET'), { ...options, logger: captureLogger(logs) }),
    );
    const entries = logEntries(logs);
    expect(entries.map((entry) => entry['msg'])).toEqual(['fetch started', 'fetch failed']);
    expect(entries[1]).toMatchObject({ feed: 'test', code: 'http_status_404', level: 40 });
    expect(logs.join('\n')).not.toMatch(/api_key|SECRET|127\.0\.0\.1/);
  });

  it('logs a fetch abandoned by its caller as information', async () => {
    const logs: string[] = [];
    host.route('/slow', () => {});
    const arrived = host.nextRequest('/slow');
    const controller = new AbortController();
    const result = failure(
      fetchAll(host.url('/slow'), {
        ...options,
        logger: captureLogger(logs),
        signal: controller.signal,
      }),
    );
    await arrived;
    controller.abort();
    await result;
    expect(logEntries(logs).at(-1)).toMatchObject({
      msg: 'fetch failed',
      code: 'aborted',
      level: 30,
    });
  });
});

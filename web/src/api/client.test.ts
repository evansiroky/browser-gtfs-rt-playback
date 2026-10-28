import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeStatus } from '@/test/fixtures';
import { ApiError, apiGet, pingSession, REQUEST_TIMEOUT_MS, startSession } from './client';

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('POSTs the session calls to /api/v1 without a body and parses the status', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(() => Promise.resolve(json(activeStatus())));

    await expect(startSession()).resolves.toEqual(activeStatus());
    await pingSession();

    const [startUrl, startInit] = fetchMock.mock.calls[0]!;
    expect(startUrl).toBe('/api/v1/session/start');
    expect(startInit).toMatchObject({ method: 'POST', cache: 'no-store' });
    expect(startInit?.body).toBeUndefined();
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/session/ping');
  });

  it('GETs data endpoints', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(json({ now: 1 }));
    await expect(apiGet('/dashboard')).resolves.toEqual({ now: 1 });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/dashboard');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
  });

  it('turns an error envelope into a typed ApiError', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(
      json({ error: { code: 'session_not_active', message: 'Server is dormant.' } }, 409),
    );
    const error = await failure(apiGet('/dashboard'));
    expect(error).toMatchObject({
      kind: 'http',
      status: 409,
      code: 'session_not_active',
      message: 'Server is dormant.',
    });
    expect(error.isUnreachable).toBe(false);
  });

  it('treats a 5xx without an envelope (a proxy page) as unreachable', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    const error = await failure(startSession());
    expect(error).toMatchObject({ kind: 'http', status: 502, code: null });
    expect(error.isUnreachable).toBe(true);
  });

  it('treats a network failure as unreachable', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await failure(pingSession());
    expect(error).toMatchObject({ kind: 'network', status: null });
    expect(error.isUnreachable).toBe(true);
  });

  it('reports a 2xx non-JSON body as a parse error', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response('nope', { status: 200 }));
    const error = await failure(pingSession());
    expect(error.kind).toBe('parse');
    expect(error.isUnreachable).toBe(true);
  });

  describe('session responses must have the expected shape', () => {
    const bodies: [string, () => Response][] = [
      ['null', () => json(null)],
      ['an empty object', () => json({})],
      ['an array', () => json([])],
      ['an HTML page with status 200', () => new Response('<html>Sign in</html>', { status: 200 })],
      ['only a state', () => json({ state: 'active' })],
      ['an unknown state', () => json({ ...activeStatus(), state: 'sleeping' })],
      ['no schedule', () => json({ state: 'active', realtime: {} })],
      ['no realtime', () => json({ state: 'active', schedule: { state: 'ready' } })],
    ];

    for (const [name, body] of bodies) {
      it(`rejects ${name} as an unreachable parse error, for start and ping`, async () => {
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockImplementation(() => Promise.resolve(body()));
        for (const call of [startSession, pingSession]) {
          const error = await failure(call());
          expect(error.kind).toBe('parse');
          expect(error.isUnreachable).toBe(true);
        }
      });
    }

    it('does not validate other endpoints (their screens own their shapes)', async () => {
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockImplementation(() => Promise.resolve(json({})));
      await expect(apiGet('/dashboard')).resolves.toEqual({});
    });
  });

  describe('timeout and abort signals (built without AbortSignal.any/timeout)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function hangUntilAborted() {
      fetchMock.mockImplementation((_url, init) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener('abort', () => reject(signal.reason));
        });
      });
    }

    it('works when the browser lacks AbortSignal.any and AbortSignal.timeout', async () => {
      vi.stubGlobal('fetch', fetchMock);
      vi.stubGlobal('AbortSignal', class extends EventTarget {});
      fetchMock.mockImplementation(() => Promise.resolve(json(activeStatus())));
      await expect(pingSession(new AbortController().signal)).resolves.toEqual(activeStatus());
    });

    it('times out a request that never answers as an unreachable network error', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', fetchMock);
      hangUntilAborted();
      const pending = failure(pingSession());
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      const error = await pending;
      expect(error).toMatchObject({ kind: 'network' });
      expect(error.isUnreachable).toBe(true);
    });

    it('clears the timeout and listener once the request is over', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockImplementation(() => Promise.resolve(json(activeStatus())));
      const controller = new AbortController();
      await pingSession(controller.signal);
      expect(vi.getTimerCount()).toBe(0);

      hangUntilAborted();
      const pending = pingSession(controller.signal).catch(() => null);
      controller.abort();
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    });

    it('an already-aborted caller signal aborts immediately without an ApiError', async () => {
      vi.stubGlobal('fetch', fetchMock);
      hangUntilAborted();
      const controller = new AbortController();
      controller.abort();
      const error = await pingSession(controller.signal).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).not.toBeInstanceOf(ApiError);
    });
  });

  it('lets a caller abort propagate as the original error, not an ApiError', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    fetchMock.mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    });
    const pending = pingSession(controller.signal);
    controller.abort();
    const error = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as DOMException).name).toBe('AbortError');
  });
});

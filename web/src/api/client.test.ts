import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, pingSession, startSession } from './client';

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
    fetchMock.mockImplementation(() => Promise.resolve(json({ state: 'active' })));

    await expect(startSession()).resolves.toEqual({ state: 'active' });
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
    expect(error.isUnreachable).toBe(false);
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

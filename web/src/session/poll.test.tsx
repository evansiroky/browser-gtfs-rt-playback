// @vitest-environment jsdom
import { notifyManager, QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { SessionStatus } from '@gtfs-rt-debugger/shared';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { activeStatus, dormantStatus } from '@/test/fixtures';
import { ActivityController, IDLE_TIMEOUT_MS } from './activity-controller';
import { DATA_POLL_INTERVAL_MS, isPollable, pollWhileEngaged, useEngagedQuery } from './poll';
import { SessionProvider } from './session-provider';

describe('pollWhileEngaged', () => {
  const engaged = { phase: 'engaged', resuming: false, status: activeStatus() } as const;

  it('polls every 10 s only when engaged, settled, and the server is active', () => {
    expect(pollWhileEngaged(engaged)).toMatchObject({
      enabled: true,
      refetchInterval: DATA_POLL_INTERVAL_MS,
    });
    for (const idle of [
      { ...engaged, phase: 'paused-idle' },
      { ...engaged, phase: 'paused-hidden' },
      { ...engaged, phase: 'ended' },
      { ...engaged, phase: 'starting' },
      { ...engaged, resuming: true },
      { ...engaged, status: null },
      { ...engaged, status: dormantStatus('idle') },
    ] as const) {
      expect(isPollable(idle)).toBe(false);
      expect(pollWhileEngaged(idle)).toMatchObject({ enabled: false, refetchInterval: false });
    }
  });

  it('never refetches on focus or reconnect and does not retry', () => {
    expect(pollWhileEngaged(engaged)).toMatchObject({
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    });
  });
});

describe('useEngagedQuery', () => {
  let sessionCalls: { kind: 'start' | 'ping'; resolve: (s: SessionStatus) => void }[];
  let controller: ActivityController;
  let queryClient: QueryClient;
  let queryFn: ReturnType<typeof vi.fn<() => Promise<string>>>;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <SessionProvider controller={controller}>{children}</SessionProvider>
    </QueryClientProvider>
  );

  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const answerSession = (status: SessionStatus = activeStatus()) =>
    act(async () => {
      sessionCalls[sessionCalls.length - 1]!.resolve(status);
      await vi.advanceTimersByTimeAsync(0);
    });
  const setVisible = (visible: boolean) => act(async () => controller.setVisible(visible));

  beforeEach(() => {
    vi.useFakeTimers();
    // React Query batches notifications with setTimeout(0); keep them off the faked timers.
    notifyManager.setScheduler(queueMicrotask);
    sessionCalls = [];
    queryClient = createQueryClient();
    const call = (kind: 'start' | 'ping') =>
      new Promise<SessionStatus>((resolve) => sessionCalls.push({ kind, resolve }));
    controller = new ActivityController({
      api: { start: () => call('start'), ping: () => call('ping') },
    });
    let n = 0;
    queryFn = vi.fn(() => Promise.resolve(`data ${++n}`));
  });

  afterEach(() => {
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    vi.useRealTimers();
  });

  function render() {
    return renderHook(() => useEngagedQuery({ queryKey: ['x'], queryFn }), { wrapper });
  }

  it('waits for the server to answer, fetches, then polls every 10 s', async () => {
    const { result } = render();
    await advance(0);
    expect(queryFn).not.toHaveBeenCalled();

    await answerSession();
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('data 1');

    await advance(DATA_POLL_INTERVAL_MS - 1);
    expect(queryFn).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(queryFn).toHaveBeenCalledTimes(2);
    await advance(DATA_POLL_INTERVAL_MS);
    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  it('holds polling back while its own condition is false, and starts once it holds', async () => {
    let enabled = false;
    const { rerender } = renderHook(() => useEngagedQuery({ queryKey: ['x'], queryFn, enabled }), {
      wrapper,
    });
    await answerSession();
    await advance(2 * DATA_POLL_INTERVAL_MS);
    expect(queryFn).not.toHaveBeenCalled();

    enabled = true;
    rerender();
    await advance(0);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('stops polling when the tab is hidden and keeps the last data', async () => {
    const { result } = render();
    await answerSession();
    await setVisible(false);
    await advance(10 * DATA_POLL_INTERVAL_MS);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('data 1');
  });

  it('stops polling after 60 s without interaction', async () => {
    render();
    await answerSession();
    await advance(IDLE_TIMEOUT_MS);
    const calls = queryFn.mock.calls.length;
    await advance(10 * DATA_POLL_INTERVAL_MS);
    expect(queryFn).toHaveBeenCalledTimes(calls);
    expect(calls).toBeGreaterThan(1);
  });

  it('on resume: pings first, refetches once that ping is answered, then resumes the cadence', async () => {
    render();
    await answerSession();
    await setVisible(false);
    await advance(5 * IDLE_TIMEOUT_MS);

    await setVisible(true);
    expect(sessionCalls.map((c) => c.kind)).toEqual(['start', 'ping']);
    expect(queryFn).toHaveBeenCalledTimes(1);

    await answerSession();
    expect(queryFn).toHaveBeenCalledTimes(2);
    await advance(DATA_POLL_INTERVAL_MS);
    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  it('keeps the last data and flags the error when a refresh fails', async () => {
    const { result } = render();
    await answerSession();
    queryFn.mockRejectedValueOnce(new Error('boom'));
    await advance(DATA_POLL_INTERVAL_MS);
    expect(result.current.isError).toBe(true);
    expect(result.current.data).toBe('data 1');
    const updatedAt = result.current.dataUpdatedAt;

    await advance(DATA_POLL_INTERVAL_MS);
    expect(result.current.data).toBe('data 2');
    expect(result.current.dataUpdatedAt).toBeGreaterThan(updatedAt);
  });

  it('does not poll a dormant server', async () => {
    render();
    await answerSession(dormantStatus('max-duration'));
    await advance(5 * DATA_POLL_INTERVAL_MS);
    expect(queryFn).not.toHaveBeenCalled();
  });
});

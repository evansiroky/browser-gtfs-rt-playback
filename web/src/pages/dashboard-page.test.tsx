// @vitest-environment jsdom
import type { DashboardResponse, SessionStatus, TripListResponse } from '@gtfs-rt-debugger/shared';
import { notifyManager, QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/app-shell';
import { createQueryClient } from '@/lib/query-client';
import { ActivityController, IDLE_TIMEOUT_MS } from '@/session/activity-controller';
import { SessionProvider } from '@/session/session-provider';
import { NOW, activeStatus, dashboard, tripItem } from '@/test/fixtures';
import { DashboardPage } from './dashboard-page';

type Reply = { status?: number; body: unknown };

describe('DashboardPage', () => {
  let session: SessionStatus;
  let dash: DashboardResponse;
  let lists: Record<string, TripListResponse['trips']>;
  let overrides: Map<string, Reply>;
  let requests: string[];
  let controller: ActivityController;
  let queryClient: QueryClient;

  const reply = (path: string): Reply => {
    const override = overrides.get(path);
    if (override) return override;
    if (path === '/api/v1/dashboard') return { body: dash };
    const list = new URL(path, 'http://x').searchParams.get('list');
    if (path.startsWith('/api/v1/trips?') && list && lists[list]) {
      return { body: { list, generatedAt: NOW, trips: lists[list] } };
    }
    return { status: 404, body: { error: { code: 'not_found', message: 'nope' } } };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    notifyManager.setScheduler(queueMicrotask);
    session = activeStatus();
    dash = dashboard();
    lists = {
      'active-with-realtime': [tripItem({ tripId: 'a1' }), tripItem({ tripId: 'a2' })],
      'active-without-realtime': [tripItem({ tripId: 'b1', realtime: null })],
      'unscheduled-with-realtime': [tripItem({ tripId: 'c1', reason: 'unknown_trip' })],
    };
    overrides = new Map();
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        const path = String(input);
        requests.push(`${init?.method ?? 'GET'} ${path}`);
        const { status = 200, body } = reply(path);
        return Promise.resolve(Response.json(body, { status }));
      }),
    );
    queryClient = createQueryClient();
    controller = new ActivityController({
      api: {
        start: () => Promise.resolve(session),
        ping: () => Promise.resolve(session),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    vi.useRealTimers();
  });

  const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  async function renderPage() {
    render(
      <QueryClientProvider client={queryClient}>
        <SessionProvider controller={controller}>
          <MemoryRouter>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>,
    );
    await settle();
  }
  const list = (name: string) => document.querySelector(`[data-list=${name}]`) as HTMLElement;

  it('fetches the dashboard and the three lists once the schedule is ready, then shows them', async () => {
    await renderPage();

    expect([...requests].sort()).toEqual(
      [
        'GET /api/v1/dashboard',
        'GET /api/v1/trips?list=active-with-realtime',
        'GET /api/v1/trips?list=active-without-realtime',
        'GET /api/v1/trips?list=unscheduled-with-realtime',
      ].sort(),
    );

    expect(screen.getByText('Bay Transit')).toBeInTheDocument();
    expect(list('active-with-realtime')).toHaveTextContent('Active trips with realtime data (2)');
    expect(list('active-without-realtime')).toHaveTextContent(
      'Active trips without realtime data (1)',
    );
    expect(list('unscheduled-with-realtime')).toHaveTextContent(
      'Trips not scheduled this minute, with realtime data (1)',
    );
    expect(
      within(list('unscheduled-with-realtime')).getByText('Trip ID not in schedule'),
    ).toBeInTheDocument();
  });

  it('while the schedule loads: shows the banner and placeholders, and does not ask for the lists', async () => {
    session = activeStatus({ schedule: { state: 'loading', loadedAt: null, error: null } });
    dash = dashboard({
      agency: null,
      schedule: null,
      lists: null,
      configurationErrors: null,
      realtime: {
        vehicles: 12,
        vehiclesWithTripId: 11,
        tripUpdates: 9,
        activeTripsWithRealtime: null,
      },
    });
    await renderPage();

    expect(screen.getByText('Downloading the schedule…')).toBeInTheDocument();
    expect(requests).toEqual(['GET /api/v1/dashboard']);
    // Realtime statistics already update.
    expect(document.querySelector('[data-stat=vehicles]')).toHaveTextContent('12');
    expect(
      within(document.querySelector('[data-stat=active-with-realtime]') as HTMLElement).getByRole(
        'status',
        { name: 'Loading' },
      ),
    ).toBeInTheDocument();
    expect(
      within(document.querySelector('[data-stat=trips-today]') as HTMLElement).getByRole('status', {
        name: 'Loading',
      }),
    ).toBeInTheDocument();
    expect(list('active-with-realtime').querySelector('[role=status]')).toBeInTheDocument();
    expect(list('active-with-realtime').querySelector('li')).toBeNull();

    // The next ping reports the schedule ready: the lists are fetched.
    session = activeStatus();
    await advance(10_000);
    expect(requests.filter((r) => r.includes('/trips?'))).toHaveLength(3);
  });

  it('shows the configuration-error notice from the dashboard, even next to a banner', async () => {
    session = activeStatus({ realtime: { vehiclePositions: null, tripUpdates: null } });
    dash = dashboard({
      configurationErrors: {
        total: 2,
        items: [
          { code: 'mixed_exact_times', tripId: 't', message: 'm1' },
          { code: 'unusable_stop_times', tripId: 't', message: 'm2' },
        ],
      },
    });
    await renderPage();
    expect(screen.getByText(/2 schedule configuration errors/)).toBeInTheDocument();
  });

  it('keeps the last data when a refresh fails', async () => {
    await renderPage();
    overrides.set('/api/v1/dashboard', { status: 500, body: {} });
    await advance(10_000);
    expect(document.querySelector('[data-stat=vehicles]')).toHaveTextContent('12');
    expect(list('active-with-realtime')).toHaveTextContent('(2)');
  });

  it('polls every 10 s, and stops polling once the page is idle', async () => {
    await renderPage();
    const initial = requests.length;
    await advance(10_000);
    expect(requests.length).toBe(initial * 2);

    await advance(IDLE_TIMEOUT_MS);
    const settled = requests.length;
    await advance(60_000);
    expect(requests.length).toBe(settled);
    expect(screen.getByText('Paused — no activity for a minute')).toBeInTheDocument();
    // The last data stays on screen.
    expect(list('active-with-realtime')).toHaveTextContent('(2)');
  });

  it('makes no requests while the tab is hidden', async () => {
    await renderPage();
    await act(async () => controller.setVisible(false));
    const before = requests.length;
    await advance(60_000);
    expect(requests.length).toBe(before);
    expect(screen.getByText('Paused — tab hidden')).toBeInTheDocument();
  });

  it('offers Restart when the session ended, with the last data still visible', async () => {
    await renderPage();
    session = {
      ...activeStatus(),
      state: 'dormant',
      endedReason: 'max-duration',
      activatedAt: null,
      expiresAt: null,
      historyStartsAt: null,
      schedule: { state: 'idle', loadedAt: null, error: null },
      realtime: { vehiclePositions: null, tripUpdates: null },
    };
    await advance(10_000);
    expect(screen.getByText('Session ended after the maximum running time.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
    expect(list('active-with-realtime')).toHaveTextContent('(2)');
    // A feed the server stopped reporting is not "Not configured".
    expect(document.querySelector('[data-stat=vehicles]')).toHaveTextContent('12');
    expect(screen.getByText(/Vehicle positions: updated/)).toBeInTheDocument();
  });

  it('shows "Not configured" for a statistic whose feed is not configured', async () => {
    session = activeStatus({
      realtime: { vehiclePositions: null, tripUpdates: activeStatus().realtime.tripUpdates },
    });
    dash = dashboard({
      realtime: {
        vehicles: null,
        vehiclesWithTripId: null,
        tripUpdates: 9,
        activeTripsWithRealtime: 8,
      },
    });
    await renderPage();
    expect(document.querySelector('[data-stat=vehicles]')).toHaveTextContent('Not configured');
    expect(document.querySelector('[data-stat=trip-updates]')).toHaveTextContent('9');
  });
});

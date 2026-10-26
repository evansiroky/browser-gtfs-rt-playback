// @vitest-environment jsdom
import {
  encodePolyline6,
  type DashboardResponse,
  type SessionStatus,
  type TripDetailResponse,
} from '@gtfs-rt-debugger/shared';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/app-shell';
import type { TripMapProps } from '@/components/trip/trip-map';
import { createQueryClient } from '@/lib/query-client';
import { ActivityController, IDLE_TIMEOUT_MS } from '@/session/activity-controller';
import { SessionProvider } from '@/session/session-provider';
import {
  NOW,
  activeStatus,
  dashboard,
  frequency,
  ping,
  scheduled,
  tripDetail,
} from '@/test/fixtures';
import { TripDetailPage } from './trip-detail-page';

// jsdom has no WebGL: the map stands in as buttons that report what it was given.
vi.mock('@/components/trip/trip-map', () => ({
  default: (props: TripMapProps) => (
    <div
      data-testid="map"
      data-shape-points={props.shape?.length ?? 0}
      data-selected={props.selection?.sequence ?? ''}
      data-pan={String(props.selection?.pan ?? '')}
    >
      {props.pings
        .filter((p) => p.latitude !== null)
        .map((p) => (
          <button key={p.sequence} onClick={() => props.onSelect(p.sequence)}>
            marker {p.sequence}
          </button>
        ))}
    </div>
  ),
}));

type Reply = { status?: number; body: unknown };

const SHAPE = encodePolyline6([
  [37.78, -122.41],
  [37.79, -122.4],
  [37.8, -122.39],
]);

const error = (code: string, status: number): Reply => ({
  status,
  body: { error: { code, message: code } },
});

describe('TripDetailPage', () => {
  let session: SessionStatus;
  let dash: DashboardResponse;
  let detail: TripDetailResponse;
  let overrides: Map<string, Reply>;
  let requests: string[];
  let controller: ActivityController;

  const reply = (path: string): Reply => {
    const override = overrides.get(path);
    if (override) return override;
    if (path === '/api/v1/dashboard') return { body: dash };
    if (path === '/api/v1/trips/trip-1') return { body: detail };
    if (path === '/api/v1/shapes/shape-1') {
      return { body: { shapeId: 'shape-1', encoding: 'polyline6', polyline: SHAPE } };
    }
    return error('not_found', 404);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    notifyManager.setScheduler(queueMicrotask);
    session = activeStatus();
    dash = dashboard();
    detail = tripDetail();
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
    controller = new ActivityController({
      api: { start: () => Promise.resolve(session), ping: () => Promise.resolve(session) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    vi.useRealTimers();
  });

  const settle = async () => {
    // The map is a lazy chunk: let its import and the fetches resolve.
    for (let i = 0; i < 3; i++) await act(() => vi.advanceTimersByTimeAsync(0));
  };
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  async function renderPage(path = '/trips/trip-1') {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <SessionProvider controller={controller}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="trips/:tripId" element={<TripDetailPage />} />
                <Route index element={<p>dashboard</p>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>,
    );
    await settle();
  }
  const card = (name: string) => document.querySelector(`[data-card=${name}]`) as HTMLElement;
  const rows = (table: HTMLElement) =>
    Object.fromEntries(
      [...table.querySelectorAll('tr[data-key]')].map((row) => [
        (row as HTMLElement).dataset.key,
        row.querySelector('[data-slot=value]')!.textContent!.replace('(empty)', ''),
      ]),
    );

  describe('data requests', () => {
    it('fetches the dashboard, the trip and its shape, with the trip ID percent-encoded', async () => {
      detail = tripDetail({ tripId: 'a/b c' });
      overrides.set('/api/v1/trips/a%2Fb%20c', { body: detail });
      await renderPage('/trips/a%2Fb%20c');
      expect(requests).toContain('GET /api/v1/dashboard');
      expect(requests).toContain('GET /api/v1/trips/a%2Fb%20c');
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Trip a/b c');
    });

    it('refreshes the trip every 10 s but fetches the shape once', async () => {
      await renderPage();
      await advance(10_000);
      await advance(10_000);
      await advance(10_000);
      expect(requests.filter((r) => r === 'GET /api/v1/trips/trip-1')).toHaveLength(4);
      expect(requests.filter((r) => r === 'GET /api/v1/shapes/shape-1')).toHaveLength(1);
    });

    it('fetches the shape again when the activation changes', async () => {
      await renderPage();
      session = activeStatus({ activatedAt: NOW + 5 });
      await advance(10_000);
      await advance(10_000);
      expect(requests.filter((r) => r === 'GET /api/v1/shapes/shape-1')).toHaveLength(2);
    });

    it('does not ask for the trip before the schedule is ready', async () => {
      session = activeStatus({ schedule: { state: 'loading', loadedAt: null, error: null } });
      await renderPage();
      expect(requests.filter((r) => r.includes('/trips/'))).toEqual([]);
      expect(screen.getByText('Downloading the schedule…')).toBeInTheDocument();
      expect(card('loading')).toHaveTextContent('once the schedule has loaded');

      session = activeStatus();
      await advance(10_000);
      expect(requests).toContain('GET /api/v1/trips/trip-1');
      expect(card('header')).toBeInTheDocument();
    });

    it('polls only while engaged, keeping the last data on screen when paused', async () => {
      await renderPage();
      await advance(IDLE_TIMEOUT_MS);
      const settled = requests.length;
      await advance(60_000);
      expect(requests.length).toBe(settled);
      expect(screen.getByText('Paused — no activity for a minute')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Trip trip-1');
      expect(card('pings')).toBeInTheDocument();
    });
  });

  describe('header', () => {
    it('shows the trip ID, the service date, a link back, and a label per classification entry', async () => {
      detail = tripDetail({
        classification: [
          { list: 'active-with-realtime', reason: null, start: NOW, end: NOW + 1800 },
          { list: 'active-with-realtime', reason: null, start: NOW + 3600, end: NOW + 5400 },
          {
            list: 'unscheduled-with-realtime',
            reason: 'missing_start_time',
            start: null,
            end: null,
          },
        ],
      });
      await renderPage();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Trip trip-1');
      expect(card('header')).toHaveTextContent('Service date 2027-01-15');
      expect(screen.getByRole('link', { name: /Dashboard/ })).toHaveAttribute('href', '/');
      const labels = [...card('header').querySelectorAll('[data-list]')].map(
        (label) => label.textContent,
      );
      expect(labels).toEqual([
        'Active now, with realtime data00:00–00:30',
        'Active now, with realtime data01:00–01:30',
        'Not scheduled this minute, with realtime dataFrequency trip, but the feed sent no start time',
      ]);
    });

    it('shows no label for a trip that is in no list', async () => {
      detail = tripDetail({ classification: [] });
      await renderPage();
      expect(card('header').querySelector('[data-list]')).toBeNull();
    });

    it('shows how old the data is, and says so when a refresh fails while keeping the data', async () => {
      await renderPage();
      expect(card('header')).toHaveTextContent('Updated 0 s ago');
      overrides.set('/api/v1/trips/trip-1', error('internal', 500));
      await advance(10_000);
      expect(card('header')).toHaveTextContent('Couldn’t refresh; showing data from 10 s ago.');
      expect(card('pings')).toBeInTheDocument();
    });
  });

  describe('scheduled trip', () => {
    it('shows every column of the trips.txt and routes.txt rows, and the computed values', async () => {
      await renderPage();
      const trip = rows(card('scheduled'));
      expect(trip).toMatchObject({
        route_id: 'r1',
        service_id: 'DAILY',
        trip_id: 'trip-1',
        trip_headsign: 'Downtown',
        block_id: '',
        shape_id: 'shape-1',
        'Scheduled start': '2027-01-14 23:50:00',
        'Scheduled end': '2027-01-15 00:30:00',
        'Operates on the service date': 'yes',
        'Active now': 'yes',
      });
      // A column present but empty says so rather than showing a blank cell.
      expect(card('scheduled').querySelector('[data-key=block_id]')).toHaveTextContent('(empty)');
      expect(card('route').querySelector('[data-slot=route-heading]')).toHaveTextContent(
        'Route 38 — Geary',
      );
      expect(rows(card('route'))).toEqual({
        route_id: 'r1',
        route_short_name: '38',
        route_long_name: 'Geary',
        route_type: '3',
      });
    });

    it('says when the route ID is not in routes.txt', async () => {
      detail = tripDetail({ scheduled: scheduled({ route: null }) });
      await renderPage();
      expect(card('route')).toHaveTextContent('Route ID “r1” is not in routes.txt.');
      expect(card('route').querySelector('table')).toBeNull();
    });

    it('says when the trip ID is not in the schedule, with no tables', async () => {
      detail = tripDetail({ scheduled: null, classification: [] });
      await renderPage();
      expect(card('scheduled')).toHaveTextContent('The trip ID trip-1 is not in the schedule');
      expect(card('route')).toBeNull();
      expect(card('frequencies')).toBeNull();
    });

    it('shows a trip that does not operate, with no start or end', async () => {
      detail = tripDetail({
        scheduled: scheduled({
          operatesOnServiceDate: false,
          activeNow: false,
          start: null,
          end: null,
        }),
      });
      await renderPage();
      expect(rows(card('scheduled'))).toMatchObject({
        'Scheduled start': 'none',
        'Scheduled end': 'none',
        'Operates on the service date': 'no',
        'Active now': 'no',
      });
    });

    it('shows no clock time until the agency timezone is known', async () => {
      overrides.set('/api/v1/dashboard', error('internal', 500));
      await renderPage();
      expect(rows(card('scheduled'))['Scheduled start']).toBe('—');
    });
  });

  describe('frequencies', () => {
    const exact = frequency();
    const nominalAbsent = frequency({
      row: { trip_id: 'trip-1', start_time: '10:00:00', end_time: '11:00:00', headway_secs: '900' },
      exactTimes: false,
      headwaySecs: 900,
      activeNow: false,
      activeInstanceStarts: [],
    });
    const nominalZero = frequency({
      row: { ...exact.row, exact_times: '0', start_time: '11:00:00', end_time: '12:00:00' },
      exactTimes: false,
      activeInstanceStarts: [NOW - 300, NOW + 300],
    });
    const unreadable = frequency({
      row: { trip_id: 'trip-1', start_time: 'soon', end_time: '12:00:00', headway_secs: 'x' },
      exactTimes: false,
      headwaySecs: null,
      windowStart: null,
      windowEnd: null,
      templateDurationSecs: null,
      activeNow: false,
      activeInstanceStarts: [],
    });
    const tableRows = () =>
      [...card('frequencies').querySelectorAll('tbody tr')].map((row) => ({
        text: row.textContent,
        field: (name: string) => row.querySelector(`[data-field=${name}]`)?.textContent,
      }));

    it('shows every column of every row, windows, templates, active instances and notes', async () => {
      detail = tripDetail({
        scheduled: scheduled({ frequencies: [exact, nominalAbsent, nominalZero] }),
      });
      await renderPage();
      const headers = [...card('frequencies').querySelectorAll('thead th')].map(
        (th) => th.textContent,
      );
      expect(headers).toEqual([
        'trip_id',
        'start_time',
        'end_time',
        'headway_secs',
        'exact_times',
        'Window',
        'Template duration',
        'Active now',
        'Active instance starts',
        'Note',
      ]);
      const [a, b, c] = tableRows();
      expect(a!.field('window')).toBe('23:00:00–01:00:00');
      expect(a!.field('template')).toBe('20 min');
      expect(a!.field('active')).toBe('yes');
      expect(a!.field('starts')).toBe('23:55:00');
      // exact_times 1: no note.
      expect(a!.field('note')).toBe('');
      // exact_times absent: its cell is not in the row at all, and the note applies.
      expect(b!.field('active')).toBe('no');
      expect(b!.field('starts')).toBe('none');
      expect(b!.field('note')).toBe('Departures are assumed to be exactly on the headway.');
      expect(card('frequencies').querySelectorAll('tbody tr')[1]!.textContent).toContain('—');
      // exact_times 0: the same note, two instances.
      expect(c!.field('starts')).toBe('23:55:00, 00:05:00');
      expect(c!.field('note')).toBe('Departures are assumed to be exactly on the headway.');
    });

    it('shows a template duration that cannot be computed', async () => {
      detail = tripDetail({
        scheduled: scheduled({
          frequencies: [frequency({ templateDurationSecs: null })],
          configurationErrors: [{ code: 'unusable_stop_times', message: 'no stop times' }],
        }),
      });
      await renderPage();
      expect(tableRows()[0]!.field('template')).toBe('cannot be computed');
    });

    it('shows a row whose times or headway cannot be read with its columns and a note only', async () => {
      detail = tripDetail({ scheduled: scheduled({ frequencies: [unreadable] }) });
      await renderPage();
      const row = card('frequencies').querySelector('tbody tr') as HTMLElement;
      expect(row.dataset.readable).toBe('false');
      expect(within(row).getByText('soon')).toBeInTheDocument();
      expect(within(row).getByText('x')).toBeInTheDocument();
      expect(row.querySelector('[data-field=note]')).toHaveTextContent(
        'Unreadable Its times or headway cannot be read, so it has no instances.',
      );
      expect(row.querySelector('[data-field=window]')).toBeNull();
      expect(row.textContent).not.toContain('Departures are assumed');
    });

    it('is absent for a plain trip', async () => {
      await renderPage();
      expect(card('frequencies')).toBeNull();
    });
  });

  describe('configuration errors', () => {
    const cases = [
      ['mixed_exact_times', 'disagree on exact_times'],
      ['unusable_stop_times', 'start and end cannot be computed'],
      ['frequency_too_dense', 'more than 2,000 instances'],
    ] as const;

    it.each(cases)(
      'shows %s prominently, naming the cause and the consequence',
      async (code, cause) => {
        detail = tripDetail({
          scheduled: scheduled({
            frequencies: [frequency()],
            configurationErrors: [{ code, message: 'the server says' }],
          }),
        });
        await renderPage();
        const alert = document.querySelector(`[data-error-code=${code}]`) as HTMLElement;
        expect(alert).toHaveAttribute('role', 'alert');
        expect(alert).toHaveTextContent(cause);
        expect(alert).toHaveTextContent('activity cannot be determined');
        expect(alert).toHaveTextContent('excluded from the schedule counts');
        expect(alert).toHaveTextContent('the server says');
        // Above the tables, which still show the rows.
        expect(
          alert.compareDocumentPosition(card('scheduled')) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(card('frequencies')).toBeInTheDocument();
      },
    );

    it('shows every error of a trip', async () => {
      detail = tripDetail({
        scheduled: scheduled({
          configurationErrors: [
            { code: 'mixed_exact_times', message: 'a' },
            { code: 'unusable_stop_times', message: 'b' },
          ],
        }),
      });
      await renderPage();
      expect(document.querySelectorAll('[data-error-code]')).toHaveLength(2);
    });
  });

  describe('trip update', () => {
    it('says when there is none', async () => {
      await renderPage();
      expect(card('trip-update')).toHaveTextContent(
        'No trip update is currently present for this trip.',
      );
    });

    it('shows its timestamp, delay, vehicle, schedule relationship and stop time update count', async () => {
      detail = tripDetail({
        realtime: {
          pings: [],
          tripUpdate: {
            feedTimestamp: NOW,
            timestamp: NOW - 20,
            delay: -30,
            vehicleId: 'tu-unit-1',
            startTime: null,
            scheduleRelationship: 'SCHEDULED',
            stopTimeUpdateCount: 3,
          },
        },
      });
      await renderPage();
      expect(rows(card('trip-update'))).toEqual({
        Timestamp: '2027-01-14 23:59:40',
        Delay: '-30 s',
        'Vehicle ID': 'tu-unit-1',
        'Schedule relationship': 'SCHEDULED',
        'Stop time updates': '3',
      });
    });
  });

  describe('map', () => {
    it('is shown with the decoded shape and the pings', async () => {
      await renderPage();
      const map = screen.getByTestId('map');
      expect(map).toHaveAttribute('data-shape-points', '3');
      expect(within(map).getAllByRole('button')).toHaveLength(2);
      expect(card('map').querySelector('[data-slot=shape-note]')).toBeNull();
    });

    it('is shown for the shape alone, saying there are no pings and when history begins', async () => {
      detail = tripDetail({ realtime: { pings: [], tripUpdate: null } });
      session = activeStatus({ historyStartsAt: NOW - 600 });
      await renderPage();
      expect(screen.getByTestId('map')).toHaveAttribute('data-shape-points', '3');
      expect(card('map').querySelector('[data-slot=no-pings]')).toHaveTextContent(
        'No vehicle positions have been received for this trip in the retained history, which begins at 23:50:00.',
      );
    });

    it('leaves out the history start when history is a full hour', async () => {
      detail = tripDetail({ realtime: { pings: [], tripUpdate: null } });
      session = activeStatus({ historyStartsAt: NOW - 3600 });
      await renderPage();
      expect(card('map').querySelector('[data-slot=no-pings]')).toHaveTextContent(
        /^No vehicle positions have been received for this trip in the retained history\.$/,
      );
    });

    it('is shown for markers alone when the trip is unknown, with no shape message', async () => {
      detail = tripDetail({ scheduled: null });
      await renderPage();
      expect(screen.getByTestId('map')).toHaveAttribute('data-shape-points', '0');
      expect(card('map').querySelector('[data-slot=shape-note]')).toBeNull();
      expect(requests.some((r) => r.includes('/shapes/'))).toBe(false);
    });

    it('is not shown with neither a shape nor a ping with coordinates', async () => {
      detail = tripDetail({
        scheduled: scheduled({ shapeId: null }),
        realtime: { pings: [ping(1, { latitude: null, longitude: null })], tripUpdate: null },
      });
      await renderPage();
      expect(screen.queryByTestId('map')).toBeNull();
      expect(card('map')).toHaveTextContent('has no shape_id');
      expect(card('map')).toHaveTextContent('nothing to draw');
      expect(card('map').querySelector('[data-slot=no-pings]')).toBeNull();
    });

    it('says a trip with no shape_id has no line, and requests no shape', async () => {
      detail = tripDetail({ scheduled: scheduled({ shapeId: null }) });
      await renderPage();
      expect(card('map').querySelector('[data-slot=shape-note]')).toHaveTextContent(
        'This trip has no shape_id, so no route line is drawn.',
      );
      expect(screen.getByTestId('map')).toHaveAttribute('data-shape-points', '0');
      expect(requests.some((r) => r.includes('/shapes/'))).toBe(false);
    });

    it('says a shape that is not in shapes.txt has no line, and shows no map without pings', async () => {
      overrides.set('/api/v1/shapes/shape-1', error('shape_not_found', 404));
      detail = tripDetail({ realtime: { pings: [], tripUpdate: null } });
      await renderPage();
      expect(card('map').querySelector('[data-slot=shape-note]')).toHaveTextContent(
        'Shape “shape-1” is not in shapes.txt, so no route line is drawn.',
      );
      expect(screen.queryByTestId('map')).toBeNull();
    });

    it('keeps the markers when the shape is missing', async () => {
      overrides.set('/api/v1/shapes/shape-1', error('shape_not_found', 404));
      await renderPage();
      expect(screen.getByTestId('map')).toHaveAttribute('data-shape-points', '0');
      expect(within(screen.getByTestId('map')).getAllByRole('button')).toHaveLength(2);
    });
  });

  describe('pings list', () => {
    const rich = ping(5, {
      vehicleId: 'bus-9',
      vehicleLabel: 'Bus Nine',
      timestamp: NOW - 59,
      latitude: 37.785,
      bearing: 90,
      speed: 7.5,
      currentStatus: 'IN_TRANSIT_TO',
      currentStopSequence: 4,
      stopId: 'S4',
      occupancyStatus: 'FEW_SEATS_AVAILABLE',
      occupancyPercentage: 30,
      congestionLevel: 'RUNNING_SMOOTHLY',
      licensePlate: 'FX-1',
      startDate: '20270115',
      startTime: '08:00:00',
      scheduleRelationship: 'SCHEDULED',
      multiCarriageDetails: [{ id: 'c1' }],
    } as Parameters<typeof ping>[1]);
    const bare = ping(6, { latitude: null, longitude: null, vehicleId: 'bus-2' });

    const open = () => fireEvent.click(screen.getByRole('button', { name: /Vehicle positions/ }));
    const row = (sequence: number) =>
      document.querySelector(`li[data-sequence="${sequence}"]`) as HTMLElement;

    beforeEach(() => {
      detail = tripDetail({ realtime: { pings: [ping(1), rich, bare], tripUpdate: null } });
    });

    it('is collapsed by default, headed with the count, and expands and collapses', async () => {
      await renderPage();
      const trigger = screen.getByRole('button', { name: 'Vehicle positions (3)' });
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(card('pings').querySelector('li')).toBeNull();
      open();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(card('pings').querySelectorAll('li')).toHaveLength(3);
      open();
      expect(card('pings').querySelector('li')).toBeNull();
    });

    it('lists every ping in sequence order with local time in seconds and the vehicle', async () => {
      await renderPage();
      open();
      expect([...card('pings').querySelectorAll('li')].map((li) => li.dataset.sequence)).toEqual([
        '1',
        '5',
        '6',
      ]);
      expect(row(5).querySelector('[data-slot=time]')).toHaveTextContent('23:59:01');
      expect(row(5).querySelector('[data-slot=vehicle]')).toHaveTextContent('bus-9 (Bus Nine)');
      expect(row(1).querySelector('[data-slot=vehicle]')).toHaveTextContent(/^bus-7$/);
    });

    it('shows every available field, including other passed-through ones, and omits absent ones', async () => {
      await renderPage();
      open();
      const fields = Object.fromEntries(
        [...row(5).querySelectorAll('[data-field]')].map((f) => [
          (f as HTMLElement).dataset.field,
          f.querySelector('dd')!.textContent,
        ]),
      );
      expect(fields).toMatchObject({
        latitude: '37.785',
        longitude: '-122.41',
        bearing: '90°',
        speed: '7.5 m/s',
        currentStatus: 'IN_TRANSIT_TO',
        currentStopSequence: '4',
        stopId: 'S4',
        occupancyStatus: 'FEW_SEATS_AVAILABLE',
        occupancyPercentage: '30%',
        congestionLevel: 'RUNNING_SMOOTHLY',
        licensePlate: 'FX-1',
        startDate: '20270115',
        startTime: '08:00:00',
        scheduleRelationship: 'SCHEDULED',
        multiCarriageDetails: '[{"id":"c1"}]',
      });
      const plain = [...row(1).querySelectorAll('[data-field]')].map(
        (f) => (f as HTMLElement).dataset.field,
      );
      expect(plain).toEqual(['latitude', 'longitude']);
      // Header values are not repeated as fields, and absent ones leave nothing empty behind.
      expect(row(5).querySelector('[data-field=vehicleId]')).toBeNull();
      expect(row(5).querySelector('[data-field=sequence]')).toBeNull();
      expect(row(5).querySelector('[data-field=odometer]')).toBeNull();
    });

    it('lists a ping without coordinates, which has no marker', async () => {
      await renderPage();
      open();
      expect(row(6)).toHaveTextContent('no position, so no marker');
      expect(row(6).querySelector('[data-field=latitude]')).toBeNull();
      expect(screen.queryByRole('button', { name: 'marker 6' })).toBeNull();
      expect(screen.getByRole('button', { name: 'marker 5' })).toBeInTheDocument();
    });

    it('a marker click expands the list and highlights the row, without panning', async () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      await renderPage();
      expect(card('pings').querySelector('li')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'marker 5' }));
      expect(card('pings').querySelectorAll('li')).toHaveLength(3);
      expect(row(5)).toHaveAttribute('data-selected', 'true');
      expect(row(1)).toHaveAttribute('data-selected', 'false');
      expect(scrollIntoView).toHaveBeenCalled();
      expect(screen.getByTestId('map')).toHaveAttribute('data-selected', '5');
      expect(screen.getByTestId('map')).toHaveAttribute('data-pan', 'false');
    });

    it('a row click highlights the row and its marker and asks the map to pan', async () => {
      await renderPage();
      open();
      fireEvent.click(row(1));
      expect(row(1)).toHaveAttribute('data-selected', 'true');
      expect(screen.getByTestId('map')).toHaveAttribute('data-selected', '1');
      expect(screen.getByTestId('map')).toHaveAttribute('data-pan', 'true');
      fireEvent.click(within(row(5)).getByRole('button', { pressed: false }));
      expect(row(5)).toHaveAttribute('data-selected', 'true');
      expect(row(1)).toHaveAttribute('data-selected', 'false');
    });

    it('drops the selection when the ping expires from the window', async () => {
      await renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'marker 5' }));
      detail = tripDetail({ realtime: { pings: [bare], tripUpdate: null } });
      await advance(10_000);
      expect(screen.getByTestId('map')).toHaveAttribute('data-selected', '');
      expect(card('pings').querySelectorAll('[data-selected=true]')).toHaveLength(0);
    });

    it('says when there are none', async () => {
      detail = tripDetail({ realtime: { pings: [], tripUpdate: null } });
      await renderPage();
      expect(screen.getByRole('button', { name: 'Vehicle positions (0)' })).toBeInTheDocument();
      open();
      expect(card('pings')).toHaveTextContent('No vehicle positions in the retained history.');
    });
  });

  describe('not found and failures', () => {
    it('shows a not-found message with a link to the dashboard on 404 trip_not_found', async () => {
      overrides.set('/api/v1/trips/trip-1', error('trip_not_found', 404));
      await renderPage();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Trip not found');
      expect(card('not-found')).toHaveTextContent('trip-1');
      expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute(
        'href',
        '/',
      );
      expect(card('map')).toBeNull();
    });

    it('shows the session banner, not a trip, when the session ended', async () => {
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
      await renderPage();
      expect(screen.getByText('Session ended after the maximum running time.')).toBeInTheDocument();
      expect(card('header')).toBeNull();
    });

    it('says it could not load the trip when the first request fails', async () => {
      overrides.set('/api/v1/trips/trip-1', error('internal', 500));
      await renderPage();
      expect(card('loading')).toHaveTextContent('Couldn’t load this trip.');
    });
  });
});

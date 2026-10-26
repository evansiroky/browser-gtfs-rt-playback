// @vitest-environment jsdom
import { TRIP_REASONS, type TripListItem } from '@gtfs-rt-debugger/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REASON_TEXT } from '@/lib/trip-format';
import { NOW, tripItem } from '@/test/fixtures';
import { TripTable, type TripTableProps } from './trip-table';

function renderTable(props: Partial<TripTableProps> = {}) {
  return render(
    <MemoryRouter>
      <TripTable
        list="active-with-realtime"
        title="Active trips with realtime data"
        description="d"
        emptyText="Nothing here."
        trips={[tripItem()]}
        count={1}
        timezone="America/Los_Angeles"
        nowSeconds={NOW}
        {...props}
      />
    </MemoryRouter>,
  );
}

const rows = () => screen.queryAllByRole('listitem');
const search = (title = 'Active trips with realtime data') =>
  screen.getByRole('searchbox', { name: `Search ${title}` });

afterEach(() => vi.restoreAllMocks());

describe('TripTable columns', () => {
  it('list 1: trip ID, route, headsign, scheduled start–end, vehicle IDs and the age of the sighting', () => {
    renderTable({
      trips: [
        tripItem({
          realtime: {
            ...tripItem().realtime!,
            vehicleIds: ['bus-7', 'bus-8'],
            lastSeenAt: NOW - 125,
          },
        }),
      ],
    });
    const row = within(rows()[0]!);
    expect(row.getByRole('link')).toHaveTextContent('trip-1');
    for (const text of ['trip-1', '38', 'Downtown', '00:00–00:40', 'bus-7, bus-8', '2 min ago']) {
      expect(row.getByText(text), text).toBeInTheDocument();
    }
  });

  it('list 2: no vehicle or sighting columns', () => {
    renderTable({
      list: 'active-without-realtime',
      trips: [tripItem({ realtime: null })],
    });
    const row = rows()[0]!;
    expect(row).toHaveTextContent('Downtown');
    expect(row).toHaveTextContent('00:00–00:40');
    expect(row.querySelector('[data-column=vehicles]')).toBeNull();
    expect(row.querySelector('[data-column=last-seen]')).toBeNull();
  });

  it('list 3: trip ID, route as available, vehicles, sighting age and the reason', () => {
    renderTable({
      list: 'unscheduled-with-realtime',
      trips: [
        tripItem({
          tripId: 'ghost',
          routeId: 'r9',
          routeShortName: null,
          routeLongName: null,
          headsign: null,
          scheduledStart: null,
          scheduledEnd: null,
          reason: 'unknown_trip',
        }),
        tripItem({
          tripId: 'no-route',
          routeId: null,
          routeShortName: null,
          routeLongName: null,
          reason: 'not_in_service',
        }),
      ],
    });
    const [ghost, noRoute] = rows() as [HTMLElement, HTMLElement];
    expect(ghost).toHaveTextContent('ghost');
    expect(ghost).toHaveTextContent('r9');
    expect(ghost).toHaveTextContent('bus-7');
    expect(ghost).toHaveTextContent('12 s ago');
    expect(ghost).toHaveTextContent('Trip ID not in schedule');
    expect(ghost.querySelector('[data-column=headsign]')).toBeNull();
    expect(noRoute.querySelector('[data-column=route]')).toHaveTextContent('—');
  });

  it('shows no clock time before the agency timezone is known', () => {
    renderTable({ timezone: null });
    expect(rows()[0]).not.toHaveTextContent('00:00');
    expect(rows()[0]!.querySelector('[data-column=schedule]')).toHaveTextContent('—');
  });
});

describe('TripTable reasons', () => {
  it.each(TRIP_REASONS)('renders %s with the exact text from the spec', (reason) => {
    renderTable({
      list: 'unscheduled-with-realtime',
      trips: [tripItem({ reason })],
    });
    expect(screen.getByText(REASON_TEXT[reason])).toBeInTheDocument();
  });
});

describe('TripTable title, links and states', () => {
  it('titles the list with its count', () => {
    renderTable({ count: 12, trips: [tripItem()] });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Active trips with realtime data (12)',
    );
  });

  it('shows a placeholder instead of a count while it is unknown', () => {
    renderTable({ count: null, trips: null });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /^Active trips with realtime data$/,
    );
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });

  it('makes every row a link to the trip detail without a query', () => {
    renderTable({ trips: [tripItem({ tripId: 'a b/c' })] });
    expect(within(rows()[0]!).getByRole('link')).toHaveAttribute('href', '/trips/a%20b%2Fc');
  });

  it('keeps the order the API returned', () => {
    renderTable({ trips: ['z', 'a', 'm'].map((tripId) => tripItem({ tripId })) });
    expect(rows().map((row) => row.querySelector('[data-slot=trip-id]')?.textContent)).toEqual([
      'z',
      'a',
      'm',
    ]);
  });

  it('explains an empty list instead of showing a blank area', () => {
    renderTable({ trips: [], count: 0 });
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  it('says so when the list could not be loaded at all', () => {
    renderTable({ trips: null, count: null, failed: true });
    expect(screen.getByText('Couldn’t load this list.')).toBeInTheDocument();
  });
});

describe('TripTable frequency trips', () => {
  const instance = (start: number): TripListItem =>
    tripItem({
      tripId: 'freq',
      scheduledStart: start,
      scheduledEnd: start + 1800,
      frequency: { exactTimes: true, headwaySecs: 600, windowStart: NOW, windowEnd: NOW + 7200 },
    });

  it('marks frequency rows and shows each instance’s own span and headway', () => {
    renderTable({ trips: [instance(NOW), instance(NOW + 600)] });
    const [first, second] = rows() as [HTMLElement, HTMLElement];
    expect(first).toHaveTextContent('00:00–00:30');
    expect(second).toHaveTextContent('00:10–00:40');
    for (const row of [first, second]) {
      expect(row).toHaveTextContent('Frequency');
      expect(row).toHaveTextContent('departs every 10 min');
    }
  });

  it('renders instances that share a trip ID as separate rows without key warnings', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderTable({ trips: [instance(NOW), instance(NOW + 600), instance(NOW + 1200)] });
    expect(rows()).toHaveLength(3);
    expect(error).not.toHaveBeenCalled();
  });

  it('does not mark plain trips', () => {
    renderTable();
    expect(rows()[0]).not.toHaveTextContent('departs every');
  });

  it('marks a frequency row of list 3 too', () => {
    renderTable({
      list: 'unscheduled-with-realtime',
      trips: [{ ...instance(NOW), reason: 'unmatched_start_time' }],
    });
    expect(rows()[0]).toHaveTextContent('departs every 10 min');
  });
});

describe('TripTable search', () => {
  const trips = [
    tripItem({ tripId: 'alpha-1', routeShortName: '38', routeLongName: 'Geary', routeId: 'r38' }),
    tripItem({ tripId: 'beta-2', routeShortName: null, routeLongName: 'Mission', routeId: 'r14' }),
    tripItem({ tripId: 'gamma-3', routeShortName: '7', routeLongName: null, routeId: 'r7' }),
  ];
  const tripIds = () => rows().map((row) => row.querySelector('[data-slot=trip-id]')?.textContent);

  it('filters by trip ID and by each route field, case-insensitively', async () => {
    renderTable({ trips, count: 3 });
    for (const [query, expected] of [
      ['ALPHA', ['alpha-1']],
      ['mission', ['beta-2']],
      ['r7', ['gamma-3']],
      ['38', ['alpha-1']],
      ['-', ['alpha-1', 'beta-2', 'gamma-3']],
    ] as const) {
      await userEvent.clear(search());
      await userEvent.type(search(), query);
      expect(tripIds(), query).toEqual(expected);
    }
  });

  it('keeps the count of the whole list and says how many match', async () => {
    renderTable({ trips, count: 3 });
    await userEvent.type(search(), 'alpha');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('(3)');
    expect(screen.getByText('Showing 1 of 3.')).toBeInTheDocument();
  });

  it('says when nothing matches, and recovers when cleared', async () => {
    renderTable({ trips, count: 3 });
    await userEvent.type(search(), 'nope');
    expect(screen.getByText('No trips match “nope”.')).toBeInTheDocument();
    await userEvent.clear(search());
    expect(rows()).toHaveLength(3);
  });

  it('searches each list on its own', async () => {
    render(
      <MemoryRouter>
        {(['one', 'two'] as const).map((name) => (
          <TripTable
            key={name}
            list="active-with-realtime"
            title={name}
            description="d"
            emptyText="e"
            trips={trips}
            count={3}
            timezone="UTC"
            nowSeconds={NOW}
          />
        ))}
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search one' }), 'alpha');
    expect(
      within(screen.getByRole('region', { name: /one/ })).getAllByRole('listitem'),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole('region', { name: /two/ })).getAllByRole('listitem'),
    ).toHaveLength(3);
  });
});

// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NOW, dashboard, feed } from '@/test/fixtures';
import { AgencyCard, RealtimeStatsCard, ScheduleStatsCard } from './summary-cards';

const stat = (id: string) => document.querySelector(`[data-stat="${id}"]`) as HTMLElement;

describe('AgencyCard', () => {
  it('shows the names, the zone, and the agency-local date and time', () => {
    render(
      <AgencyCard
        agency={{ names: ['Bay Transit', 'Ferry Co'], timezone: 'America/Los_Angeles' }}
        nowSeconds={NOW + 65}
      />,
    );
    expect(screen.getByText('Bay Transit, Ferry Co')).toBeInTheDocument();
    expect(screen.getByText('America/Los_Angeles')).toBeInTheDocument();
    expect(screen.getByText('2027-01-15 00:01:05 PST')).toBeInTheDocument();
  });

  it('shows no clock time for an unusable timezone, and a placeholder before the schedule', () => {
    const { rerender } = render(
      <AgencyCard agency={{ names: ['X'], timezone: 'Not/AZone' }} nowSeconds={NOW} />,
    );
    expect(document.querySelector('[data-field=clock]')).toHaveTextContent('—');
    rerender(<AgencyCard agency={null} nowSeconds={NOW} />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });
});

describe('ScheduleStatsCard', () => {
  it('shows both statistics, or placeholders while the schedule loads', () => {
    const { rerender } = render(
      <ScheduleStatsCard schedule={{ tripsToday: 120, tripsActiveNow: 14 }} />,
    );
    expect(stat('trips-today')).toHaveTextContent('Trips scheduled today120');
    expect(stat('trips-active')).toHaveTextContent('Trips active this minute14');

    rerender(<ScheduleStatsCard schedule={null} />);
    expect(
      within(stat('trips-today')).getByRole('status', { name: 'Loading' }),
    ).toBeInTheDocument();
    expect(
      within(stat('trips-active')).getByRole('status', { name: 'Loading' }),
    ).toBeInTheDocument();
  });
});

describe('RealtimeStatsCard', () => {
  const feeds = { vehiclePositions: feed(), tripUpdates: feed() };

  it('shows the four statistics', () => {
    render(<RealtimeStatsCard realtime={dashboard().realtime} feeds={feeds} nowSeconds={NOW} />);
    expect(stat('vehicles')).toHaveTextContent('Vehicles12');
    expect(stat('vehicles-with-trip-id')).toHaveTextContent('Vehicles with trip IDs11');
    expect(stat('trip-updates')).toHaveTextContent('Trip updates9');
    expect(stat('active-with-realtime')).toHaveTextContent('Active trips with realtime data8');
  });

  it('says "Not configured" for a statistic whose feed is not configured', () => {
    render(
      <RealtimeStatsCard
        realtime={{
          vehicles: null,
          vehiclesWithTripId: null,
          tripUpdates: 9,
          activeTripsWithRealtime: 8,
        }}
        feeds={{ vehiclePositions: null, tripUpdates: feed() }}
        nowSeconds={NOW}
      />,
    );
    expect(stat('vehicles')).toHaveTextContent('Not configured');
    expect(stat('vehicles-with-trip-id')).toHaveTextContent('Not configured');
    expect(stat('trip-updates')).toHaveTextContent('9');
    expect(screen.queryByText(/Vehicle positions:/)).not.toBeInTheDocument();
  });

  it('shows a loading placeholder for a configured feed with no snapshot yet', () => {
    render(
      <RealtimeStatsCard
        realtime={{
          vehicles: null,
          vehiclesWithTripId: null,
          tripUpdates: null,
          activeTripsWithRealtime: null,
        }}
        feeds={feeds}
        nowSeconds={NOW}
      />,
    );
    for (const id of [
      'vehicles',
      'vehicles-with-trip-id',
      'trip-updates',
      'active-with-realtime',
    ]) {
      expect(within(stat(id)).getByRole('status', { name: 'Loading' }), id).toBeInTheDocument();
    }
  });

  it('shows "Active trips with realtime data" as loading while it is null, whatever the feeds', () => {
    render(
      <RealtimeStatsCard
        realtime={{
          vehicles: 3,
          vehiclesWithTripId: 3,
          tripUpdates: 3,
          activeTripsWithRealtime: null,
        }}
        feeds={{ vehiclePositions: null, tripUpdates: feed() }}
        nowSeconds={NOW}
      />,
    );
    expect(
      within(stat('active-with-realtime')).getByRole('status', { name: 'Loading' }),
    ).toBeInTheDocument();
    expect(stat('active-with-realtime')).not.toHaveTextContent('Not configured');
  });

  it('shows placeholders before anything has been answered', () => {
    render(<RealtimeStatsCard realtime={null} feeds={null} nowSeconds={NOW} />);
    expect(within(stat('vehicles')).getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('shows the age of each configured feed’s latest successful update', () => {
    render(
      <RealtimeStatsCard
        realtime={dashboard().realtime}
        feeds={{
          vehiclePositions: feed({ lastSuccessAt: NOW - 12 }),
          tripUpdates: feed({ lastSuccessAt: null, stale: true }),
        }}
        nowSeconds={NOW}
      />,
    );
    expect(screen.getByText('Vehicle positions: updated 12 s ago')).toBeInTheDocument();
    expect(screen.getByText('Trip updates: no successful update yet')).toBeInTheDocument();
  });
});

import type { ListName, SessionStatus } from '@gtfs-rt-debugger/shared';
import { useState } from 'react';
import { useDashboard, useTripList } from '@/api/queries';
import { ConfigErrorsNotice } from '@/components/dashboard/config-errors-notice';
import {
  AgencyCard,
  RealtimeStatsCard,
  ScheduleStatsCard,
} from '@/components/dashboard/summary-cards';
import { TripTable } from '@/components/dashboard/trip-table';
import { useNowSeconds } from '@/lib/use-now';
import { useSession } from '@/session/use-session';

const LISTS: {
  list: ListName;
  title: string;
  description: string;
  emptyText: string;
  count: (counts: {
    [K in 'activeWithRealtime' | 'activeWithoutRealtime' | 'unscheduledWithRealtime']: number;
  }) => number;
}[] = [
  {
    list: 'active-with-realtime',
    title: 'Active trips with realtime data',
    description: 'Scheduled trips running this minute that the realtime feeds report.',
    emptyText: 'No scheduled trip running this minute has realtime data.',
    count: (counts) => counts.activeWithRealtime,
  },
  {
    list: 'active-without-realtime',
    title: 'Active trips without realtime data',
    description: 'Scheduled trips running this minute that have no realtime data.',
    emptyText: 'Every scheduled trip running this minute has realtime data.',
    count: (counts) => counts.activeWithoutRealtime,
  },
  {
    list: 'unscheduled-with-realtime',
    title: 'Trips not scheduled this minute, with realtime data',
    description: 'Trips the realtime feeds report that match no active scheduled trip, and why.',
    emptyText: 'Every trip in the realtime feeds matches a scheduled trip running this minute.',
    count: (counts) => counts.unscheduledWithRealtime,
  },
];

/**
 * The feeds' configuration and ages come from the last status that came from an active server:
 * a dormant status carries no feeds, and the page keeps showing what it last knew.
 */
function useLastActiveStatus(): SessionStatus | null {
  const { status } = useSession();
  const [lastActive, setLastActive] = useState<SessionStatus | null>(null);
  if (status?.state === 'active' && status !== lastActive) setLastActive(status);
  return status?.state === 'active' ? status : lastActive;
}

/** The `/` screen: session facts, statistics, and the three trip lists. */
export function DashboardPage() {
  const dashboard = useDashboard();
  const status = useLastActiveStatus();
  const nowSeconds = useNowSeconds();
  const tripLists = [
    useTripList('active-with-realtime'),
    useTripList('active-without-realtime'),
    useTripList('unscheduled-with-realtime'),
  ];

  const data = dashboard.data;
  const timezone = data?.agency?.timezone ?? null;

  return (
    <div className="flex flex-col gap-4">
      <ConfigErrorsNotice errors={data?.configurationErrors ?? null} />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <AgencyCard agency={data?.agency ?? null} nowSeconds={nowSeconds} />
        <ScheduleStatsCard schedule={data?.schedule ?? null} />
        <RealtimeStatsCard
          realtime={data?.realtime ?? null}
          feeds={status ? status.realtime : null}
          nowSeconds={nowSeconds}
        />
      </div>
      {LISTS.map((spec, index) => {
        const query = tripLists[index]!;
        const trips = query.data?.trips ?? null;
        return (
          <TripTable
            key={spec.list}
            list={spec.list}
            title={spec.title}
            description={spec.description}
            emptyText={spec.emptyText}
            trips={trips}
            count={trips?.length ?? (data?.lists ? spec.count(data.lists) : null)}
            failed={query.isError && trips === null}
            timezone={timezone}
            nowSeconds={nowSeconds}
          />
        );
      })}
    </div>
  );
}

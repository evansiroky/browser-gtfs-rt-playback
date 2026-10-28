import type { DashboardResponse, FeedStatus } from '@gtfs-rt-debugger/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ageSeconds, formatAge, formatAgencyTime } from '@/lib/time';
import { StatCard } from './stat-card';

/** The agency clock, or null while the zone is unknown or unusable: no clock time is guessed. */
function agencyClock(nowSeconds: number, timezone: string): string | null {
  try {
    return formatAgencyTime(nowSeconds, timezone, { date: true, seconds: true, zoneName: true });
  } catch {
    return null;
  }
}

/** Agency name(s), IANA timezone and the current agency-local date and time. */
export function AgencyCard({
  agency,
  nowSeconds,
}: {
  agency: DashboardResponse['agency'];
  nowSeconds: number;
}) {
  const clock = agency ? agencyClock(nowSeconds, agency.timezone) : null;
  return (
    <Card data-card="agency" className="gap-3">
      <CardHeader>
        <CardTitle>Agency</CardTitle>
      </CardHeader>
      <CardContent>
        {agency ? (
          <dl className="flex flex-col gap-1">
            <dt className="sr-only">Agency</dt>
            <dd className="text-lg font-semibold break-words" data-field="names">
              {agency.names.join(', ')}
            </dd>
            <dt className="sr-only">Timezone</dt>
            <dd className="text-sm text-muted-foreground" data-field="timezone">
              {agency.timezone}
            </dd>
            <dt className="sr-only">Local time</dt>
            <dd className="text-sm tabular-nums" data-field="clock">
              {clock ?? <span className="text-muted-foreground">—</span>}
            </dd>
          </dl>
        ) : (
          <div className="flex flex-col gap-2">
            <Skeleton role="status" aria-label="Loading" className="h-6 w-40" />
            <Skeleton className="h-4 w-32" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ScheduleStatsCard({ schedule }: { schedule: DashboardResponse['schedule'] }) {
  return (
    <Card data-card="schedule" className="gap-3">
      <CardHeader>
        <CardTitle>Schedule</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4">
          <StatCard
            id="trips-today"
            label="Trips scheduled today"
            value={schedule?.tripsToday ?? null}
          />
          <StatCard
            id="trips-active"
            label="Trips active this minute"
            value={schedule?.tripsActiveNow ?? null}
          />
        </dl>
      </CardContent>
    </Card>
  );
}

/** A feed's name and what is known of it; `null` status means the feed is not configured. */
export interface FeedInfo {
  name: string;
  status: FeedStatus | null;
}

function FeedAge({ feed, nowSeconds }: { feed: FeedInfo; nowSeconds: number }) {
  const at = feed.status?.lastSuccessAt ?? null;
  return (
    <li data-feed={feed.name}>
      {feed.name}:{' '}
      {at === null
        ? 'no successful update yet'
        : `updated ${formatAge(ageSeconds(nowSeconds, at))}`}
    </li>
  );
}

/**
 * The four realtime statistics with the last known numbers, and the age of each configured
 * feed's latest successful update. `feeds` is null while the server's configuration is not yet
 * known (nothing has been answered), in which case missing numbers show as loading.
 */
export function RealtimeStatsCard({
  realtime,
  feeds,
  nowSeconds,
}: {
  realtime: DashboardResponse['realtime'] | null;
  feeds: { vehiclePositions: FeedStatus | null; tripUpdates: FeedStatus | null } | null;
  nowSeconds: number;
}) {
  const missing = (feed: FeedStatus | null | undefined) =>
    feeds !== null && feed === null ? 'not-configured' : 'loading';
  const configured = feeds
    ? [
        { name: 'Vehicle positions', status: feeds.vehiclePositions },
        { name: 'Trip updates', status: feeds.tripUpdates },
      ].filter((feed) => feed.status !== null)
    : [];
  return (
    <Card data-card="realtime" className="gap-3">
      <CardHeader>
        <CardTitle>Realtime</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-4">
          <StatCard
            id="vehicles"
            label="Vehicles"
            value={realtime?.vehicles ?? null}
            whenMissing={missing(feeds?.vehiclePositions)}
          />
          <StatCard
            id="vehicles-with-trip-id"
            label="Vehicles with trip IDs"
            value={realtime?.vehiclesWithTripId ?? null}
            whenMissing={missing(feeds?.vehiclePositions)}
          />
          <StatCard
            id="trip-updates"
            label="Trip updates"
            value={realtime?.tripUpdates ?? null}
            whenMissing={missing(feeds?.tripUpdates)}
          />
          <StatCard
            id="active-with-realtime"
            label="Active trips with realtime data"
            value={realtime?.activeTripsWithRealtime ?? null}
          />
        </dl>
        {configured.length > 0 && (
          <ul className="text-xs text-muted-foreground" aria-label="Feed updates">
            {configured.map((feed) => (
              <FeedAge key={feed.name} feed={feed} nowSeconds={nowSeconds} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

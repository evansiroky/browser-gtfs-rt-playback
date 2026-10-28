import type {
  ConfigurationErrorCode,
  TripConfigurationError,
  TripScheduleDetail,
} from '@gtfs-rt-debugger/shared';
import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { agencyTime } from '@/lib/trip-format';
import { FrequencyTable } from './frequency-table';
import { KeyValueTable, type KeyValueRow } from './key-value-table';

const ERROR_TITLE: Record<ConfigurationErrorCode, string> = {
  mixed_exact_times: 'The frequencies.txt rows of this trip disagree on exact_times',
  unusable_stop_times:
    'Its start and end cannot be computed: the first or last stop time has no time',
  frequency_too_dense:
    'A frequency row has a headway so short that more than 2,000 instances of it could run at once',
};

/** Prominent, above the tables, which still show the rows as they are in the feed. */
function ConfigurationErrorAlert({ error }: { error: TripConfigurationError }) {
  return (
    <Alert variant="destructive" data-error-code={error.code}>
      <TriangleAlert />
      <AlertTitle className="line-clamp-none">{ERROR_TITLE[error.code] ?? error.code}</AlertTitle>
      <AlertDescription>
        <p>
          This trip&rsquo;s activity cannot be determined, so it is excluded from the schedule
          counts.
        </p>
        <p className="text-xs">{error.message}</p>
      </AlertDescription>
    </Alert>
  );
}

/** Every configuration error of the trip, each prominent, shown above the tables. */
export function ConfigurationErrors({ errors }: { errors: TripConfigurationError[] }) {
  return errors.map((error) => <ConfigurationErrorAlert key={error.code} error={error} />);
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/** The trips.txt row, every column, plus what the server worked out about the trip. */
function TripTable({
  scheduled,
  timezone,
}: {
  scheduled: TripScheduleDetail;
  timezone: string | null;
}) {
  const clock = (seconds: number | null): string =>
    seconds === null
      ? 'none'
      : (agencyTime(seconds, timezone, { date: true, seconds: true }) ?? '—');
  const computed: KeyValueRow[] = [
    { key: 'Scheduled start', value: clock(scheduled.start) },
    { key: 'Scheduled end', value: clock(scheduled.end) },
    { key: 'Operates on the service date', value: yesNo(scheduled.operatesOnServiceDate) },
    { key: 'Active now', value: yesNo(scheduled.activeNow) },
  ];
  return (
    <KeyValueTable
      label="trips.txt row"
      sections={[
        { rows: Object.entries(scheduled.trip).map(([key, value]) => ({ key, value })) },
        { heading: 'Computed from the schedule', columns: false, rows: computed },
      ]}
    />
  );
}

function RouteCard({ scheduled }: { scheduled: TripScheduleDetail }) {
  const { route } = scheduled;
  if (route === null) {
    const routeId = scheduled.trip.route_id;
    return (
      <Card data-card="route" className="min-w-0 gap-3">
        <CardHeader>
          <CardTitle>
            <h2>Route</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {routeId
            ? `Route ID “${routeId}” is not in routes.txt.`
            : 'The trip has no route_id, so there is no routes.txt row to show.'}
        </CardContent>
      </Card>
    );
  }
  const names = [route.route_short_name, route.route_long_name].filter(Boolean).join(' — ');
  return (
    <Card data-card="route" className="min-w-0 gap-3">
      <CardHeader>
        <CardTitle>
          <h2 className="break-words" data-slot="route-heading">
            Route{names ? ` ${names}` : ''}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <KeyValueTable
          label="routes.txt row"
          sections={[{ rows: Object.entries(route).map(([key, value]) => ({ key, value })) }]}
        />
      </CardContent>
    </Card>
  );
}

/** The scheduled half of the page: configuration errors, the trip and route rows, the frequencies. */
export function ScheduledTrip({
  tripId,
  scheduled,
  timezone,
}: {
  tripId: string;
  scheduled: TripScheduleDetail | null;
  timezone: string | null;
}) {
  if (scheduled === null) {
    return (
      <Card data-card="scheduled" className="gap-3">
        <CardHeader>
          <CardTitle>
            <h2>Scheduled trip</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          The trip ID <span className="font-medium break-all">{tripId}</span> is not in the schedule
          (trips.txt).
        </CardContent>
      </Card>
    );
  }
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        <Card data-card="scheduled" className="min-w-0 gap-3">
          <CardHeader>
            <CardTitle>
              <h2>Scheduled trip</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TripTable scheduled={scheduled} timezone={timezone} />
          </CardContent>
        </Card>
        <RouteCard scheduled={scheduled} />
      </div>
      {scheduled.frequencies !== null && (
        <Card data-card="frequencies" className="min-w-0 gap-3">
          <CardHeader>
            <CardTitle>
              <h2>Frequencies</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <FrequencyTable frequencies={scheduled.frequencies} timezone={timezone} />
          </CardContent>
        </Card>
      )}
    </>
  );
}

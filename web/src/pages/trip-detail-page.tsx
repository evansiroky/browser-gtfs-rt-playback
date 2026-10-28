import { decodePolyline6, type Ping, type TripDetailResponse } from '@gtfs-rt-debugger/shared';
import { ArrowLeft } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError } from '@/api/client';
import { useDashboard, useShape, useTripDetail } from '@/api/queries';
import { PingsList } from '@/components/trip/pings-list';
import { ConfigurationErrors, ScheduledTrip } from '@/components/trip/scheduled-trip';
import type { PingSelection } from '@/components/trip/selection';
import { TripUpdateCard } from '@/components/trip/trip-update-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { hasCoordinates } from '@/lib/ping-fields';
import { ageSeconds, formatAge } from '@/lib/time';
import { agencyTime, classificationLabel, formatServiceDate } from '@/lib/trip-format';
import { useNowSeconds } from '@/lib/use-now';
import { useSession } from '@/session/use-session';

// MapLibre is the largest dependency; only this screen needs it.
const TripMap = lazy(() => import('@/components/trip/trip-map'));

const HOUR_SECONDS = 3600;

function BackLink() {
  return (
    <div>
      <Button asChild variant="ghost" size="sm">
        <Link to="/">
          <ArrowLeft aria-hidden />
          Dashboard
        </Link>
      </Button>
    </div>
  );
}

function Header({
  detail,
  timezone,
  updatedAt,
  failed,
  nowSeconds,
}: {
  detail: TripDetailResponse;
  timezone: string | null;
  /** When the data was last fetched successfully, epoch seconds. */
  updatedAt: number;
  failed: boolean;
  nowSeconds: number;
}) {
  const age = formatAge(ageSeconds(nowSeconds, updatedAt));
  return (
    <Card data-card="header" className="gap-3">
      <CardHeader>
        <CardTitle>
          <h1 className="text-lg break-all">Trip {detail.tripId}</h1>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Service date{' '}
          <span data-field="service-date">{formatServiceDate(detail.serviceDate)}</span>
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {detail.classification.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Trip lists">
            {detail.classification.map((entry, index) => {
              const label = classificationLabel(entry, timezone);
              return (
                <li key={index}>
                  <Badge
                    variant="secondary"
                    data-list={entry.list}
                    className="h-auto max-w-full flex-wrap whitespace-normal"
                  >
                    {label.text}
                    {label.detail && (
                      <span className="font-normal text-muted-foreground">{label.detail}</span>
                    )}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
        <p
          className={
            failed ? 'text-sm font-medium text-destructive' : 'text-xs text-muted-foreground'
          }
          data-slot="age"
        >
          {failed ? `Couldn’t refresh; showing data from ${age}.` : `Updated ${age}`}
        </p>
      </CardContent>
    </Card>
  );
}

/** Why there is no line, when the trip is scheduled but the map has none to draw. */
function shapeMessage(
  scheduled: TripDetailResponse['scheduled'],
  shape: { loading: boolean; error: Error | null },
): string | null {
  if (scheduled === null) return null;
  if (scheduled.shapeId === null) return 'This trip has no shape_id, so no route line is drawn.';
  if (shape.error instanceof ApiError && shape.error.code === 'shape_not_found') {
    return `Shape “${scheduled.shapeId}” is not in shapes.txt, so no route line is drawn.`;
  }
  if (shape.error) return 'The route line could not be loaded.';
  return shape.loading ? 'Loading the route line…' : null;
}

function MapSection({
  pings,
  shapePoints,
  shapeNote,
  timezone,
  nowSeconds,
  selection,
  onSelect,
}: {
  pings: Ping[];
  shapePoints: [number, number][] | null;
  shapeNote: string | null;
  timezone: string | null;
  nowSeconds: number;
  selection: PingSelection | null;
  onSelect: (sequence: number) => void;
}) {
  const { status } = useSession();
  const showMap = shapePoints !== null || pings.some(hasCoordinates);
  const historyStartsAt = status?.historyStartsAt ?? null;
  const shortHistory =
    historyStartsAt !== null && nowSeconds - historyStartsAt < HOUR_SECONDS
      ? agencyTime(historyStartsAt, timezone, { seconds: true })
      : null;
  return (
    <Card data-card="map" className="min-w-0 gap-3">
      <CardHeader>
        <CardTitle>
          <h2>Map</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {pings.length === 0 && (
          <p className="text-sm" data-slot="no-pings">
            No vehicle positions have been received for this trip in the retained history
            {shortHistory ? `, which begins at ${shortHistory}.` : '.'}
          </p>
        )}
        {shapeNote && (
          <p className="text-sm text-muted-foreground" data-slot="shape-note">
            {shapeNote}
          </p>
        )}
        {showMap ? (
          <Suspense fallback={<Skeleton className="h-[22rem] w-full sm:h-[28rem]" />}>
            <TripMap
              shape={shapePoints}
              pings={pings}
              timezone={timezone}
              selection={selection}
              onSelect={onSelect}
            />
          </Suspense>
        ) : (
          pings.length > 0 && (
            <p className="text-sm text-muted-foreground">
              None of the vehicle positions has coordinates, so there is nothing to draw.
            </p>
          )
        )}
      </CardContent>
    </Card>
  );
}

function Loaded({
  detail,
  updatedAt,
  failed,
}: {
  detail: TripDetailResponse;
  updatedAt: number;
  failed: boolean;
}) {
  const dashboard = useDashboard();
  const timezone = dashboard.data?.agency?.timezone ?? null;
  const nowSeconds = useNowSeconds();
  const shape = useShape(detail.scheduled?.shapeId ?? null);
  const polyline = shape.data?.polyline;
  const shapePoints = useMemo(
    () => (polyline ? (decodePolyline6(polyline) as [number, number][]) : null),
    [polyline],
  );
  const shapeNote = shapeMessage(detail.scheduled, {
    loading: shape.isPending && shape.fetchStatus !== 'idle',
    error: shape.error,
  });

  const pings = detail.realtime.pings;
  const [selection, setSelection] = useState<PingSelection | null>(null);
  const [listOpen, setListOpen] = useState(false);
  // A selected ping that has since expired from the window is no longer selected.
  const selected = pings.some((ping) => ping.sequence === selection?.sequence) ? selection : null;
  const selectFromMarker = (sequence: number) => {
    setSelection({ sequence, pan: false });
    setListOpen(true);
  };
  const selectFromRow = (sequence: number) => setSelection({ sequence, pan: true });

  return (
    <>
      <Header
        detail={detail}
        timezone={timezone}
        updatedAt={updatedAt}
        failed={failed}
        nowSeconds={nowSeconds}
      />
      <ConfigurationErrors errors={detail.scheduled?.configurationErrors ?? []} />
      <MapSection
        pings={pings}
        shapePoints={shapePoints}
        shapeNote={shapeNote}
        timezone={timezone}
        nowSeconds={nowSeconds}
        selection={selected}
        onSelect={selectFromMarker}
      />
      <PingsList
        pings={pings}
        timezone={timezone}
        selection={selected}
        open={listOpen}
        onOpenChange={setListOpen}
        onSelect={selectFromRow}
      />
      <TripUpdateCard update={detail.realtime.tripUpdate} timezone={timezone} />
      <ScheduledTrip tripId={detail.tripId} scheduled={detail.scheduled} timezone={timezone} />
    </>
  );
}

/** The `/trips/:tripId` screen. */
export function TripDetailPage() {
  // The router has already percent-decoded the segment.
  const { tripId = '' } = useParams<{ tripId: string }>();
  const query = useTripDetail(tripId);
  const { status } = useSession();

  const notFound =
    query.error instanceof ApiError &&
    query.error.status === 404 &&
    query.error.code === 'trip_not_found';

  let body;
  if (notFound) {
    body = (
      <Card data-card="not-found">
        <CardHeader>
          <CardTitle>
            <h1 className="text-lg">Trip not found</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <p>
            The trip ID <span className="font-medium break-all">{tripId}</span> is not in the
            schedule, the latest realtime data or the retained history.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-3">
            <Link to="/">Back to the dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    );
  } else if (query.data) {
    body = (
      <Loaded detail={query.data} updatedAt={query.dataUpdatedAt / 1000} failed={query.isError} />
    );
  } else {
    const waiting = status?.state === 'active' && status.schedule.state !== 'ready';
    body = (
      <Card data-card="loading">
        <CardHeader>
          <CardTitle>
            <h1 className="text-lg break-all">Trip {tripId}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3" aria-busy={!query.isError}>
          {query.isError ? (
            <p className="text-sm text-muted-foreground">Couldn’t load this trip.</p>
          ) : (
            <>
              {waiting && (
                <p className="text-sm text-muted-foreground">
                  The trip can be shown once the schedule has loaded.
                </p>
              )}
              <Skeleton className="h-16" />
              <Skeleton className="h-48" />
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <BackLink />
      {body}
    </div>
  );
}

import type { ListName, TripListItem } from '@gtfs-rt-debugger/shared';
import { Search } from 'lucide-react';
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  formatHeadway,
  formatSpan,
  matchesSearch,
  rowKeys,
  routeLabel,
  tripPath,
} from '@/lib/trip-format';
import { ageSeconds, formatAge } from '@/lib/time';
import { ReasonLabel } from './reason-label';

interface RowContext {
  timezone: string | null;
  nowSeconds: number;
}

interface Column {
  id: string;
  label: string;
  /** Width in the desktop grid. */
  width: string;
  render: (item: TripListItem, context: RowContext) => ReactNode;
}

const NONE = <span className="text-muted-foreground">—</span>;

const tripId: Column = {
  id: 'trip',
  label: 'Trip ID',
  width: 'minmax(9rem, 1.6fr)',
  render: (item) => (
    <span data-slot="trip-id" className="font-medium break-all">
      {item.tripId}
    </span>
  ),
};

const route: Column = {
  id: 'route',
  label: 'Route',
  width: 'minmax(5rem, 0.8fr)',
  render: (item) => {
    const label = routeLabel(item);
    return label === null ? NONE : <span title={item.routeId ?? undefined}>{label}</span>;
  },
};

const headsign: Column = {
  id: 'headsign',
  label: 'Headsign',
  width: 'minmax(8rem, 1.4fr)',
  render: (item) => item.headsign || NONE,
};

const schedule: Column = {
  id: 'schedule',
  label: 'Scheduled',
  width: 'minmax(9rem, 1fr)',
  render: (item, { timezone }) => {
    const span = formatSpan(item, timezone);
    return (
      <span className="flex flex-col">
        <span className="tabular-nums">{span ?? NONE}</span>
        <FrequencyNote item={item} />
      </span>
    );
  },
};

const vehicles: Column = {
  id: 'vehicles',
  label: 'Vehicle',
  width: 'minmax(6rem, 1fr)',
  render: (item) =>
    item.realtime && item.realtime.vehicleIds.length > 0 ? (
      <span className="break-all">{item.realtime.vehicleIds.join(', ')}</span>
    ) : (
      NONE
    ),
};

const lastSeen: Column = {
  id: 'last-seen',
  label: 'Last seen',
  width: 'minmax(5.5rem, 0.7fr)',
  render: (item, { nowSeconds }) =>
    item.realtime?.lastSeenAt != null ? (
      <span className="tabular-nums">
        {formatAge(ageSeconds(nowSeconds, item.realtime.lastSeenAt))}
      </span>
    ) : (
      NONE
    ),
};

const reason: Column = {
  id: 'reason',
  label: 'Reason',
  width: 'minmax(12rem, 1.6fr)',
  render: (item) => (
    <span className="flex flex-col">
      <ReasonLabel reason={item.reason} />
      <FrequencyNote item={item} />
    </span>
  ),
};

/** Lists 1 and 2 show the nominal span (and the headway) of each active instance. */
const COLUMNS: Record<ListName, Column[]> = {
  'active-with-realtime': [tripId, route, headsign, schedule, vehicles, lastSeen],
  'active-without-realtime': [tripId, route, headsign, schedule],
  'unscheduled-with-realtime': [tripId, route, vehicles, lastSeen, reason],
};

function FrequencyNote({ item }: { item: TripListItem }) {
  if (item.frequency === null) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Badge variant="secondary" className="px-1.5 py-0">
        Frequency
      </Badge>
      departs every {formatHeadway(item.frequency.headwaySecs)}
    </span>
  );
}

export interface TripTableProps {
  list: ListName;
  title: string;
  description: string;
  /** What to say when the list is empty. */
  emptyText: string;
  /** The rows, or null while the list has not loaded. */
  trips: TripListItem[] | null;
  /** The count shown in the title; null while unknown. */
  count: number | null;
  /** The list could not be loaded and no earlier copy exists. */
  failed?: boolean;
  /** Null until the agency timezone is known: no clock time is shown. */
  timezone: string | null;
  nowSeconds: number;
}

/** One of the three lists: a count in the title, a search box, and a link per row. */
export function TripTable({
  list,
  title,
  description,
  emptyText,
  trips,
  count,
  failed = false,
  timezone,
  nowSeconds,
}: TripTableProps) {
  const [query, setQuery] = useState('');
  const headingId = useId();
  const columns = COLUMNS[list];
  const context: RowContext = { timezone, nowSeconds };
  const gridStyle = { '--columns': columns.map((c) => c.width).join(' ') } as CSSProperties;

  const visible = trips?.filter((item) => matchesSearch(item, query)) ?? null;
  const keys = visible ? rowKeys(visible) : [];
  const filtering = query.trim() !== '';

  return (
    <Card role="region" data-list={list} aria-labelledby={headingId} className="gap-4">
      <CardHeader>
        <CardTitle>
          <h2 id={headingId} className="flex flex-wrap items-center gap-x-2">
            <span>{title}</span>{' '}
            {count !== null ? (
              <span data-slot="count" className="tabular-nums">
                ({count})
              </span>
            ) : (
              <Skeleton role="status" aria-label="Loading" className="h-4 w-8" />
            )}
          </h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="relative max-w-sm">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={`Search ${title}`}
            placeholder="Search trip ID or route"
            className="pl-8"
          />
        </div>
        {visible === null ? (
          failed ? (
            <p className="text-sm text-muted-foreground">Couldn’t load this list.</p>
          ) : (
            <div className="flex flex-col gap-2" aria-busy>
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          )
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-slot="empty">
            {filtering ? `No trips match “${query.trim()}”.` : emptyText}
          </p>
        ) : (
          <div>
            {filtering && (
              <p className="mb-2 text-sm text-muted-foreground">
                Showing {visible.length} of {trips?.length}.
              </p>
            )}
            <div
              aria-hidden
              style={gridStyle}
              className="hidden gap-x-4 border-b px-3 pb-2 text-xs font-medium text-muted-foreground md:grid md:[grid-template-columns:var(--columns)]"
            >
              {columns.map((column) => (
                <div key={column.id}>{column.label}</div>
              ))}
            </div>
            <ul className="divide-y">
              {visible.map((item, index) => (
                <li key={keys[index]}>
                  <Link
                    to={tripPath(item.tripId)}
                    style={gridStyle}
                    data-trip-id={item.tripId}
                    className="grid gap-x-4 gap-y-1 rounded-md px-3 py-2 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 md:[grid-template-columns:var(--columns)]"
                  >
                    {columns.map((column) => (
                      <div key={column.id} data-column={column.id} className="min-w-0">
                        <span className="mr-1 text-xs text-muted-foreground md:hidden">
                          {column.label}
                        </span>
                        {column.render(item, context)}
                      </div>
                    ))}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

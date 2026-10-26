import type { Ping } from '@gtfs-rt-debugger/shared';
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { hasCoordinates, pingFields, pingTime, vehicleText } from '@/lib/ping-fields';
import type { PingSelection } from './selection';

/** A row: the number, the vehicle timestamp on the agency clock, the vehicle, then what was sent. */
function PingRow({
  ping,
  timezone,
  selection,
  onSelect,
}: {
  ping: Ping;
  timezone: string | null;
  /** The selection when it is this row's ping, else null. */
  selection: PingSelection | null;
  onSelect: (sequence: number) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const selected = selection !== null;
  const time = pingTime(ping, timezone);
  const fields = pingFields(ping);
  // Every selection, a marker click included, brings its row into view.
  useEffect(() => {
    if (selection) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selection]);
  return (
    <li
      ref={ref}
      data-sequence={ping.sequence}
      data-selected={selected}
      onClick={() => onSelect(ping.sequence)}
      className={cn(
        'cursor-pointer px-3 py-2 text-sm hover:bg-accent/50',
        selected && 'bg-accent ring-2 ring-ring ring-inset',
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 text-left outline-none focus-visible:underline"
      >
        <span
          data-slot="sequence"
          className="inline-flex min-w-7 justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums"
        >
          {ping.sequence}
        </span>
        <span data-slot="time" className="tabular-nums">
          {time ?? '—'}
        </span>
        <span data-slot="vehicle" className="font-medium break-all">
          {vehicleText(ping)}
        </span>
        {!hasCoordinates(ping) && (
          <span className="text-xs text-muted-foreground">no position, so no marker</span>
        )}
      </button>
      {fields.length > 0 && (
        <dl className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-0.5 pl-1 text-xs">
          {fields.map((field) => (
            <div key={field.key} data-field={field.key} className="min-w-0">
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="break-words tabular-nums">{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/** "Vehicle positions (N)", collapsed until opened, every ping in sequence order. */
export function PingsList({
  pings,
  timezone,
  selection,
  open,
  onOpenChange,
  onSelect,
}: {
  pings: Ping[];
  timezone: string | null;
  selection: PingSelection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (sequence: number) => void;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} asChild>
      <Card data-card="pings" className="min-w-0 gap-0 py-0">
        <CardHeader className="px-0">
          <CardTitle>
            <h2>
              <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-xl px-6 py-4 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <ChevronDown
                  aria-hidden
                  className="size-4 transition-transform group-data-[state=closed]:-rotate-90"
                />
                Vehicle positions ({pings.length})
              </CollapsibleTrigger>
            </h2>
          </CardTitle>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="px-0 pb-2">
            {pings.length === 0 ? (
              <p className="px-6 pb-4 text-sm text-muted-foreground">
                No vehicle positions in the retained history.
              </p>
            ) : (
              <ul className="divide-y border-t">
                {pings.map((ping) => (
                  <PingRow
                    key={ping.sequence}
                    ping={ping}
                    timezone={timezone}
                    selection={selection?.sequence === ping.sequence ? selection : null}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

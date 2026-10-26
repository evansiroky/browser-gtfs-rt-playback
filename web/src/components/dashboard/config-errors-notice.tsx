import type { DashboardResponse } from '@gtfs-rt-debugger/shared';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { tripPath } from '@/lib/trip-format';

type ConfigurationErrors = NonNullable<DashboardResponse['configurationErrors']>;

/**
 * Schedule problems found when the schedule loaded. `total` counts errors, not trips: a trip
 * with two problems counts twice. Hidden when there are none.
 */
export function ConfigErrorsNotice({ errors }: { errors: ConfigurationErrors | null }) {
  if (errors === null || errors.total <= 0) return null;
  const { total, items } = errors;
  return (
    <Alert variant="destructive" data-notice="configuration-errors">
      <TriangleAlert />
      <AlertTitle className="line-clamp-none">
        {total} schedule configuration {total === 1 ? 'error' : 'errors'}: the trips concerned are
        excluded from the counts and lists
      </AlertTitle>
      <AlertDescription className="justify-items-stretch">
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <ChevronDown
              aria-hidden
              className="size-4 transition-transform group-data-[state=open]:rotate-180"
            />
            Show the trips
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 flex flex-col gap-2">
              {items.map((item, index) => (
                <li key={`${item.tripId}|${item.code}|${index}`} data-code={item.code}>
                  <Link to={tripPath(item.tripId)} className="font-medium break-all underline">
                    {item.tripId}
                  </Link>
                  <span className="block text-foreground/80">{item.message}</span>
                </li>
              ))}
            </ul>
            {items.length < total && (
              <p className="mt-2">
                Showing the first {items.length} of {total} errors.
              </p>
            )}
          </CollapsibleContent>
        </Collapsible>
      </AlertDescription>
    </Alert>
  );
}

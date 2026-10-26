import type { TripUpdateSummary } from '@gtfs-rt-debugger/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { agencyTime } from '@/lib/trip-format';
import { KeyValueTable } from './key-value-table';

/** "+90 s" / "-30 s": the delay as sent, signed. */
function delayText(seconds: number): string {
  return `${seconds > 0 ? '+' : ''}${seconds} s`;
}

/** The latest snapshot's update for this trip, or the statement that there is none. */
export function TripUpdateCard({
  update,
  timezone,
}: {
  update: TripUpdateSummary | null;
  timezone: string | null;
}) {
  const absent = <span className="text-muted-foreground">not sent</span>;
  return (
    <Card data-card="trip-update" className="min-w-0 gap-3">
      <CardHeader>
        <CardTitle>
          <h2>Trip update</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {update === null ? (
          <p>No trip update is currently present for this trip.</p>
        ) : (
          <KeyValueTable
            label="Latest trip update"
            sections={[
              {
                columns: false,
                rows: [
                  {
                    key: 'Timestamp',
                    value:
                      update.timestamp === null
                        ? absent
                        : (agencyTime(update.timestamp, timezone, { date: true, seconds: true }) ??
                          '—'),
                  },
                  { key: 'Delay', value: update.delay === null ? absent : delayText(update.delay) },
                  { key: 'Vehicle ID', value: update.vehicleId ?? absent },
                  {
                    key: 'Schedule relationship',
                    value: update.scheduleRelationship ?? absent,
                  },
                  { key: 'Stop time updates', value: String(update.stopTimeUpdateCount) },
                ],
              },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

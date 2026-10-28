import type { TripFrequencyDetail } from '@gtfs-rt-debugger/shared';
import { Badge } from '@/components/ui/badge';
import { agencyTime, formatHeadway } from '@/lib/trip-format';

const NOMINAL_NOTE = 'Departures are assumed to be exactly on the headway.';
const UNREADABLE_NOTE = 'Its times or headway cannot be read, so it has no instances.';

/** `exact_times` absent or `0`: the feed does not promise departures on the headway. */
function isNominal(row: TripFrequencyDetail['row']): boolean {
  const value = row.exact_times?.trim();
  return value === undefined || value === '' || value === '0';
}

function isReadable(frequency: TripFrequencyDetail): boolean {
  return (
    frequency.headwaySecs !== null && frequency.windowStart !== null && frequency.windowEnd !== null
  );
}

/** Every column that any row has, in order of first appearance. */
function columnsOf(frequencies: TripFrequencyDetail[]): string[] {
  const columns: string[] = [];
  for (const { row } of frequencies) {
    for (const column of Object.keys(row)) if (!columns.includes(column)) columns.push(column);
  }
  return columns;
}

const NONE = <span className="text-muted-foreground">—</span>;

/** The rows of the trip's frequencies.txt, every column, with what the server derived from each. */
export function FrequencyTable({
  frequencies,
  timezone,
}: {
  frequencies: TripFrequencyDetail[];
  timezone: string | null;
}) {
  const columns = columnsOf(frequencies);
  const clock = (seconds: number) => agencyTime(seconds, timezone, { seconds: true }) ?? NONE;
  return (
    <div className="overflow-x-auto">
      <table aria-label="frequencies.txt rows" className="w-full text-left text-sm">
        <thead>
          <tr className="border-b align-bottom text-xs">
            {columns.map((column) => (
              <th key={column} scope="col" className="py-1 pr-4 font-mono font-normal">
                {column}
              </th>
            ))}
            <th scope="col" className="py-1 pr-4 font-medium">
              Window
            </th>
            <th scope="col" className="py-1 pr-4 font-medium">
              Template duration
            </th>
            <th scope="col" className="py-1 pr-4 font-medium">
              Active now
            </th>
            <th scope="col" className="py-1 pr-4 font-medium">
              Active instance starts
            </th>
            <th scope="col" className="min-w-56 py-1 font-medium">
              Note
            </th>
          </tr>
        </thead>
        <tbody>
          {frequencies.map((frequency, index) => {
            const readable = isReadable(frequency);
            return (
              <tr
                key={index}
                data-row={index}
                data-readable={readable}
                className="border-b align-top last:border-0"
              >
                {columns.map((column) => (
                  <td key={column} data-column={column} className="py-1.5 pr-4 break-words">
                    {frequency.row[column] === undefined ? (
                      NONE
                    ) : frequency.row[column] === '' ? (
                      <span className="text-muted-foreground italic">(empty)</span>
                    ) : (
                      frequency.row[column]
                    )}
                  </td>
                ))}
                {readable ? (
                  <>
                    <td data-field="window" className="py-1.5 pr-4 whitespace-nowrap tabular-nums">
                      {clock(frequency.windowStart!)}–{clock(frequency.windowEnd!)}
                    </td>
                    <td data-field="template" className="py-1.5 pr-4 whitespace-nowrap">
                      {frequency.templateDurationSecs === null
                        ? 'cannot be computed'
                        : formatHeadway(frequency.templateDurationSecs)}
                    </td>
                    <td data-field="active" className="py-1.5 pr-4">
                      {frequency.activeNow ? 'yes' : 'no'}
                    </td>
                    <td data-field="starts" className="py-1.5 pr-4 whitespace-nowrap tabular-nums">
                      {frequency.activeInstanceStarts.length > 0
                        ? frequency.activeInstanceStarts.map((start, at) => (
                            <span key={start}>
                              {at > 0 && ', '}
                              {clock(start)}
                            </span>
                          ))
                        : 'none'}
                    </td>
                    <td data-field="note" className="py-1.5 text-muted-foreground">
                      {isNominal(frequency.row) && NOMINAL_NOTE}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="py-1.5 pr-4">{NONE}</td>
                    <td className="py-1.5 pr-4">{NONE}</td>
                    <td className="py-1.5 pr-4">{NONE}</td>
                    <td className="py-1.5 pr-4">{NONE}</td>
                    <td data-field="note" className="py-1.5">
                      <Badge variant="destructive" className="mb-1">
                        Unreadable
                      </Badge>{' '}
                      {UNREADABLE_NOTE}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

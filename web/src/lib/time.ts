export interface AgencyTimeOptions {
  /** Prefix the clock time with the `YYYY-MM-DD` date. */
  date?: boolean;
  /** Include seconds (`HH:mm:ss`). */
  seconds?: boolean;
  /** Append the zone abbreviation, for example `EDT`. */
  zoneName?: boolean;
}

/**
 * Renders an instant on the agency's wall clock, 24-hour (`HH:mm`). The agency's IANA zone is
 * always passed explicitly: the browser's own zone is never consulted
 * ([Agency-local time](../../../specs/principles.md#agency-local-time)). Throws a `RangeError`
 * for an unknown zone, so callers show no clock time until the zone is known.
 */
export function formatAgencyTime(
  epochSeconds: number,
  timezone: string,
  options: AgencyTimeOptions = {},
): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: options.zoneName ? 'short' : undefined,
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(epochSeconds * 1000)) parts[part.type] = part.value;

  let text = `${parts.hour}:${parts.minute}`;
  if (options.seconds) text += `:${parts.second}`;
  if (options.date) text = `${parts.year}-${parts.month}-${parts.day} ${text}`;
  if (options.zoneName) text += ` ${parts.timeZoneName}`;
  return text;
}

/** Whole seconds elapsed since `thenSeconds`; never negative (client and server clocks differ). */
export function ageSeconds(nowSeconds: number, thenSeconds: number): number {
  return Math.max(0, Math.floor(nowSeconds - thenSeconds));
}

/** "12 s ago", "3 min ago", "1 h 5 min ago". */
export function formatAge(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total} s ago`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h ago` : `${hours} h ${rest} min ago`;
}

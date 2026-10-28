import type { Ping } from '@gtfs-rt-debugger/shared';
import { agencyTime } from './trip-format';

export interface PingField {
  /** The field's name as the API sends it, for the data attribute. */
  key: string;
  label: string;
  value: string;
}

/**
 * The fields a row shows, in this order, with their labels. Anything else the API passes through
 * is shown after them under its own name.
 */
const KNOWN_FIELDS: { key: keyof Ping & string; label: string; unit?: string }[] = [
  { key: 'latitude', label: 'Latitude' },
  { key: 'longitude', label: 'Longitude' },
  { key: 'bearing', label: 'Bearing', unit: '°' },
  { key: 'speed', label: 'Speed', unit: ' m/s' },
  { key: 'odometer', label: 'Odometer', unit: ' m' },
  { key: 'currentStatus', label: 'Current status' },
  { key: 'currentStopSequence', label: 'Current stop sequence' },
  { key: 'stopId', label: 'Stop ID' },
  { key: 'occupancyStatus', label: 'Occupancy' },
  { key: 'occupancyPercentage', label: 'Occupancy percentage', unit: '%' },
  { key: 'congestionLevel', label: 'Congestion level' },
  { key: 'licensePlate', label: 'License plate' },
  { key: 'scheduleRelationship', label: 'Schedule relationship' },
  { key: 'routeId', label: 'Route ID' },
  { key: 'directionId', label: 'Direction ID' },
  { key: 'startDate', label: 'Start date' },
  { key: 'startTime', label: 'Start time' },
];

/** Shown in the row header or not at all (the server's bookkeeping), so not repeated below. */
const HEADER_FIELDS = new Set<string>([
  'sequence',
  'timestamp',
  'receivedAt',
  'vehicleId',
  'vehicleLabel',
]);

const KNOWN_KEYS = new Set<string>(KNOWN_FIELDS.map((field) => field.key));

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function show(value: unknown): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** The fields of a ping that have a value; absent ones are omitted rather than shown empty. */
export function pingFields(ping: Ping): PingField[] {
  const known = KNOWN_FIELDS.filter(({ key }) => isPresent(ping[key])).map(
    ({ key, label, unit }) => ({ key, label, value: `${show(ping[key])}${unit ?? ''}` }),
  );
  const extra = Object.entries(ping)
    .filter(([key, value]) => !KNOWN_KEYS.has(key) && !HEADER_FIELDS.has(key) && isPresent(value))
    .map(([key, value]) => ({ key, label: key, value: show(value) }));
  return [...known, ...extra];
}

/** The ping's vehicle: its ID, and its label when it has one. */
export function vehicleText(ping: Pick<Ping, 'vehicleId' | 'vehicleLabel'>): string {
  return ping.vehicleLabel ? `${ping.vehicleId} (${ping.vehicleLabel})` : ping.vehicleId;
}

/** Ping time on the agency clock with seconds; null until the timezone is known. */
export function pingTime(ping: Pick<Ping, 'timestamp'>, timezone: string | null): string | null {
  return agencyTime(ping.timestamp, timezone, { seconds: true });
}

export function hasCoordinates<T extends Pick<Ping, 'latitude' | 'longitude'>>(
  ping: T,
): ping is T & { latitude: number; longitude: number } {
  return ping.latitude !== null && ping.longitude !== null;
}

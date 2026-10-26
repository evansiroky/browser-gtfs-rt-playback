import { strToU8, zipSync } from 'fflate';
import type { ChunkedBody } from '../schedule/download.js';

/** A minimal valid schedule, as file name to text; override or drop files per test. */
export function miniSchedule(
  overrides: Record<string, string | null> = {},
): Record<string, string> {
  const files: Record<string, string | null> = {
    'agency.txt':
      'agency_id,agency_name,agency_url,agency_timezone\nA,Mini Transit,https://x.test,America/Chicago\n',
    'routes.txt': 'route_id,route_short_name,route_type\nR1,1,3\n',
    'trips.txt': 'route_id,service_id,trip_id,shape_id\nR1,WK,T1,S1\n',
    'stop_times.txt':
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,A,1\nT1,08:30:00,08:30:00,B,2\n',
    'calendar.txt':
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260101,20261231\n',
    'shapes.txt':
      'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nS1,41.0,-87.0,1\nS1,41.1,-87.1,2\n',
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

/** A zip of text files. */
export function zipOf(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries = Object.fromEntries(
    Object.entries(files).map(([name, content]) => [
      name,
      typeof content === 'string' ? strToU8(content) : content,
    ]),
  );
  return zipSync(entries, { level: 1 });
}

/** The bytes as a body of chunks of `chunkSize`, to exercise reads across chunk boundaries. */
export function chunked(bytes: Uint8Array, chunkSize = bytes.byteLength): ChunkedBody {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, offset + chunkSize));
  }
  return { chunks, size: bytes.byteLength };
}

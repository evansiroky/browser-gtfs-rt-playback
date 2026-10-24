import { unzipSync, strFromU8 } from 'fflate';
import { parseCsv } from './csv.js';

export class GtfsError extends Error {}

const REQUIRED = ['agency.txt', 'routes.txt', 'stops.txt'];

// Reduce a GTFS Schedule zip (Uint8Array) to the summary shown by the UI.
export function summarizeGtfs(zipBytes) {
  let files;
  try {
    // Only inflate the files we read; feeds can contain very large stop_times.txt.
    const wanted = new Set([...REQUIRED, 'calendar.txt', 'calendar_dates.txt']);
    files = unzipSync(zipBytes, { filter: (f) => wanted.has(f.name) });
  } catch {
    throw new GtfsError('The response is not a valid zip archive.');
  }

  const table = (name, optional = false) => {
    const bytes = files[name];
    if (!bytes) {
      if (optional) return [];
      throw new GtfsError(`Required file ${name} is missing from the archive.`);
    }
    return parseCsv(strFromU8(bytes));
  };

  const agencies = table('agency.txt').map((a) => ({
    name: a.agency_name,
    url: a.agency_url,
    timezone: a.agency_timezone,
  }));

  const dates = [];
  for (const c of table('calendar.txt', true)) dates.push(c.start_date, c.end_date);
  for (const d of table('calendar_dates.txt', true)) {
    if (d.exception_type === '1') dates.push(d.date);
  }
  const valid = dates.filter((d) => /^\d{8}$/.test(d)).sort();

  return {
    agencies,
    routeCount: table('routes.txt').length,
    stopCount: table('stops.txt').length,
    serviceStart: valid.length ? formatDate(valid[0]) : null,
    serviceEnd: valid.length ? formatDate(valid[valid.length - 1]) : null,
  };
}

function formatDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

import type { Page } from 'playwright-core';
import { TIMEZONE, type Scenario } from '@gtfs-rt-debugger/fixtures';

export type ListId =
  'active-with-realtime' | 'active-without-realtime' | 'unscheduled-with-realtime';

export const LIST_IDS: readonly ListId[] = [
  'active-with-realtime',
  'active-without-realtime',
  'unscheduled-with-realtime',
];

export const LIST_TITLES: Record<ListId, string> = {
  'active-with-realtime': 'Active trips with realtime data',
  'active-without-realtime': 'Active trips without realtime data',
  'unscheduled-with-realtime': 'Trips not scheduled this minute, with realtime data',
};

/** The reason texts of the dashboard spec, spelled out here independently of the web code. */
export const REASON_TEXTS: Record<string, string> = {
  unknown_trip: 'Trip ID not in schedule',
  not_in_service: 'Not in service on this date',
  configuration_error: 'Schedule configuration error (see trip)',
  missing_start_time: 'Frequency trip, but the feed sent no start time',
  unmatched_start_time: 'Start time matches no scheduled departure',
  outside_scheduled_time: 'Outside its scheduled time',
};

/** What a statistic shows: its number, or its placeholder text. */
export async function readStats(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-stat]')].map((stat) => {
        const value = stat.querySelector<HTMLElement>('dd')!;
        const placeholder = value.querySelector('[role=status]');
        return [
          stat.dataset.stat!,
          placeholder?.getAttribute('aria-label') ?? value.innerText.trim(),
        ];
      }),
    ),
  );
}

export interface RowView {
  href: string;
  /** Visible text of each column, whitespace collapsed. */
  cells: Record<string, string>;
}

export interface ListView {
  heading: string;
  rows: RowView[];
}

/** The visible heading and rows of one list. */
export async function readList(page: Page, list: ListId): Promise<ListView> {
  return page.evaluate((id) => {
    const section = document.querySelector<HTMLElement>(`[data-list="${id}"]`)!;
    const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
    return {
      heading: collapse(section.querySelector<HTMLElement>('h2')!.innerText),
      rows: [...section.querySelectorAll<HTMLAnchorElement>('li > a')].map((link) => ({
        href: link.getAttribute('href')!,
        cells: Object.fromEntries(
          [...link.querySelectorAll<HTMLElement>('[data-column]')].map((cell) => [
            cell.dataset.column!,
            collapse(cell.innerText),
          ]),
        ),
      })),
    };
  }, list);
}

const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "08:15" on the agency clock. */
export function agencyClock(epochSeconds: number): string {
  return clockFormat.format(epochSeconds * 1000);
}

type Expected = Scenario['expected'];
type ExpectedRow =
  | Expected['lists']['activeWithRealtime'][number]
  | Expected['lists']['unscheduledWithRealtime'][number];

function formatHeadway(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** The text the scenario's ground truth says a row must show in each column. */
export function expectedCells(row: ExpectedRow, list: ListId): Record<string, string> {
  const route = row.routeShortName || row.routeLongName || row.routeId || '—';
  const frequency = row.frequency
    ? `Frequency departs every ${formatHeadway(row.frequency.headwaySecs)}`
    : '';
  const cells: Record<string, string> = { trip: row.tripId, route };
  if (list !== 'unscheduled-with-realtime') {
    const active = row as Expected['lists']['activeWithRealtime'][number];
    cells.headsign = row.headsign || '—';
    cells.schedule = [
      `${agencyClock(active.scheduledStart)}–${agencyClock(active.scheduledEnd)}`,
      frequency,
    ]
      .filter(Boolean)
      .join(' ');
  }
  if (list !== 'active-without-realtime') {
    cells.vehicles = row.realtime?.vehicleIds.length
      ? [...row.realtime.vehicleIds].sort().join(', ')
      : '—';
  }
  if (list === 'unscheduled-with-realtime') {
    const reason = (row as Expected['lists']['unscheduledWithRealtime'][number]).reason;
    cells.reason = [REASON_TEXTS[reason], frequency].filter(Boolean).join(' ');
  }
  return cells;
}

/** A row's visible cells, vehicle IDs sorted (their order is not specified) and sightings removed. */
export function normalizeCells(cells: Record<string, string>): Record<string, string> {
  const rest = { ...cells };
  delete rest['last-seen'];
  if (rest.vehicles && rest.vehicles !== '—') {
    rest.vehicles = rest.vehicles.split(', ').sort().join(', ');
  }
  return rest;
}

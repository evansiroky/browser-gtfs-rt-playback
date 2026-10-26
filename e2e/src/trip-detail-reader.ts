import type { Page } from 'playwright-core';
import { TIMEZONE } from '@gtfs-rt-debugger/fixtures';
import type { TripDetailResponse } from '@gtfs-rt-debugger/shared';

const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** "08:15:07" on the agency clock, spelled out here independently of the web code. */
export function clockWithSeconds(epochSeconds: number): string {
  return clockFormat.format(epochSeconds * 1000);
}

/** "8 min" / "1 min 30 s" / "45 s", the way a duration is spelled on the page. */
export function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** The trip detail responses the page receives, in order, recorded from the network. */
export function recordTripResponses(page: Page, tripId: string): TripDetailResponse[] {
  const bodies: TripDetailResponse[] = [];
  const path = `/api/v1/trips/${encodeURIComponent(tripId)}`;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== path || !response.ok()) return;
    response
      .json()
      .then((body: TripDetailResponse) => bodies.push(body))
      .catch(() => undefined);
  });
  return bodies;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Name and value of each row of a table of the page; a cell shown as "(empty)" reads as "". */
export async function readKeyValues(page: Page, card: string): Promise<Record<string, string>> {
  return page.evaluate((selector) => {
    const entries = [...document.querySelectorAll<HTMLElement>(`${selector} tr[data-key]`)].map(
      (row): [string, string] => {
        const value = row.querySelector<HTMLElement>('[data-slot=value]')!.innerText.trim();
        return [row.dataset.key!, value === '(empty)' ? '' : value];
      },
    );
    return Object.fromEntries(entries);
  }, `[data-card=${card}]`);
}

export interface FrequencyRowView {
  columns: Record<string, string>;
  fields: Record<string, string>;
  readable: boolean;
}

export async function readFrequencies(page: Page): Promise<FrequencyRowView[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-card=frequencies] tbody tr')].map((row) => {
      const text = (cell: Element) => cell.textContent!.replace(/\s+/g, ' ').trim();
      const read = (attribute: string) =>
        Object.fromEntries(
          [...row.querySelectorAll<HTMLElement>(`[${attribute}]`)].map((cell) => [
            cell.getAttribute(attribute)!,
            text(cell) === '(empty)' ? '' : text(cell),
          ]),
        );
      return {
        columns: read('data-column'),
        fields: read('data-field'),
        readable: row.dataset.readable === 'true',
      };
    }),
  );
}

/** What the map shows: the line it was given, and its markers by number. */
export interface MapView {
  shapePoints: number;
  shapeFirst: string | null;
  shapeLast: string | null;
  styleLoaded: boolean;
  markers: { sequence: number; label: string; selected: boolean; x: number; y: number }[];
  box: { x: number; y: number; width: number; height: number };
}

export async function readMap(page: Page): Promise<MapView> {
  return page.evaluate(() => {
    const map = document.querySelector<HTMLElement>('[data-map]')!;
    const box = map.getBoundingClientRect();
    return {
      shapePoints: Number(map.dataset.shapePoints),
      shapeFirst: map.dataset.shapeFirst ?? null,
      shapeLast: map.dataset.shapeLast ?? null,
      styleLoaded: map.dataset.styleLoaded === 'true',
      markers: [...map.querySelectorAll<HTMLElement>('button[data-sequence]')].map((marker) => {
        const rect = marker.getBoundingClientRect();
        return {
          sequence: Number(marker.dataset.sequence),
          label: marker.textContent!.trim(),
          selected: marker.dataset.selected === 'true',
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        };
      }),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
  });
}

export interface PingRowView {
  sequence: number;
  time: string;
  vehicle: string;
  selected: boolean;
  fields: Record<string, string>;
  inView: boolean;
}

export async function readPings(page: Page): Promise<{ heading: string; rows: PingRowView[] }> {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-card=pings]')!;
    const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
    return {
      heading: collapse(card.querySelector('h2')!.textContent!),
      rows: [...card.querySelectorAll<HTMLElement>('li[data-sequence]')].map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          sequence: Number(row.dataset.sequence),
          time: collapse(row.querySelector('[data-slot=time]')!.textContent!),
          vehicle: collapse(row.querySelector('[data-slot=vehicle]')!.textContent!),
          selected: row.dataset.selected === 'true',
          fields: Object.fromEntries(
            [...row.querySelectorAll<HTMLElement>('[data-field]')].map((field) => [
              field.dataset.field!,
              collapse(field.querySelector('dd')!.textContent!),
            ]),
          ),
          inView: rect.top >= 0 && rect.bottom <= window.innerHeight,
        };
      }),
    };
  });
}

export { collapse };

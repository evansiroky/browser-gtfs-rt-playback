import { agencyInstant, scenario, type Scenario } from '@gtfs-rt-debugger/fixtures';
import { describe, it } from 'vitest';
import { LoadGuard } from '../schedule/guard.js';
import { MemoryBudget } from '../schedule/memory.js';
import { parseSchedule } from '../schedule/parse.js';
import { chunked } from '../test-support/zip.js';
import { expectScenario } from '../test-support/expected-rows.js';
import { harness } from '../test-support/trips.js';
import { decodeFeed } from '../realtime/snapshot-store.js';
import { silentLogger } from '../test-support/logger.js';

const TIMEZONE = 'America/Los_Angeles';

async function engineFor(sc: Scenario) {
  const store = await parseSchedule(
    chunked(sc.scheduleZip),
    new MemoryBudget(1 << 30),
    LoadGuard.unlimited(new AbortController().signal),
    silentLogger,
  );
  const h = harness({ now: sc.now, store });
  h.snapshots.add('vehiclePositions', sc.vehiclePositions, decodeFeed(sc.vehiclePositions));
  h.snapshots.add('tripUpdates', sc.tripUpdates, decodeFeed(sc.tripUpdates));
  return h;
}

/** Everything the scenario's `expected` says, against what the engine reports. */
async function expectToMatch(sc: Scenario, label: string): Promise<void> {
  const { engine } = await engineFor(sc);
  await expectScenario(sc, engine, label);
}

const at = (date: string, hms: string, options = {}) =>
  scenario(agencyInstant(date, hms, TIMEZONE), options);

describe('the fixture scenario: engine output equals the ground truth', () => {
  it.each([
    ['midday', '20261014', '12:07:42'],
    [
      'just after midnight (yesterday is the service date of the overnight trips)',
      '20261014',
      '00:20:00',
    ],
    ['the first second of the day', '20261014', '00:00:00'],
    ['the last minute of the day', '20261014', '23:59:30'],
    ['evening, when the 23:10 instance is active', '20261014', '23:15:10'],
    ['01:45, after the overnight trips ended', '20261014', '01:45:00'],
    ['a Saturday', '20261017', '09:30:00'],
  ] as const)('%s', async (label, date, hms) => {
    await expectToMatch(at(date, hms), label);
  });

  it('without the configuration errors', async () => {
    await expectToMatch(at('20261014', '12:07:42', { includeMisconfiguredTrip: false }), 'clean');
  });

  describe('daylight-saving changes (America/Los_Angeles)', () => {
    // GTFS times count from noon minus 12 h: the service day of 2026-03-08 starts at 23:00 PST
    // the evening before (a 23-hour day), and that of 2026-11-01 at 01:00 PDT (a 25-hour day).
    it.each([
      ['spring forward, just after midnight', '20260308', '00:20:00'],
      ['spring forward, 01:59 before the gap', '20260308', '01:59:30'],
      ['spring forward, 03:00 after the gap', '20260308', '03:00:30'],
      ['spring forward, midday', '20260308', '12:07:42'],
      ['spring forward, the evening before', '20260307', '23:30:00'],
      ['spring forward, the day after, just after midnight', '20260309', '00:20:00'],
      ['fall back, just after midnight (before the service day starts)', '20261101', '00:20:00'],
      ['fall back, the second after midnight', '20261101', '00:00:30'],
      ['fall back, midday', '20261101', '12:07:42'],
      ['fall back, the day after, just after midnight', '20261102', '00:20:00'],
    ] as const)('%s', async (label, date, hms) => {
      await expectToMatch(at(date, hms), label);
    });

    it.each([
      // 01:15 happens twice on 2026-11-01: first as PDT (08:15Z), then as PST (09:15Z)
      ['fall back, 01:15 PDT (first)', '2026-11-01T08:15:00Z'],
      ['fall back, 01:15 PST (second)', '2026-11-01T09:15:00Z'],
      ['fall back, 00:59 PDT, a minute before the service day starts', '2026-11-01T07:59:30Z'],
      ['fall back, 01:00 PDT, the service day starts', '2026-11-01T08:00:00Z'],
      ['spring forward, 23:00 PST, the service day starts', '2026-03-08T07:00:00Z'],
      ['spring forward, 01:59 PST', '2026-03-08T09:59:30Z'],
      ['spring forward, 03:00 PDT', '2026-03-08T10:00:00Z'],
    ] as const)('%s', async (label, iso) => {
      await expectToMatch(scenario(new Date(iso)), label);
    });
  });

  it('agrees at one instant a minute across the whole of both transition days', async () => {
    // every 53 minutes from 36 h before to 36 h after each change, in UTC
    const changes = ['2026-03-08T10:00:00Z', '2026-11-01T09:00:00Z'];
    for (const change of changes) {
      const base = Date.parse(change);
      for (let offset = -36 * 60; offset <= 36 * 60; offset += 53) {
        const now = new Date(base + offset * 60_000);
        await expectToMatch(scenario(now), now.toISOString());
      }
    }
  }, 120_000);
});

import { describe, expect, it } from 'vitest';
import { chunked, miniSchedule, zipOf } from '../test-support/zip.js';
import { readCsv } from './csv.js';
import { LoadGuard } from './guard.js';
import { MemoryBudget } from './memory.js';
import { parseSchedule } from './parse.js';
import { ZipArchive } from './zip.js';
import { silentLogger } from '../test-support/logger.js';

const MiB = 1024 * 1024;

function guardWith(options: Partial<ConstructorParameters<typeof LoadGuard>[0]> = {}) {
  return new LoadGuard({
    signal: new AbortController().signal,
    maxDecompressedBytes: Infinity,
    deadlineAt: Infinity,
    now: () => 0,
    ...options,
  });
}

async function openFile(content: string) {
  return ZipArchive.open(chunked(zipOf({ 'f.txt': content })), new Set(['f.txt']));
}

/** Reads every row; returns how many came out and the error, if any. */
async function drain(content: string, guard: LoadGuard, onRow?: (rows: number) => void) {
  const archive = await openFile(content);
  let rows = 0;
  try {
    for await (const row of readCsv(archive, 'f.txt', [], guard, silentLogger)) {
      void row;
      onRow?.(++rows);
    }
    return { rows, error: null as { code: string } | null };
  } catch (error) {
    return { rows, error: error as { code: string } };
  } finally {
    archive.close();
  }
}

describe('decompressed size cap', () => {
  it('stops a file that inflates past the cap with too_large, long before its end', async () => {
    const bomb = 'a\n' + 'x\n'.repeat(8 * MiB); // 16 MiB inflated, a few KiB compressed
    const guard = guardWith({ maxDecompressedBytes: 1 * MiB });
    const { rows, error } = await drain(bomb, guard);
    expect(error?.code).toBe('too_large');
    expect(guard.bytes).toBeLessThan(2 * MiB);
    expect(rows).toBeLessThan(MiB);
  });

  it('counts a file of blank lines, which yields no rows at all', async () => {
    const guard = guardWith({ maxDecompressedBytes: 1 * MiB });
    const { rows, error } = await drain('a\n' + '\n'.repeat(32 * MiB), guard);
    expect(rows).toBe(0);
    expect(error?.code).toBe('too_large');
    expect(guard.bytes).toBeLessThan(2 * MiB);
  });

  it('counts the bytes of every file together', async () => {
    const files = miniSchedule({
      'trips.txt': 'route_id,service_id,trip_id\n' + 'R1,WK,T1\n'.repeat(50_000),
    });
    const bytes = zipOf(files);
    const total = Object.values(files).reduce((sum, text) => sum + text.length, 0);
    const budget = () => new MemoryBudget(1 << 30);
    await expect(
      parseSchedule(
        chunked(bytes),
        budget(),
        guardWith({ maxDecompressedBytes: total }),
        silentLogger,
      ),
    ).resolves.toBeDefined();
    await expect(
      parseSchedule(
        chunked(bytes),
        budget(),
        guardWith({ maxDecompressedBytes: total - 1 }),
        silentLogger,
      ),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('does not count files that are not read', async () => {
    const files = miniSchedule({ 'stops.txt': 'x'.repeat(4 * MiB) });
    const guard = guardWith({ maxDecompressedBytes: 1 * MiB });
    await expect(
      parseSchedule(chunked(zipOf(files)), new MemoryBudget(1 << 30), guard, silentLogger),
    ).resolves.toBeDefined();
  });
});

describe('abort', () => {
  it('stops reading a file of blank lines promptly instead of inflating all of it', async () => {
    const controller = new AbortController();
    const guard = guardWith({ signal: controller.signal });
    const content = 'a\n' + '\n'.repeat(64 * MiB);
    setImmediate(() => controller.abort());
    const { rows, error } = await drain(content, guard);
    expect(error?.code).toBe('aborted');
    expect(rows).toBe(0);
    expect(guard.bytes).toBeLessThan(32 * MiB);
  });

  it('stops a parse in progress', async () => {
    const controller = new AbortController();
    const guard = guardWith({ signal: controller.signal });
    const files = miniSchedule({
      'trips.txt': 'route_id,service_id,trip_id\n' + '\n'.repeat(64 * MiB),
    });
    const run = parseSchedule(
      chunked(zipOf(files)),
      new MemoryBudget(1 << 30),
      guard,
      silentLogger,
    );
    setImmediate(() => controller.abort());
    await expect(run).rejects.toMatchObject({ code: 'aborted' });
    expect(guard.bytes).toBeLessThan(32 * MiB);
  });
});

describe('deadline', () => {
  it('fails with timeout once the deadline passes between rows', async () => {
    let now = 0;
    const guard = guardWith({ deadlineAt: 1000, now: () => now });
    const { rows, error } = await drain('a\n' + '1\n'.repeat(100_000), guard, (seen) => {
      if (seen === 1) now = 2000;
    });
    expect(error?.code).toBe('timeout');
    expect(rows).toBeLessThan(1000);
  });

  it('fails with timeout while reading a file that yields no rows', async () => {
    const guard: LoadGuard = guardWith({
      deadlineAt: 1000,
      now: () => (guard.bytes > 0 ? 2000 : 0),
    });
    const { rows, error } = await drain('a\n' + '\n'.repeat(32 * MiB), guard);
    expect(rows).toBe(0);
    expect(error?.code).toBe('timeout');
    expect(guard.bytes).toBeLessThan(2 * MiB);
  });

  it('does not fail before the deadline', async () => {
    const { error } = await drain('a\n1\n2\n', guardWith({ deadlineAt: 1000, now: () => 1000 }));
    expect(error).toBeNull();
  });
});

describe('frequencies.txt with very many rows', () => {
  it('is read in linear time', async () => {
    const rows = Array.from({ length: 60_000 }, (_, i) => `T1,06:00:00,07:00:00,${600 + i},`);
    const files = miniSchedule({
      'frequencies.txt':
        'trip_id,start_time,end_time,headway_secs,exact_times\n' + rows.join('\n') + '\n',
    });
    const started = performance.now();
    const store = await parseSchedule(
      chunked(zipOf(files)),
      new MemoryBudget(1 << 30),
      guardWith(),
      silentLogger,
    );
    expect(store.frequencies('T1')).toHaveLength(60_000);
    // Copying the array per row took over 20 s for this size; linear takes well under a second.
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 20_000);
});

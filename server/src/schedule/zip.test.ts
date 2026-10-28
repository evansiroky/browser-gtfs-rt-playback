import { Zip, ZipDeflate, ZipPassThrough, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { chunked, miniSchedule, zipOf } from '../test-support/zip.js';
import { LoadGuard } from './guard.js';
import { MemoryBudget } from './memory.js';
import { parseSchedule } from './parse.js';
import { ZipArchive } from './zip.js';
import { silentLogger } from '../test-support/logger.js';

const guard = LoadGuard.unlimited(new AbortController().signal);

async function text(archive: ZipArchive, name: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await archive.stream(name)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** A zip written the way streaming writers (Java's ZipOutputStream, fflate's Zip) do: sizes in data descriptors. */
function streamingZip(files: Record<string, string>, stored: boolean): Uint8Array {
  const parts: Uint8Array[] = [];
  const zip = new Zip((error, data) => {
    if (error) throw error;
    parts.push(data);
  });
  for (const [name, content] of Object.entries(files)) {
    const entry = stored ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(strToU8(content), true);
  }
  zip.end();
  return Buffer.concat(parts);
}

describe('ZipArchive', () => {
  it('reads entries whatever the chunking of the body, down to single bytes', async () => {
    const bytes = zipOf({ 'a.txt': 'hello '.repeat(100), 'b.txt': 'world' });
    for (const size of [1, 7, 64, bytes.byteLength]) {
      const archive = await ZipArchive.open(chunked(bytes, size), new Set(['a.txt', 'b.txt']));
      expect(await text(archive, 'a.txt'), `chunks of ${size}`).toBe('hello '.repeat(100));
      expect(await text(archive, 'b.txt')).toBe('world');
      archive.close();
    }
  });

  it.each([
    ['deflated', false],
    ['stored', true],
  ])('reads %s entries written with data descriptors', async (_label, stored) => {
    const files = miniSchedule();
    const store = await parseSchedule(
      chunked(streamingZip(files, stored), 4096),
      new MemoryBudget(1 << 30),
      guard,
      silentLogger,
    );
    expect(store.counts()).toMatchObject({ trips: 1, routes: 1, shapes: 1 });
    expect(store.template('T1')).toEqual({ startSecs: 28_800, endSecs: 30_600 });
  });

  it('indexes only the wanted top-level files, never folders or their content', async () => {
    const bytes = zipSync({
      'a.txt': strToU8('x'),
      'dir/': new Uint8Array(0),
      'dir/b.txt': strToU8('y'),
    });
    const archive = await ZipArchive.open(chunked(bytes), new Set(['a.txt', 'b.txt']));
    expect(archive.has('a.txt')).toBe(true);
    expect(archive.has('dir/')).toBe(false);
    expect(archive.has('b.txt')).toBe(false);
    expect(archive.has('dir/b.txt')).toBe(false);
    expect(archive.has('junk.bin')).toBe(false);
    archive.close();
  });

  describe('bytes after the archive', () => {
    const files = { 'a.txt': 'hello ' };
    const open = (bytes: Uint8Array, chunkSize?: number) =>
      ZipArchive.open(chunked(bytes, chunkSize), new Set(['a.txt']));

    /** The same archive with a comment, as the end record declares it. */
    function withComment(bytes: Uint8Array, comment: Uint8Array): Uint8Array {
      const out = Buffer.concat([bytes, comment]);
      out.writeUInt16LE(comment.length, bytes.length - 2);
      return out;
    }

    it('ignores the remains of an older end record, as the MST feed has', async () => {
      const bytes = zipOf(files);
      for (const size of [1, 7, undefined]) {
        const archive = await open(Buffer.concat([bytes, bytes.subarray(-16)]), size);
        expect(await text(archive, 'a.txt'), `chunks of ${size}`).toBe('hello ');
        archive.close();
      }
    });

    it('ignores bytes after an archive comment', async () => {
      const bytes = withComment(zipOf(files), Buffer.from('made by hand'));
      const archive = await open(Buffer.concat([bytes, Buffer.from('trailing junk')]));
      expect(await text(archive, 'a.txt')).toBe('hello ');
      archive.close();
    });

    it('still rejects a body whose end record is not within the last 65 557 bytes', async () => {
      const bytes = Buffer.concat([zipOf(files), Buffer.alloc(65_558)]);
      await expect(open(bytes)).rejects.toMatchObject({ code: 'bad_zip' });
    });

    it('still rejects an archive whose end record is cut short', async () => {
      const bytes = zipOf(files);
      await expect(open(bytes.subarray(0, bytes.length - 10))).rejects.toMatchObject({
        code: 'bad_zip',
      });
    });
  });

  it('only finds the GTFS files at the top level of the archive', async () => {
    const nested = Object.fromEntries(
      Object.entries(miniSchedule()).map(([name, content]) => [`feed/${name}`, content]),
    );
    await expect(
      parseSchedule(chunked(zipOf(nested)), new MemoryBudget(1 << 30), guard, silentLogger),
    ).rejects.toMatchObject({ code: 'missing_file' });
  });
});

import { describe, expect, it } from 'vitest';
import { readCsv } from './csv.js';
import { LoadGuard } from './guard.js';
import { ScheduleLoadError } from './errors.js';
import { ZipArchive } from './zip.js';
import { chunked, zipOf } from '../test-support/zip.js';

const guard = LoadGuard.unlimited(new AbortController().signal);
const FILES = new Set(['f.txt']);

async function rows(content: string | Uint8Array, required: string[] = []) {
  const archive = await ZipArchive.open(chunked(zipOf({ 'f.txt': content }), 64), FILES);
  try {
    const out = [];
    for await (const row of readCsv(archive, 'f.txt', required, guard)) out.push(row);
    return out;
  } finally {
    archive.close();
  }
}

async function failure(content: string | Uint8Array, required: string[] = []) {
  const error = await rows(content, required).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ScheduleLoadError);
  return error as ScheduleLoadError;
}

describe('readCsv', () => {
  it('reads rows keyed by column name', async () => {
    expect(await rows('a,b\n1,2\n3,4\n')).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('strips a UTF-8 byte-order mark from the first column name', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a,b\n1,2\n')]);
    expect(await rows(bytes, ['a'])).toEqual([{ a: '1', b: '2' }]);
  });

  it('reads CRLF line endings, a missing final newline and blank lines', async () => {
    expect(await rows('a,b\r\n1,2\r\n\r\n3,4')).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('reads quoted fields with commas, newlines and doubled quotes', async () => {
    const text = 'a,b,c\n"x, y","line1\nline2","say ""hi"""\n';
    expect(await rows(text)).toEqual([{ a: 'x, y', b: 'line1\nline2', c: 'say "hi"' }]);
  });

  it('keeps multi-byte characters and empty values as written', async () => {
    expect(await rows('a,b\nÅngström 東京,\n')).toEqual([{ a: 'Ångström 東京', b: '' }]);
  });

  it('tolerates short rows, extra fields, a stray quote and unnamed columns', async () => {
    expect(await rows(' a , b ,,c\n1\n1,2,3,4,5\nx"y,2,3,4\n')).toEqual([
      { a: '1' },
      { a: '1', b: '2', c: '4' },
      { a: 'x"y', b: '2', c: '4' },
    ]);
  });

  it('is empty for an empty file and for a header only', async () => {
    expect(await rows('')).toEqual([]);
    expect(await rows('a,b\n', ['a'])).toEqual([]);
  });

  it('rejects a header without a required column, naming the file', async () => {
    const error = await failure('a,b\n1,2\n', ['a', 'z']);
    expect(error.code).toBe('invalid_schedule');
    expect(error.message).toContain('f.txt');
    expect(error.message).toContain('z');
  });

  it('rejects a quote that is never closed as bad_csv', async () => {
    const error = await failure('a,b\n"open,2\n3,4\n');
    expect(error.code).toBe('bad_csv');
    expect(error.message).toContain('f.txt');
  });

  it('rejects a record larger than the limit as bad_csv', async () => {
    const error = await failure(`a\n"${'x'.repeat(2 * 1024 * 1024)}"\n`);
    expect(error.code).toBe('bad_csv');
  });

  it('stops once the signal aborts', async () => {
    const controller = new AbortController();
    const archive = await ZipArchive.open(chunked(zipOf({ 'f.txt': 'a\n1\n2\n3\n' })), FILES);
    const seen: string[] = [];
    const run = async () => {
      for await (const row of readCsv(
        archive,
        'f.txt',
        [],
        new LoadGuard({
          signal: controller.signal,
          maxDecompressedBytes: Infinity,
          deadlineAt: Infinity,
          now: () => 0,
        }),
      )) {
        seen.push(row['a']!);
        controller.abort();
      }
    };
    await expect(run()).rejects.toMatchObject({ code: 'aborted' });
    expect(seen).toEqual(['1']);
    archive.close();
  });
});

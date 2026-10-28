import { Transform } from 'node:stream';
import { CsvError, parse } from 'csv-parse';
import type { ZipArchive } from './zip.js';
import { ScheduleLoadError } from './errors.js';
import type { LoadGuard } from './guard.js';
import type { Row } from './store.js';

/** The deadline and abort are checked at least this often, in rows. */
const CHECK_EVERY_ROWS = 256;

/** A single record larger than this (e.g. a quote that is never closed) is a bad CSV file. */
const MAX_RECORD_BYTES = 1024 * 1024;

/**
 * Streams the rows of a CSV file in the zip as objects keyed by column name, one at a time:
 * RFC 4180 quoting (commas, newlines and doubled quotes inside quoted fields), CRLF or LF line
 * endings, a UTF-8 byte-order mark, blank lines skipped. A row with fewer fields than the header
 * lacks the missing columns; extra fields are ignored. Column names are trimmed.
 *
 * Throws `bad_csv` (malformed file, or a header without one of the `required` columns is
 * `invalid_schedule`), `bad_zip` (the entry cannot be decompressed), `too_large` (the load
 * has inflated more than the guard allows), `timeout` (past the guard's deadline) or `aborted`
 * (the guard's signal). Limits are enforced on the inflated bytes as they stream, not only per
 * row, so a file of blank lines cannot outrun them. The messages name the file, never the feed.
 */
export async function* readCsv(
  archive: ZipArchive,
  file: string,
  required: readonly string[],
  guard: LoadGuard,
): AsyncGenerator<Row, void, undefined> {
  guard.check();
  const source = await archive.stream(file);
  const parser = parse({
    bom: true,
    columns: (header: string[]) => {
      const names = header.map((name) => name.trim());
      const missing = required.filter((column) => !names.includes(column));
      if (missing.length > 0) {
        throw new ScheduleLoadError(
          'invalid_schedule',
          `${file} has no ${missing.join(', ')} column.`,
        );
      }
      return names.map((name) => name || false);
    },
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    max_record_size: MAX_RECORD_BYTES,
  });
  const limits = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        guard.count(chunk.length);
        guard.check();
        done(null, chunk);
      } catch (error) {
        done(error as Error);
      }
    },
  });
  const onAbort = () => parser.destroy(new ScheduleLoadError('aborted', 'The load was abandoned.'));
  guard.signal.addEventListener('abort', onAbort, { once: true });
  source.on('error', () =>
    limits.destroy(new ScheduleLoadError('bad_zip', `${file} cannot be read from the zip.`)),
  );
  limits.on('error', (error) => parser.destroy(error));
  source.pipe(limits).pipe(parser);
  try {
    let rows = 0;
    for await (const row of parser) {
      if (++rows % CHECK_EVERY_ROWS === 0) guard.check();
      yield row as Row;
    }
    guard.check();
  } catch (error) {
    if (error instanceof ScheduleLoadError) throw error;
    if (error instanceof CsvError) {
      throw new ScheduleLoadError('bad_csv', `${file} is not valid CSV (${error.code}).`);
    }
    throw new ScheduleLoadError('bad_zip', `${file} cannot be read from the zip.`);
  } finally {
    guard.signal.removeEventListener('abort', onAbort);
    source.destroy();
    limits.destroy();
    parser.destroy();
  }
}

import { CsvError, parse } from 'csv-parse';
import type { ZipArchive } from './zip.js';
import { ScheduleLoadError } from './errors.js';
import type { Row } from './store.js';

/** A single record larger than this (e.g. a quote that is never closed) is a bad CSV file. */
const MAX_RECORD_BYTES = 1024 * 1024;

/**
 * Streams the rows of a CSV file in the zip as objects keyed by column name, one at a time:
 * RFC 4180 quoting (commas, newlines and doubled quotes inside quoted fields), CRLF or LF line
 * endings, a UTF-8 byte-order mark, blank lines skipped. A row with fewer fields than the header
 * lacks the missing columns; extra fields are ignored. Column names are trimmed.
 *
 * Throws `bad_csv` (malformed file, or a header without one of the `required` columns is
 * `invalid_schedule`), `bad_zip` (the entry cannot be decompressed) or `aborted` once `signal`
 * is aborted. The messages name the file, never the feed.
 */
export async function* readCsv(
  archive: ZipArchive,
  file: string,
  required: readonly string[],
  signal: AbortSignal,
): AsyncGenerator<Row, void, undefined> {
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
  source.on('error', () =>
    parser.destroy(new ScheduleLoadError('bad_zip', `${file} cannot be read from the zip.`)),
  );
  source.pipe(parser);
  try {
    for await (const row of parser) {
      if (signal.aborted) throw new ScheduleLoadError('aborted', 'The load was abandoned.');
      yield row as Row;
    }
  } catch (error) {
    if (error instanceof ScheduleLoadError) throw error;
    if (error instanceof CsvError) {
      throw new ScheduleLoadError('bad_csv', `${file} is not valid CSV (${error.code}).`);
    }
    throw new ScheduleLoadError('bad_zip', `${file} cannot be read from the zip.`);
  } finally {
    source.destroy();
    parser.destroy();
  }
}

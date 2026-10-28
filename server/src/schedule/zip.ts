import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { ChunkedBody } from './download.js';
import { ScheduleLoadError } from './errors.js';

/** An archive with more entries than this is not a GTFS feed. */
const MAX_ENTRIES = 10_000;
const BAD_ZIP = 'The schedule is not a readable zip archive.';

/** Lets yauzl read ranges of a chunked body, so the archive is never copied into one buffer. */
class ChunkedReader extends yauzl.RandomAccessReader {
  readonly #body: ChunkedBody;

  constructor(body: ChunkedBody) {
    super();
    this.#body = body;
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const slices: Buffer[] = [];
    let offset = 0;
    for (const chunk of this.#body.chunks) {
      const chunkEnd = offset + chunk.byteLength;
      if (chunkEnd > start && offset < end) {
        const from = Math.max(start - offset, 0);
        const to = Math.min(end - offset, chunk.byteLength);
        slices.push(Buffer.from(chunk.buffer, chunk.byteOffset + from, to - from));
      }
      offset = chunkEnd;
      if (offset >= end) break;
    }
    return Readable.from(slices, { objectMode: false });
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
/** The end record sits within its fixed part plus the longest comment (65 535 bytes) of the end. */
const MAX_TAIL = EOCD_SIZE + 0xffff;

/** The last `length` bytes of the body, copied. */
function tailOf({ chunks, size }: ChunkedBody, length: number): Buffer {
  const start = Math.max(size - length, 0);
  const parts: Buffer[] = [];
  let end = size;
  for (let i = chunks.length - 1; i >= 0 && end > start; i--) {
    const chunk = chunks[i];
    if (!chunk) break;
    const from = Math.max(start - (end - chunk.byteLength), 0);
    parts.unshift(Buffer.from(chunk.buffer, chunk.byteOffset + from, chunk.byteLength - from));
    end -= chunk.byteLength;
  }
  return Buffer.concat(parts);
}

/**
 * Where the archive ends: after its last end-of-central-directory record and that record's
 * comment, so bytes some writers leave behind are ignored (feed-ingest.md "Schedule"). A record
 * that ends exactly at the end of the body means there are no such bytes, and wins over a later
 * signature that merely fits. Without a record the body is returned as it is.
 * Tolerating trailing bytes lets a file show this reader different contents than a reader that
 * picks another record, which is acceptable only while the operator chooses the feed URLs.
 */
function archiveSize(body: ChunkedBody): number {
  const tail = tailOf(body, MAX_TAIL);
  let size = body.size;
  let found = false;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    const end = i + EOCD_SIZE + tail.readUInt16LE(i + 20);
    if (end === tail.length) return body.size;
    if (end < tail.length && !found) {
      size = body.size - tail.length + end;
      found = true;
    }
  }
  return size;
}

function open(body: ChunkedBody): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromRandomAccessReader(
      new ChunkedReader(body),
      archiveSize(body),
      { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true },
      (error, zipfile) =>
        error || !zipfile ? reject(new ScheduleLoadError('bad_zip', BAD_ZIP)) : resolve(zipfile),
    );
  });
}

/** Walks the central directory, keeping only the entries named in `wanted` (the first of a name). */
function readEntries(
  zipfile: yauzl.ZipFile,
  wanted: ReadonlySet<string>,
): Promise<Map<string, yauzl.Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, yauzl.Entry>();
    if (zipfile.entryCount > MAX_ENTRIES) {
      reject(new ScheduleLoadError('bad_zip', BAD_ZIP));
      return;
    }
    zipfile.on('entry', (entry: yauzl.Entry) => {
      if (wanted.has(entry.fileName) && !entries.has(entry.fileName)) {
        entries.set(entry.fileName, entry);
      }
      zipfile.readEntry();
    });
    zipfile.on('end', () => resolve(entries));
    zipfile.on('error', () => reject(new ScheduleLoadError('bad_zip', BAD_ZIP)));
    zipfile.readEntry();
  });
}

/** A zip archive held as its (chunked) bytes; entries are decompressed on demand, as streams. */
export class ZipArchive {
  readonly #zipfile: yauzl.ZipFile;
  readonly #entries: Map<string, yauzl.Entry>;

  private constructor(zipfile: yauzl.ZipFile, entries: Map<string, yauzl.Entry>) {
    this.#zipfile = zipfile;
    this.#entries = entries;
  }

  /**
   * Throws `bad_zip` for anything that is not a readable archive, or has more than
   * {@link MAX_ENTRIES} entries. Only the top-level files named in `wanted` are indexed.
   */
  static async open(body: ChunkedBody, wanted: ReadonlySet<string>): Promise<ZipArchive> {
    const zipfile = await open(body);
    try {
      return new ZipArchive(zipfile, await readEntries(zipfile, wanted));
    } catch (error) {
      zipfile.close();
      throw error;
    }
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** The decompressed content of a top-level file. Stream errors are not mapped; see `readCsv`. */
  stream(name: string): Promise<Readable> {
    const entry = this.#entries.get(name);
    if (!entry) return Promise.reject(new ScheduleLoadError('missing_file', `${name} is missing.`));
    return new Promise((resolve, reject) => {
      this.#zipfile.openReadStream(entry, (error, stream) =>
        error || !stream
          ? reject(new ScheduleLoadError('bad_zip', `${name} cannot be read from the zip.`))
          : resolve(stream),
      );
    });
  }

  close(): void {
    this.#zipfile.close();
  }
}

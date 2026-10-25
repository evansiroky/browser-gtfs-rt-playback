import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { ChunkedBody } from './download.js';
import { ScheduleLoadError } from './errors.js';

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

function open(body: ChunkedBody): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromRandomAccessReader(
      new ChunkedReader(body),
      body.size,
      { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true },
      (error, zipfile) =>
        error || !zipfile ? reject(new ScheduleLoadError('bad_zip', BAD_ZIP)) : resolve(zipfile),
    );
  });
}

function readEntries(zipfile: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, yauzl.Entry>();
    zipfile.on('entry', (entry: yauzl.Entry) => {
      if (!entry.fileName.endsWith('/') && !entries.has(entry.fileName)) {
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

  /** Throws `bad_zip` for anything that is not a readable archive. */
  static async open(body: ChunkedBody): Promise<ZipArchive> {
    const zipfile = await open(body);
    try {
      return new ZipArchive(zipfile, await readEntries(zipfile));
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

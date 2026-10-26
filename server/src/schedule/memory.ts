import { ScheduleLoadError } from './errors.js';

/**
 * The schedule memory limit (feed-ingest.md): a running estimate of the bytes the load holds,
 * transient buffers included. The numbers are estimates of V8's heap use (see `bench-schedule`
 * in the server README for how they compare with a measurement); exceeding the limit aborts the
 * load with `too_large`.
 */
export class MemoryBudget {
  readonly #limit: number;
  #used = 0;

  constructor(limitBytes: number) {
    this.#limit = limitBytes;
  }

  get used(): number {
    return this.#used;
  }

  add(bytes: number): void {
    this.#used += bytes;
    if (this.#used > this.#limit) {
      throw new ScheduleLoadError(
        'too_large',
        `The decoded schedule exceeds the memory limit of ${this.#limit} bytes.`,
      );
    }
  }

  release(bytes: number): void {
    this.#used -= bytes;
  }
}

const NOT_LATIN1 = /[\u0100-\uffff]/;

/** Heap estimate for a string: header plus one byte per character, two if it has any beyond Latin-1. */
export function stringBytes(value: string): number {
  return 24 + (NOT_LATIN1.test(value) ? 2 : 1) * value.length;
}

/** Heap estimate for a parsed CSV row: the object and its values (the keys are shared). */
export function rowBytes(row: Readonly<Record<string, string>>): number {
  let bytes = 64;
  for (const key in row) bytes += 8 + stringBytes(row[key] ?? '');
  return bytes;
}

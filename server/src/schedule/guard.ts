import { ScheduleLoadError } from './errors.js';

export interface LoadGuardOptions {
  /** Aborted by `discard()`. */
  signal: AbortSignal;
  /** Cap on the bytes inflated from the archive over the whole load (a zip bomb stops here). */
  maxDecompressedBytes: number;
  /** Instant (epoch ms, as `now()` reads it) after which reading fails with `timeout`. */
  deadlineAt: number;
  now: () => number;
}

/**
 * The limits of reading the archive, checked as bytes are inflated and as rows are read, so a
 * file that is enormous but yields few or no rows (a zip bomb, millions of blank lines) still
 * stops at the limit, at the deadline, or promptly on abort. Download size and memory have
 * their own limits ({@link MemoryBudget}, `boundedFetch`).
 */
export class LoadGuard {
  readonly signal: AbortSignal;
  readonly #options: LoadGuardOptions;
  #bytes = 0;

  constructor(options: LoadGuardOptions) {
    this.signal = options.signal;
    this.#options = options;
  }

  /** No byte cap and no deadline; only the signal applies. */
  static unlimited(signal: AbortSignal): LoadGuard {
    return new LoadGuard({
      signal,
      maxDecompressedBytes: Number.POSITIVE_INFINITY,
      deadlineAt: Number.POSITIVE_INFINITY,
      now: () => 0,
    });
  }

  /** Decompressed bytes counted so far. */
  get bytes(): number {
    return this.#bytes;
  }

  /** The guard's clock, for timing the work it limits. */
  now(): number {
    return this.#options.now();
  }

  /** Throws `aborted` once the signal aborts, `timeout` once the deadline has passed. */
  check(): void {
    if (this.signal.aborted) throw new ScheduleLoadError('aborted', 'The load was abandoned.');
    if (this.#options.now() > this.#options.deadlineAt) {
      throw new ScheduleLoadError('timeout', 'The schedule could not be read in time.');
    }
  }

  /** Counts inflated bytes; throws `too_large` over the cap. */
  count(bytes: number): void {
    this.#bytes += bytes;
    if (this.#bytes > this.#options.maxDecompressedBytes) {
      throw new ScheduleLoadError(
        'too_large',
        `The schedule expands to more than ${this.#options.maxDecompressedBytes} bytes.`,
      );
    }
  }
}

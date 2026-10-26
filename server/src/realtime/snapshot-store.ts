import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from '../clock.js';
import { runHook } from '../hooks.js';

export const { transit_realtime } = GtfsRealtimeBindings;
export type FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;

export type FeedKind = 'vehiclePositions' | 'tripUpdates';
export const FEED_KINDS: readonly FeedKind[] = ['vehiclePositions', 'tripUpdates'];

/**
 * One successful fetch of one realtime feed (data-model.md "Realtime snapshot"), kept compact as
 * the raw protobuf bytes and decoded on demand.
 */
export interface Snapshot {
  readonly feed: FeedKind;
  /** Server receive time, epoch milliseconds. */
  readonly receivedAt: number;
  /** The feed header `timestamp`, epoch **seconds** as sent; null when the header has none. */
  readonly feedTimestamp: number | null;
  /** The response body exactly as received (after gzip decoding). */
  readonly bytes: Uint8Array;
  /** Decodes {@link bytes} afresh on every call. */
  decode(): FeedMessage;
}

export type EvictReason = 'retention' | 'memory';

export type SnapshotListener = (snapshot: Snapshot, message: FeedMessage) => void;
export type EvictListener = (snapshot: Snapshot, reason: EvictReason) => void;
export type ClearListener = () => void;

/** Throws when `bytes` is not a decodable GTFS-RT `FeedMessage`. */
export function decodeFeed(bytes: Uint8Array): FeedMessage {
  return transit_realtime.FeedMessage.decode(bytes);
}

export function headerTimestamp(message: FeedMessage): number | null {
  if (!Object.hasOwn(message.header, 'timestamp')) return null;
  const value = message.header.timestamp;
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : value.toNumber();
}

/**
 * Built outside {@link SnapshotStore.add} on purpose: a closure shares its scope with every other
 * closure created there, so `decode` must not be created next to one that captures the decoded
 * message, or each retained snapshot would keep its decoded message alive.
 */
function createSnapshot(
  feed: FeedKind,
  receivedAt: number,
  feedTimestamp: number | null,
  bytes: Uint8Array,
): Snapshot {
  return { feed, receivedAt, feedTimestamp, bytes, decode: () => decodeFeed(bytes) };
}

export interface SnapshotStoreOptions {
  clock: Clock;
  /** Receives listener failures. */
  logger: FastifyBaseLogger;
  retentionMs: number;
  memoryLimitBytes: number;
}

/**
 * The retained realtime history, per feed, oldest first (data-retention.md "Realtime history").
 *
 * - Snapshots older than the retention window (by receive time) are dropped whenever a snapshot is
 *   added and on every {@link prune} (the pollers call it on every tick).
 * - Total retained bytes are bounded by the memory limit; the oldest snapshots across both feeds
 *   are evicted first, but never a feed's latest snapshot. Memory is approximated by the protobuf
 *   byte length of each snapshot (the decoded form is never retained) plus whatever
 *   {@link reserveMemory} holders report. The configuration
 *   guarantees the limit holds one maximum-size snapshot per feed, so sparing the latest ones
 *   never breaks the limit.
 * - {@link clear} (dormancy) forgets everything.
 *
 * Listeners run synchronously, in registration order, after the store is consistent again (a new
 * snapshot is announced after pruning). A listener that throws is logged and skipped; the store
 * and the other listeners are unaffected. Each `on*` returns an unsubscribe function.
 */
export class SnapshotStore {
  readonly #clock: Clock;
  readonly #logger: FastifyBaseLogger;
  readonly #retentionMs: number;
  readonly #memoryLimitBytes: number;
  readonly #snapshots: Record<FeedKind, Snapshot[]> = { vehiclePositions: [], tripUpdates: [] };
  #bytes = 0;
  readonly #snapshotListeners = new Set<SnapshotListener>();
  readonly #evictListeners = new Set<EvictListener>();
  readonly #clearListeners = new Set<ClearListener>();
  readonly #reservations = new Set<() => number>();

  constructor({ clock, logger, retentionMs, memoryLimitBytes }: SnapshotStoreOptions) {
    this.#clock = clock;
    this.#logger = logger;
    this.#retentionMs = retentionMs;
    this.#memoryLimitBytes = memoryLimitBytes;
  }

  /** Records a successful fetch. `message` is the already-decoded `bytes`, passed to listeners. */
  add(feed: FeedKind, bytes: Uint8Array, message: FeedMessage): Snapshot {
    const snapshot = createSnapshot(feed, this.#clock.now(), headerTimestamp(message), bytes);
    this.#snapshots[feed].push(snapshot);
    this.#bytes += bytes.byteLength;
    this.prune();
    for (const listener of this.#snapshotListeners) {
      runHook(this.#logger, 'onSnapshot', () => listener(snapshot, message));
    }
    return snapshot;
  }

  /** Applies the retention window, then the memory limit. */
  prune(): void {
    const cutoff = this.#clock.now() - this.#retentionMs;
    for (const feed of FEED_KINDS) {
      const list = this.#snapshots[feed];
      while (list[0] && list[0].receivedAt < cutoff) this.#evictFirst(feed, 'retention');
    }
    while (this.#bytes + this.#reservedBytes() > this.#memoryLimitBytes) {
      const oldest = this.#oldestFeed({ spareLatest: true });
      if (!oldest) break;
      this.#evictFirst(oldest, 'memory');
    }
  }

  latest(feed: FeedKind): Snapshot | null {
    return this.#snapshots[feed].at(-1) ?? null;
  }

  /** Oldest first. */
  all(feed: FeedKind): readonly Snapshot[] {
    return [...this.#snapshots[feed]];
  }

  /** Receive time of the oldest retained snapshot of any feed, epoch ms; null when empty. */
  historyStartsAt(): number | null {
    const oldest = this.#oldestFeed();
    return oldest ? (this.#snapshots[oldest][0]?.receivedAt ?? null) : null;
  }

  /** Approximate retained bytes (sum of snapshot byte lengths). */
  retainedBytes(): number {
    return this.#bytes;
  }

  /** Forgets every snapshot. Fires `onClear` listeners (not `onEvict`). */
  clear(): void {
    this.#snapshots.vehiclePositions = [];
    this.#snapshots.tripUpdates = [];
    this.#bytes = 0;
    for (const listener of this.#clearListeners) runHook(this.#logger, 'onClear', listener);
  }

  /**
   * Counts memory that other holders of realtime history (the ping store) keep against the same
   * limit: `bytes` is read on every {@link prune}, and snapshots are evicted, oldest first, while
   * snapshots plus reservations exceed the limit. Returns an unregister function.
   */
  reserveMemory(bytes: () => number): () => void {
    this.#reservations.add(bytes);
    return () => this.#reservations.delete(bytes);
  }

  onSnapshot(listener: SnapshotListener): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  onEvict(listener: EvictListener): () => void {
    this.#evictListeners.add(listener);
    return () => this.#evictListeners.delete(listener);
  }

  onClear(listener: ClearListener): () => void {
    this.#clearListeners.add(listener);
    return () => this.#clearListeners.delete(listener);
  }

  #reservedBytes(): number {
    let total = 0;
    for (const bytes of this.#reservations) total += bytes();
    return total;
  }

  /** The feed holding the oldest snapshot; with `spareLatest`, among feeds with more than one. */
  #oldestFeed({ spareLatest = false } = {}): FeedKind | null {
    let oldest: FeedKind | null = null;
    for (const feed of FEED_KINDS) {
      if (spareLatest && this.#snapshots[feed].length < 2) continue;
      const first = this.#snapshots[feed][0];
      const current = oldest && this.#snapshots[oldest][0];
      if (first && (!current || first.receivedAt < current.receivedAt)) oldest = feed;
    }
    return oldest;
  }

  #evictFirst(feed: FeedKind, reason: EvictReason): void {
    const snapshot = this.#snapshots[feed].shift();
    if (!snapshot) return;
    this.#bytes -= snapshot.bytes.byteLength;
    for (const listener of this.#evictListeners) {
      runHook(this.#logger, 'onEvict', () => listener(snapshot, reason));
    }
  }
}

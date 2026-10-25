import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { Clock } from '../clock.js';

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

export interface SnapshotStoreOptions {
  clock: Clock;
  retentionMs: number;
  memoryLimitBytes: number;
}

/**
 * The retained realtime history, per feed, oldest first (data-retention.md "Realtime history").
 *
 * - Snapshots older than the retention window (by receive time) are dropped whenever a snapshot is
 *   added and on every {@link prune} (the pollers call it on every tick).
 * - Total retained bytes are bounded by the memory limit; the oldest snapshots across both feeds
 *   are evicted first. Memory is approximated by the protobuf byte length of each snapshot (the
 *   decoded form is never retained). The configuration guarantees the limit holds at least one
 *   maximum-size snapshot per feed, so each feed's latest snapshot always survives eviction.
 * - {@link clear} (dormancy) forgets everything.
 *
 * Listeners run synchronously, in registration order. Each `on*` returns an unsubscribe function.
 */
export class SnapshotStore {
  readonly #clock: Clock;
  readonly #retentionMs: number;
  readonly #memoryLimitBytes: number;
  readonly #snapshots: Record<FeedKind, Snapshot[]> = { vehiclePositions: [], tripUpdates: [] };
  #bytes = 0;
  readonly #snapshotListeners = new Set<SnapshotListener>();
  readonly #evictListeners = new Set<EvictListener>();
  readonly #clearListeners = new Set<ClearListener>();

  constructor({ clock, retentionMs, memoryLimitBytes }: SnapshotStoreOptions) {
    this.#clock = clock;
    this.#retentionMs = retentionMs;
    this.#memoryLimitBytes = memoryLimitBytes;
  }

  /** Records a successful fetch. `message` is the already-decoded `bytes`, passed to listeners. */
  add(feed: FeedKind, bytes: Uint8Array, message: FeedMessage): Snapshot {
    const snapshot: Snapshot = {
      feed,
      receivedAt: this.#clock.now(),
      feedTimestamp: headerTimestamp(message),
      bytes,
      decode: () => decodeFeed(bytes),
    };
    this.#snapshots[feed].push(snapshot);
    this.#bytes += bytes.byteLength;
    for (const listener of this.#snapshotListeners) listener(snapshot, message);
    this.prune();
    return snapshot;
  }

  /** Applies the retention window, then the memory limit. */
  prune(): void {
    const cutoff = this.#clock.now() - this.#retentionMs;
    for (const feed of FEED_KINDS) {
      const list = this.#snapshots[feed];
      while (list[0] && list[0].receivedAt < cutoff) this.#evictFirst(feed, 'retention');
    }
    while (this.#bytes > this.#memoryLimitBytes) {
      const oldest = this.#oldestFeed();
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
    for (const listener of this.#clearListeners) listener();
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

  #oldestFeed(): FeedKind | null {
    let oldest: FeedKind | null = null;
    for (const feed of FEED_KINDS) {
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
    for (const listener of this.#evictListeners) listener(snapshot, reason);
  }
}

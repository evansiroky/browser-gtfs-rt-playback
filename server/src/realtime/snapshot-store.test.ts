import { describe, expect, it } from 'vitest';
import { FakeClock } from '../clock.js';
import { encodeFeed } from '../test-support/feeds.js';
import { captureLogger } from '../test-support/logger.js';
import { decodeFeed, SnapshotStore, type FeedKind, type Snapshot } from './snapshot-store.js';

const MINUTE = 60_000;

function setup({ retentionMs = 60 * MINUTE, memoryLimitBytes = 1_000_000 } = {}) {
  const clock = new FakeClock();
  const logs: string[] = [];
  const store = new SnapshotStore({
    clock,
    logger: captureLogger(logs),
    retentionMs,
    memoryLimitBytes,
  });
  const add = (feed: FeedKind, bytes = encodeFeed()) => store.add(feed, bytes, decodeFeed(bytes));
  return { clock, store, add, logs };
}

const message = decodeFeed(encodeFeed());
const failing = () => {
  throw new Error('downstream bug');
};

describe('SnapshotStore', () => {
  it('keeps snapshots per feed in time order with receive time and header timestamp', () => {
    const { clock, store, add } = setup();
    const first = add('vehiclePositions', encodeFeed({ timestamp: 111 }));
    clock.advance(10_000);
    const second = add('vehiclePositions', encodeFeed({ timestamp: 222 }));
    add('tripUpdates', encodeFeed({ timestamp: null }));
    expect(store.all('vehiclePositions')).toEqual([first, second]);
    expect(store.latest('vehiclePositions')).toBe(second);
    expect(second.receivedAt - first.receivedAt).toBe(10_000);
    expect(first.feedTimestamp).toBe(111);
    expect(store.latest('tripUpdates')?.feedTimestamp).toBeNull();
    expect(second.decode().entity).toHaveLength(1);
    expect(store.historyStartsAt()).toBe(first.receivedAt);
  });

  it('prunes by receive time beyond the retention window', () => {
    const { clock, store, add } = setup({ retentionMs: 5 * MINUTE });
    const evicted: string[] = [];
    store.onEvict((snapshot, reason) => evicted.push(`${snapshot.feed}:${reason}`));
    const old = add('vehiclePositions');
    clock.advance(2 * MINUTE);
    const kept = add('tripUpdates');
    clock.advance(3 * MINUTE);
    store.prune(); // exactly at the window edge: kept
    expect(store.latest('vehiclePositions')).toBe(old);
    clock.advance(1);
    store.prune();
    expect(store.latest('vehiclePositions')).toBeNull();
    expect(evicted).toEqual(['vehiclePositions:retention']);
    expect(store.historyStartsAt()).toBe(kept.receivedAt);
    clock.advance(2 * MINUTE);
    add('vehiclePositions'); // adding also prunes
    expect(store.all('tripUpdates')).toEqual([]);
  });

  it('evicts the oldest snapshots across feeds first when over the memory limit', () => {
    const bytes = encodeFeed({ padding: 100 });
    const { clock, store, add } = setup({ memoryLimitBytes: bytes.byteLength * 3 });
    const evicted: Snapshot[] = [];
    store.onEvict((snapshot, reason) => {
      expect(reason).toBe('memory');
      evicted.push(snapshot);
    });
    const a = add('vehiclePositions', bytes);
    clock.advance(1000);
    const b = add('tripUpdates', bytes);
    clock.advance(1000);
    const c = add('vehiclePositions', bytes);
    expect(evicted).toEqual([]);
    clock.advance(1000);
    const d = add('tripUpdates', bytes);
    expect(evicted).toEqual([a]);
    clock.advance(1000);
    add('tripUpdates', bytes);
    expect(evicted).toEqual([a, b]);
    expect(store.retainedBytes()).toBe(bytes.byteLength * 3);
    expect(store.historyStartsAt()).toBe(c.receivedAt);
    expect(store.all('tripUpdates')[0]).toBe(d);
  });

  it('notifies snapshot listeners with the decoded message, and unsubscribes', () => {
    const { store, add } = setup();
    const seen: number[] = [];
    const off = store.onSnapshot((_snapshot, message) => seen.push(message.entity.length));
    add('vehiclePositions', encodeFeed({ vehicles: 3 }));
    off();
    add('vehiclePositions');
    expect(seen).toEqual([3]);
  });

  it('forgets everything on clear and tells clear listeners', () => {
    const { store, add } = setup();
    let cleared = 0;
    const evicted: Snapshot[] = [];
    store.onClear(() => cleared++);
    store.onEvict((snapshot) => evicted.push(snapshot));
    add('vehiclePositions');
    add('tripUpdates');
    store.clear();
    expect(cleared).toBe(1);
    expect(evicted).toEqual([]);
    expect(store.latest('vehiclePositions')).toBeNull();
    expect(store.all('tripUpdates')).toEqual([]);
    expect(store.historyStartsAt()).toBeNull();
    expect(store.retainedBytes()).toBe(0);
  });

  it("never evicts a feed's latest snapshot for memory, even when it is the oldest", () => {
    // The smallest limit the configuration allows for 100-byte responses: 2 x 100.
    const { clock, store } = setup({ memoryLimitBytes: 200 });
    const onlyVp = store.add('vehiclePositions', new Uint8Array(100), message);
    clock.advance(10_000);
    store.add('tripUpdates', new Uint8Array(60), message);
    clock.advance(10_000);
    const latestTu = store.add('tripUpdates', new Uint8Array(60), message);
    expect(store.latest('vehiclePositions')).toBe(onlyVp);
    expect(store.all('tripUpdates')).toEqual([latestTu]);
    expect(store.retainedBytes()).toBeLessThanOrEqual(200);
  });

  it('isolates throwing listeners: limits still hold and later listeners still run', () => {
    const { clock, store, logs } = setup({ memoryLimitBytes: 200 });
    const seen: string[] = [];
    store.onSnapshot(failing);
    store.onSnapshot((snapshot) => seen.push(`snapshot:${snapshot.bytes.byteLength}`));
    store.onEvict(failing);
    store.onEvict((_snapshot, reason) => seen.push(`evict:${reason}`));
    for (let i = 0; i < 5; i++) {
      expect(() => store.add('tripUpdates', new Uint8Array(100), message)).not.toThrow();
      clock.advance(1_000);
    }
    expect(store.retainedBytes()).toBeLessThanOrEqual(200);
    expect(seen.filter((entry) => entry.startsWith('snapshot'))).toHaveLength(5);
    expect(seen.filter((entry) => entry === 'evict:memory')).toHaveLength(3);
    expect(logs.join('\n')).toContain('extension hook failed');
  });

  it('announces a snapshot only after pruning, so listeners see a store within its limits', () => {
    const { store } = setup({ memoryLimitBytes: 200 });
    const retained: number[] = [];
    store.onSnapshot(() => retained.push(store.retainedBytes()));
    for (let i = 0; i < 4; i++) store.add('tripUpdates', new Uint8Array(100), message);
    expect(Math.max(...retained)).toBeLessThanOrEqual(200);
  });

  it('clears everything even when a clear listener throws', () => {
    const { store, add } = setup();
    let later = 0;
    store.onClear(failing);
    store.onClear(() => later++);
    add('vehiclePositions');
    expect(() => store.clear()).not.toThrow();
    expect(store.latest('vehiclePositions')).toBeNull();
    expect(later).toBe(1);
  });
});

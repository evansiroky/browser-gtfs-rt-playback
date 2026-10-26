import type {
  DashboardResponse,
  ListName,
  TripDetailResponse,
  TripListItem,
  TripListResponse,
} from '@gtfs-rt-debugger/shared';
import { toEpochSeconds, type Clock } from '../clock.js';
import { FEED_KINDS, type FeedKind, type SnapshotStore } from '../realtime/snapshot-store.js';
import type { ScheduleStore } from '../schedule/store.js';
import { activeItem, classify, unscheduledItem, type Classification } from './classify.js';
import { buildDetail } from './detail.js';
import { activeEntries, configurationErrorMessage, Frame, scheduledToday } from './entries.js';
import type { PingStore } from './pings.js';
import { latestReferences, type FeedReferences } from './references.js';

/** The dashboard lists the first this many configuration errors (api/dashboard.md). */
export const MAX_CONFIGURATION_ERROR_ITEMS = 100;

export class ScheduleNotReadyError extends Error {
  constructor() {
    super('The schedule is not ready.');
  }
}

export interface TripEngineOptions {
  clock: Clock;
  snapshots: SnapshotStore;
  pings: PingStore;
  /** The loaded schedule, or null while it is not ready. */
  schedule: () => ScheduleStore | null;
  /** The configured realtime feeds; default both. */
  feeds?: readonly FeedKind[];
}

/**
 * Every figure, list and trip detail of the dashboard and trips API (behaviors/trip-activity.md).
 * Nothing is remembered between calls: each one reads the schedule, the latest snapshots, the
 * pings and the clock afresh.
 */
export class TripEngine {
  readonly #options: TripEngineOptions;

  constructor(options: TripEngineOptions) {
    this.#options = options;
  }

  /** `GET /dashboard`; succeeds before the schedule is ready, with its figures null. */
  dashboard(): DashboardResponse {
    const nowMs = this.#options.clock.now();
    const store = this.#options.schedule();
    const feeds = this.#read();
    const vp = feeds.vehiclePositions?.feed ?? null;
    const tu = feeds.tripUpdates?.feed ?? null;
    const realtime = {
      vehicles: vp?.entities ?? null,
      vehiclesWithTripId: vp?.withTripId ?? null,
      tripUpdates: tu?.entities ?? null,
    };
    if (!store) {
      return {
        now: toEpochSeconds(nowMs),
        agency: null,
        schedule: null,
        realtime: { ...realtime, activeTripsWithRealtime: null },
        lists: null,
        configurationErrors: null,
      };
    }
    const frame = new Frame(store, nowMs);
    const entries = activeEntries(frame);
    const classification = classify(frame, entries, this.#references(feeds));
    const agency = store.agency();
    const errors = store.configurationErrors();
    const complete = (this.#options.feeds ?? FEED_KINDS).every((feed) => feeds[feed] !== null);
    return {
      now: toEpochSeconds(nowMs),
      agency: { names: [...agency.names], timezone: agency.timezone },
      schedule: { tripsToday: scheduledToday(frame), tripsActiveNow: entries.length },
      realtime: {
        ...realtime,
        activeTripsWithRealtime: complete ? classification.withRealtime.length : null,
      },
      lists: {
        activeWithRealtime: classification.withRealtime.length,
        activeWithoutRealtime: classification.withoutRealtime.length,
        unscheduledWithRealtime: classification.unscheduled.length,
      },
      configurationErrors: {
        total: errors.length,
        items: errors.slice(0, MAX_CONFIGURATION_ERROR_ITEMS).map(({ code, tripId }) => ({
          code,
          tripId,
          message: configurationErrorMessage(code),
        })),
      },
    };
  }

  /** `GET /trips?list=`; throws {@link ScheduleNotReadyError} before the schedule is ready. */
  list(list: ListName): TripListResponse {
    const nowMs = this.#options.clock.now();
    const store = this.#options.schedule();
    if (!store) throw new ScheduleNotReadyError();
    const frame = new Frame(store, nowMs);
    const classification = classify(frame, activeEntries(frame), this.#references(this.#read()));
    return { list, generatedAt: toEpochSeconds(nowMs), trips: rows(frame, classification, list) };
  }

  /**
   * `GET /trips/{tripId}`; null when the trip ID is neither in the schedule nor in the retained
   * realtime data. Throws {@link ScheduleNotReadyError} before the schedule is ready.
   */
  detail(tripId: string): TripDetailResponse | null {
    const nowMs = this.#options.clock.now();
    const store = this.#options.schedule();
    if (!store) throw new ScheduleNotReadyError();
    const frame = new Frame(store, nowMs);
    const references = this.#references(this.#read()).filter((r) => r.tripId === tripId);
    return buildDetail(frame, tripId, references, this.#options.pings.forTrip(tripId));
  }

  #read(): Record<FeedKind, { feed: FeedReferences } | null> {
    const { snapshots } = this.#options;
    return {
      vehiclePositions: latestReferences(snapshots.latest('vehiclePositions')),
      tripUpdates: latestReferences(snapshots.latest('tripUpdates')),
    };
  }

  /** Vehicle position references, then trip update references, each in feed order. */
  #references(feeds: Record<FeedKind, { feed: FeedReferences } | null>) {
    return [
      ...(feeds.vehiclePositions?.feed.references ?? []),
      ...(feeds.tripUpdates?.feed.references ?? []),
    ];
  }
}

function rows(frame: Frame, classification: Classification, list: ListName): TripListItem[] {
  switch (list) {
    case 'active-with-realtime':
      return classification.withRealtime.map((row) => activeItem(frame, row));
    case 'active-without-realtime':
      return classification.withoutRealtime.map((row) => activeItem(frame, row));
    case 'unscheduled-with-realtime':
      return classification.unscheduled.map((row) => unscheduledItem(frame, row));
  }
}

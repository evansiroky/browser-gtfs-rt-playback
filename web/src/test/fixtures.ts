import type { FeedStatus, SessionStatus } from '@gtfs-rt-debugger/shared';

export const NOW = 1_800_000_000;

export function feed(overrides: Partial<FeedStatus> = {}): FeedStatus {
  return {
    lastAttemptAt: NOW - 5,
    lastSuccessAt: NOW - 5,
    feedTimestamp: NOW - 6,
    stale: false,
    error: null,
    ...overrides,
  };
}

/** An active session with a ready schedule and healthy feeds. */
export function activeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    state: 'active',
    endedReason: null,
    activatedAt: NOW - 600,
    expiresAt: NOW + 6600,
    historyStartsAt: NOW - 590,
    schedule: { state: 'ready', loadedAt: NOW - 580, error: null },
    realtime: { vehiclePositions: feed(), tripUpdates: feed() },
    ...overrides,
  };
}

export function dormantStatus(endedReason: SessionStatus['endedReason']): SessionStatus {
  return {
    state: 'dormant',
    endedReason,
    activatedAt: null,
    expiresAt: null,
    historyStartsAt: null,
    schedule: { state: 'idle', loadedAt: null, error: null },
    realtime: { vehiclePositions: null, tripUpdates: null },
  };
}

import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { activeStatus, dormantStatus, feed, NOW } from '@/test/fixtures';
import type { ActivitySnapshot } from './activity-controller';
import { selectBanner } from './banner';

function session(overrides: Partial<ActivitySnapshot> = {}) {
  return { phase: 'engaged', status: activeStatus(), error: null, ...overrides } as const;
}

describe('selectBanner', () => {
  it('shows nothing for a healthy engaged session, or before the first answer', () => {
    expect(selectBanner(session(), NOW)).toBeNull();
    expect(selectBanner(session({ phase: 'starting', status: null }), NOW)).toBeNull();
  });

  it('names the reason when paused', () => {
    expect(selectBanner(session({ phase: 'paused-hidden' }), NOW)).toMatchObject({
      id: 'paused-hidden',
      title: 'Paused — tab hidden',
    });
    expect(selectBanner(session({ phase: 'paused-idle' }), NOW)).toMatchObject({
      id: 'paused-idle',
      title: 'Paused — no activity for a minute',
    });
    expect(selectBanner(session({ phase: 'paused-idle' }), NOW)?.action).toBeUndefined();
  });

  it('shows the ended banner with Restart', () => {
    expect(
      selectBanner(session({ phase: 'ended', status: dormantStatus('max-duration') }), NOW),
    ).toMatchObject({
      id: 'ended',
      title: 'Session ended after the maximum running time.',
      action: { kind: 'restart', label: 'Restart' },
    });
  });

  it('puts ended ahead of a pause, and a pause ahead of every other banner', () => {
    const failing = activeStatus({ schedule: { state: 'failed', loadedAt: null, error: null } });
    const down = new ApiError('network', 'x');
    expect(
      selectBanner(session({ phase: 'ended', status: dormantStatus('max-duration') }), NOW)?.id,
    ).toBe('ended');
    expect(
      selectBanner(session({ phase: 'paused-idle', status: failing, error: down }), NOW)?.id,
    ).toBe('paused-idle');
  });

  it("says it can't reach the server for network failures and 5xx, but not for other errors", () => {
    for (const error of [
      new ApiError('network', 'x'),
      new ApiError('http', 'x', { status: 502 }),
      new ApiError('http', 'x', { status: 500, code: 'internal_error' }),
    ]) {
      expect(selectBanner(session({ error }), NOW)).toMatchObject({
        id: 'unreachable',
        title: "Can't reach the server.",
      });
    }
    expect(
      selectBanner(session({ error: new ApiError('http', 'x', { status: 429 }) }), NOW),
    ).toBeNull();
  });

  it("shows can't-reach even before any status arrived, with no action", () => {
    const banner = selectBanner(
      session({ phase: 'starting', status: null, error: new ApiError('network', 'x') }),
      NOW,
    );
    expect(banner?.id).toBe('unreachable');
    expect(banner?.action).toBeUndefined();
  });

  it('shows schedule loading', () => {
    const status = activeStatus({ schedule: { state: 'loading', loadedAt: null, error: null } });
    expect(selectBanner(session({ status }), NOW)).toMatchObject({
      id: 'schedule-loading',
      title: 'Downloading the schedule…',
    });
  });

  it('shows the schedule error with Retry', () => {
    const status = activeStatus({
      schedule: {
        state: 'failed',
        loadedAt: null,
        error: { code: 'http_status_404', message: 'Schedule download returned HTTP 404.' },
      },
    });
    expect(selectBanner(session({ status }), NOW)).toMatchObject({
      id: 'schedule-failed',
      description: 'Schedule download returned HTTP 404.',
      action: { kind: 'retry', label: 'Retry' },
    });
  });

  it('names a stale feed with the age of its last success', () => {
    const status = activeStatus({
      realtime: {
        vehiclePositions: feed({ stale: true, lastSuccessAt: NOW - 125 }),
        tripUpdates: feed(),
      },
    });
    expect(selectBanner(session({ status }), NOW)).toMatchObject({
      id: 'stale-feed',
      title: 'Vehicle positions feed is stale.',
      description: 'Vehicle positions: last successful update 2 min ago.',
    });
  });

  it('names both stale feeds, and a feed that never succeeded', () => {
    const status = activeStatus({
      realtime: {
        vehiclePositions: feed({ stale: true, lastSuccessAt: NOW - 30 }),
        tripUpdates: feed({ stale: true, lastSuccessAt: null }),
      },
    });
    expect(selectBanner(session({ status }), NOW)).toMatchObject({
      title: 'Vehicle positions and trip updates feeds are stale.',
      description:
        'Vehicle positions: last successful update 30 s ago. Trip updates: no successful update yet.',
    });
  });

  it('ignores feeds that are not configured and fresh feeds', () => {
    const status = activeStatus({ realtime: { vehiclePositions: null, tripUpdates: feed() } });
    expect(selectBanner(session({ status }), NOW)).toBeNull();
  });

  it('lets schedule problems outrank stale feeds (at most one banner)', () => {
    const status = activeStatus({
      schedule: { state: 'loading', loadedAt: null, error: null },
      realtime: { vehiclePositions: feed({ stale: true }), tripUpdates: null },
    });
    expect(selectBanner(session({ status }), NOW)?.id).toBe('schedule-loading');
  });

  it('shows nothing for a dormant, not-ended status', () => {
    expect(selectBanner(session({ status: dormantStatus(null) }), NOW)).toBeNull();
  });
});

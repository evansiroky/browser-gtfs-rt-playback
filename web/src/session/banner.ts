import type { FeedStatus } from '@gtfs-rt-debugger/shared';
import { ApiError } from '@/api/client';
import { ageSeconds, formatAge } from '@/lib/time';
import type { ActivitySnapshot } from './activity-controller';

export interface BannerModel {
  id:
    | 'ended'
    | 'paused-idle'
    | 'paused-hidden'
    | 'unreachable'
    | 'schedule-failed'
    | 'schedule-loading'
    | 'stale-feed';
  tone: 'info' | 'error';
  title: string;
  description?: string;
  /** Both actions call `POST /session/start`. */
  action?: { kind: 'restart' | 'retry'; label: string };
}

const RESUME_HINT =
  'Move the pointer, tap, or press a key to resume. Showing the last data received.';

function staleFeeds(status: NonNullable<ActivitySnapshot['status']>) {
  const feeds: [string, FeedStatus | null][] = [
    ['Vehicle positions', status.realtime.vehiclePositions],
    ['Trip updates', status.realtime.tripUpdates],
  ];
  return feeds.filter((entry): entry is [string, FeedStatus] => entry[1]?.stale === true);
}

/**
 * The single session banner shown above everything else, or null
 * ([dashboard](../../../specs/screens/dashboard.md#display-rules)). `nowSeconds` is the client
 * clock, used only for the age of stale feeds.
 */
export function selectBanner(
  session: Pick<ActivitySnapshot, 'phase' | 'status' | 'error'>,
  nowSeconds: number,
): BannerModel | null {
  const { phase, status, error } = session;

  // An ended session outranks a pause: nothing can resume until Restart.
  if (phase === 'ended') {
    return {
      id: 'ended',
      tone: 'error',
      title: 'Session ended after the maximum running time.',
      description: 'The server has stopped and forgotten its data. Restart to begin a new session.',
      action: { kind: 'restart', label: 'Restart' },
    };
  }
  if (phase === 'paused-hidden') {
    return {
      id: 'paused-hidden',
      tone: 'info',
      title: 'Paused — tab hidden',
      description: RESUME_HINT,
    };
  }
  if (phase === 'paused-idle') {
    return {
      id: 'paused-idle',
      tone: 'info',
      title: 'Paused — no activity for a minute',
      description: RESUME_HINT,
    };
  }

  if (error instanceof ApiError && error.isUnreachable) {
    return {
      id: 'unreachable',
      tone: 'error',
      title: "Can't reach the server.",
      description: 'Showing the last data received. Trying again every 10 seconds.',
    };
  }

  if (status?.state === 'active') {
    if (status.schedule.state === 'failed') {
      return {
        id: 'schedule-failed',
        tone: 'error',
        title: "Couldn't load the schedule.",
        description: status.schedule.error?.message,
        action: { kind: 'retry', label: 'Retry' },
      };
    }
    if (status.schedule.state === 'loading') {
      return {
        id: 'schedule-loading',
        tone: 'info',
        title: 'Downloading the schedule…',
        description: 'Realtime statistics already update while it loads.',
      };
    }
    const stale = staleFeeds(status);
    if (stale.length > 0) {
      const names = stale.map(([name]) => name);
      const list = names.length === 1 ? names[0]! : `${names[0]} and ${names[1]!.toLowerCase()}`;
      return {
        id: 'stale-feed',
        tone: 'info',
        title: `${list} ${names.length === 1 ? 'feed is' : 'feeds are'} stale.`,
        description: stale
          .map(([name, feed]) =>
            feed.lastSuccessAt === null
              ? `${name}: no successful update yet.`
              : `${name}: last successful update ${formatAge(ageSeconds(nowSeconds, feed.lastSuccessAt))}.`,
          )
          .join(' '),
      };
    }
  }
  return null;
}

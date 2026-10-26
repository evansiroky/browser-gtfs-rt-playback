import { useQuery, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';
import type { ActivitySnapshot } from './activity-controller';
import { useSession } from './use-session';

/** Data refreshes at the same cadence as pings ([client-activity](../../../specs/behaviors/client-activity.md)). */
export const DATA_POLL_INTERVAL_MS = 10_000;

/**
 * Data is fetched only while the page is engaged, the server has answered that it is active,
 * and the ping that announced a resume has been answered (so a dormant server is awake first).
 */
export function isPollable(session: Pick<ActivitySnapshot, 'phase' | 'status' | 'resuming'>) {
  return session.phase === 'engaged' && !session.resuming && session.status?.state === 'active';
}

/**
 * Query options that poll every 10 s while the page is engaged and nothing otherwise. Leaving
 * the paused state flips `enabled` to true, which fetches stale data immediately: that is the
 * refetch on resume. Failures never clear data: React Query keeps the last good `data` and
 * `dataUpdatedAt`, which screens show as an age.
 */
export function pollWhileEngaged(session: Pick<ActivitySnapshot, 'phase' | 'status' | 'resuming'>) {
  const pollable = isPollable(session);
  return {
    enabled: pollable,
    refetchInterval: pollable ? DATA_POLL_INTERVAL_MS : (false as const),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // The 10 s cadence is the retry.
    retry: false,
    staleTime: 0,
  };
}

/**
 * `useQuery` for data that screens poll only while engaged. `enabled` adds a further condition
 * (the schedule being ready, say); it can only hold polling back, never force it.
 */
export function useEngagedQuery<TData, TKey extends QueryKey = QueryKey>(
  options: Pick<UseQueryOptions<TData, Error, TData, TKey>, 'queryKey' | 'queryFn'> & {
    enabled?: boolean;
  },
) {
  const session = useSession();
  const polling = pollWhileEngaged(session);
  return useQuery({
    ...options,
    ...polling,
    enabled: polling.enabled && (options.enabled ?? true),
  });
}

import type {
  DashboardResponse,
  ListName,
  ShapeResponse,
  TripDetailResponse,
  TripListResponse,
} from '@gtfs-rt-debugger/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useEngagedQuery } from '@/session/poll';
import { useSession } from '@/session/use-session';
import { ApiError, apiGet } from './client';

/** `GET /dashboard`, refreshed every 10 s while the page is engaged. */
export function useDashboard() {
  return useEngagedQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => apiGet<DashboardResponse>('/dashboard', signal),
  });
}

/**
 * `GET /trips?list=…`, refreshed like the dashboard but only once the server reports the
 * schedule as ready (before that the endpoint answers `409 schedule_not_ready`).
 */
export function useTripList(list: ListName) {
  const scheduleReady = useSession().status?.schedule.state === 'ready';
  return useEngagedQuery({
    queryKey: ['trips', list],
    queryFn: ({ signal }) => apiGet<TripListResponse>(`/trips?list=${list}`, signal),
    enabled: scheduleReady,
  });
}

/**
 * `GET /trips/{tripId}`, refreshed every 10 s while engaged, once the schedule is ready (before
 * that the endpoint answers `409 schedule_not_ready`).
 */
export function useTripDetail(tripId: string) {
  const scheduleReady = useSession().status?.schedule.state === 'ready';
  return useEngagedQuery({
    queryKey: ['trip', tripId],
    queryFn: ({ signal }) =>
      apiGet<TripDetailResponse>(`/trips/${encodeURIComponent(tripId)}`, signal),
    enabled: scheduleReady,
  });
}

/** Whether a failed shape request is worth repeating: not an answer from the server about it. */
function retryShape(failures: number, error: Error): boolean {
  const answered = error instanceof ApiError && error.kind === 'http' && !error.isUnreachable;
  return !answered && failures < 3;
}

/**
 * `GET /shapes/{shapeId}`, fetched once per page view and not polled: a shape never changes
 * while the same activation lasts, so the cache key carries the activation and a new
 * `activatedAt` fetches it again ([shapes](../../../specs/api/shapes.md#endpoint)). The key keeps
 * the last known activation while the server is dormant, so the line stays on the map.
 */
export function useShape(shapeId: string | null) {
  const { status } = useSession();
  const [activatedAt, setActivatedAt] = useState<number | null>(null);
  const current = status?.state === 'active' ? (status.activatedAt ?? 0) : null;
  if (current !== null && current !== activatedAt) setActivatedAt(current);
  return useQuery({
    queryKey: ['shape', shapeId, activatedAt],
    queryFn: ({ signal }) =>
      apiGet<ShapeResponse>(`/shapes/${encodeURIComponent(shapeId ?? '')}`, signal),
    enabled:
      shapeId !== null &&
      activatedAt !== null &&
      status?.state === 'active' &&
      status.schedule.state === 'ready',
    staleTime: Infinity,
    retry: retryShape,
    retryDelay: 3_000,
  });
}

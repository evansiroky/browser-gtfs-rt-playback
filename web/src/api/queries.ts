import type { DashboardResponse, ListName, TripListResponse } from '@gtfs-rt-debugger/shared';
import { useEngagedQuery } from '@/session/poll';
import { useSession } from '@/session/use-session';
import { apiGet } from './client';

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

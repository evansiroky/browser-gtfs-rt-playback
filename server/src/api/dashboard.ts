import type { DashboardResponse } from '@gtfs-rt-debugger/shared';
import type { ApiRoutes } from '../http/api.js';
import { rejectUnknownQuery } from '../http/guards.js';

/**
 * `GET /api/v1/dashboard` (api/dashboard.md). Needs an active server but not the schedule: while
 * it loads, the schedule-dependent fields are null.
 */
export const dashboardRoutes: ApiRoutes<unknown> = (api, { trips, guard }) => {
  api.get(
    '/dashboard',
    { preHandler: [rejectUnknownQuery([]), guard.requireActive] },
    async (): Promise<DashboardResponse> => trips.dashboard(),
  );
};

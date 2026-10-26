import {
  LIST_NAMES,
  type ListName,
  type TripDetailResponse,
  type TripListResponse,
} from '@gtfs-rt-debugger/shared';
import type { ApiRoutes } from '../http/api.js';
import { ApiError } from '../http/errors.js';
import { rejectUnknownQuery, type ApiHook } from '../http/guards.js';

function listName(query: unknown): ListName {
  const { list } = (query ?? {}) as { list?: unknown };
  const name = LIST_NAMES.find((candidate) => candidate === list);
  if (!name) {
    throw new ApiError(400, 'bad_request', `"list" must be one of: ${LIST_NAMES.join(', ')}.`);
  }
  return name;
}

const requireList: ApiHook = async (request) => void listName(request.query);

/**
 * `GET /api/v1/trips?list=<name>` and `GET /api/v1/trips/{tripId}` (api/trips.md). Query
 * validation comes first, then the state checks. Neither endpoint accepts a date.
 */
export const tripsRoutes: ApiRoutes<unknown> = (api, { trips, guard }) => {
  api.get(
    '/trips',
    { preHandler: [rejectUnknownQuery(['list']), requireList, guard.requireSchedule] },
    async (request): Promise<TripListResponse> => trips.list(listName(request.query)),
  );

  api.get(
    '/trips/:tripId',
    { preHandler: [rejectUnknownQuery([]), guard.requireSchedule] },
    async (request): Promise<TripDetailResponse> => {
      const { tripId } = request.params as { tripId: string };
      const detail = trips.detail(tripId);
      if (!detail) throw new ApiError(404, 'trip_not_found', 'No such trip.');
      return detail;
    },
  );
};

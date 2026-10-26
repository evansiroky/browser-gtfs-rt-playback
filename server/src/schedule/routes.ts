import type { ShapeResponse } from '@gtfs-rt-debugger/shared';
import { ApiError } from '../http/errors.js';
import { rejectUnknownQuery } from '../http/guards.js';
import type { ApiRoutes } from '../http/api.js';
import type { ScheduleLoader } from './loader.js';

/** The services this plan adds to `buildApp`; later plans add their own beside it. */
export interface ScheduleServices {
  readonly loader: ScheduleLoader;
}

/** `GET /api/v1/shapes/{shapeId}` (api/shapes.md): the stored polyline, served unchanged. */
export const shapesRoutes: ApiRoutes<ScheduleServices> = (api, { services, guard }) => {
  api.get(
    '/shapes/:shapeId',
    { preHandler: [rejectUnknownQuery([]), guard.requireSchedule] },
    async (request): Promise<ShapeResponse> => {
      const { shapeId } = request.params as { shapeId: string };
      const polyline = services.loader.store?.shape(shapeId) ?? null;
      if (polyline === null) throw new ApiError(404, 'shape_not_found', 'No such shape.');
      return { shapeId, encoding: 'polyline6', polyline };
    },
  );
};

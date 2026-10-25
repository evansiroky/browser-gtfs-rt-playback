import type { SessionStatus } from '@gtfs-rt-debugger/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import type { SnapshotStore } from '../realtime/snapshot-store.js';
import type { ScheduleProvider } from '../session/schedule-provider.js';
import type { SessionManager } from '../session/session-manager.js';
import { ApiError, handleApiError, notFoundError } from './errors.js';
import { rejectUnknownQuery, type DataEndpointGuard } from './guards.js';
import { RateLimiter } from './rate-limit.js';

export const API_PREFIX = '/api/v1';

/** Everything an API route plugin may use. */
export interface ServerContext {
  readonly config: Config;
  readonly clock: Clock;
  readonly logger: FastifyBaseLogger;
  readonly store: SnapshotStore;
  readonly schedule: ScheduleProvider;
  readonly session: SessionManager;
  readonly guard: DataEndpointGuard;
}

/**
 * Registers routes inside the `/api/v1` scope (paths are relative to it, e.g. `/dashboard`).
 * Routes there get the conventions for free: rate limiting, `Cache-Control: no-store`, the error
 * envelope for thrown {@link ApiError}s and unexpected errors, and a `not_found` envelope for
 * unknown paths. Each route adds its own `rejectUnknownQuery([...])` and guard preHandlers.
 */
export type ApiRoutes = (api: FastifyInstance, context: ServerContext) => void | Promise<void>;

export function apiPlugin(context: ServerContext, routes: readonly ApiRoutes[]) {
  return async (api: FastifyInstance) => {
    const limiter = new RateLimiter(context.clock, context.config.rateLimitPerMinute);

    api.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const result = limiter.hit(request.ip);
      if (!result.allowed) {
        throw new ApiError(429, 'rate_limited', 'Too many requests; slow down.', {
          'retry-after': String(result.retryAfterSeconds),
        });
      }
    });
    api.setErrorHandler(handleApiError);
    api.setNotFoundHandler(async () => {
      throw notFoundError();
    });

    await sessionRoutes(api, context);
    for (const register of routes) await register(api, context);
  };
}

const sessionRoutes: ApiRoutes = (api, { session }) => {
  const noQuery = rejectUnknownQuery([]);
  api.post('/session/start', { preHandler: noQuery }, async (): Promise<SessionStatus> =>
    session.start(),
  );
  api.post('/session/ping', { preHandler: noQuery }, async (): Promise<SessionStatus> =>
    session.ping(),
  );
};

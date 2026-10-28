import type { FastifyRequest } from 'fastify';
import type { SessionManager } from '../session/session-manager.js';
import { ApiError } from './errors.js';

/** A preHandler hook for API routes; it answers by throwing an {@link ApiError}. */
export type ApiHook = (request: FastifyRequest) => Promise<void>;

/**
 * State guards for data endpoints (api/session.md "Data endpoints and state"). They only read
 * state: a data endpoint never wakes the server or resets the inactivity timer.
 */
export interface DataEndpointGuard {
  /** `409 session_not_active` while dormant. */
  readonly requireActive: ApiHook;
  /** As {@link requireActive}, then `409 schedule_not_ready` unless the schedule is `ready`. */
  readonly requireSchedule: ApiHook;
}

export function createDataEndpointGuard(session: SessionManager): DataEndpointGuard {
  const requireActive: ApiHook = async () => {
    if (!session.active) {
      throw new ApiError(
        409,
        'session_not_active',
        'The server is dormant; start or ping the session first.',
      );
    }
  };
  const requireSchedule: ApiHook = async (request) => {
    await requireActive(request);
    const { state } = session.scheduleStatus();
    if (state !== 'ready') {
      throw new ApiError(
        409,
        'schedule_not_ready',
        state === 'failed' ? 'The schedule failed to load.' : 'The schedule is still loading.',
      );
    }
  };
  return { requireActive, requireSchedule };
}

/**
 * `400 bad_request` when the query string has any parameter not in `allowed` (conventions.md:
 * any query parameter an endpoint does not define). A repeated allowed parameter is also
 * rejected, since no endpoint defines a list-valued parameter.
 */
export function rejectUnknownQuery(allowed: readonly string[]): ApiHook {
  const allowedSet = new Set(allowed);
  return async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(query)) {
      if (!allowedSet.has(name)) {
        throw new ApiError(
          400,
          'bad_request',
          `Unexpected query parameter "${name.slice(0, 64)}".`,
        );
      }
      if (Array.isArray(value)) {
        throw new ApiError(400, 'bad_request', `Query parameter "${name}" may appear only once.`);
      }
    }
  };
}

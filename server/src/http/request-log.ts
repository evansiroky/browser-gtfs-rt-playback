import type { FastifyInstance, FastifyRequest } from 'fastify';

/** A path in a log line is cut at this many characters: it is client-chosen. */
const MAX_LOGGED_PATH = 256;

function apiPath(request: FastifyRequest): string | null {
  const path = request.url.split('?', 1)[0] ?? '';
  if (path !== '/api' && !path.startsWith('/api/')) return null;
  return path.slice(0, MAX_LOGGED_PATH);
}

/**
 * Logs every `/api` request as it comes in, when its response has been sent and when the client
 * goes away first (logging.md "Client requests"). Static files are not logged. The three lines of
 * a request share its `reqId`. The hooks are on the root instance and registered before the
 * routes, so they run before the rate limiter and every other check; the query string and the
 * client address are never logged.
 */
export function logApiRequests(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    const path = apiPath(request);
    if (path) request.log.info({ method: request.method, path }, 'api request received');
  });
  app.addHook('onResponse', async (request, reply) => {
    const path = apiPath(request);
    if (!path) return;
    const fields = {
      method: request.method,
      path,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    };
    if (reply.statusCode >= 500) request.log.warn(fields, 'api response sent');
    else request.log.info(fields, 'api response sent');
  });
  app.addHook('onRequestAbort', async (request) => {
    const path = apiPath(request);
    if (!path) return;
    request.log.info({ method: request.method, path }, 'api request aborted');
  });
}

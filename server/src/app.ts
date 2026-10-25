import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { systemClock, type Clock } from './clock.js';
import { secretFragments, type Config } from './config.js';
import { apiPlugin, API_PREFIX, type ApiRoutes, type ServerContext } from './http/api.js';
import { handleApiError } from './http/errors.js';
import { createDataEndpointGuard } from './http/guards.js';
import { securityHeaders } from './http/security-headers.js';
import { hasWebBuild, registerWebApp } from './http/static.js';
import { redactingDestination, type LogDestination } from './logging.js';
import { FeedPoller } from './realtime/feed-poller.js';
import { FEED_KINDS, SnapshotStore } from './realtime/snapshot-store.js';
import { noopScheduleProvider, type ScheduleProvider } from './session/schedule-provider.js';
import { SessionManager } from './session/session-manager.js';

/** What a schedule provider factory receives; it is built before the session manager. */
export interface ScheduleDeps {
  readonly config: Config;
  readonly clock: Clock;
  readonly logger: FastifyBaseLogger;
  readonly store: SnapshotStore;
}

export interface AppOptions {
  config: Config;
  /** Called after an idle shutdown with `EXIT_ON_IDLE` once the server has closed (drained). */
  exit: () => void;
  clock?: Clock;
  /** Log sink (redacted for feed URLs); default stdout. */
  logDestination?: LogDestination;
  logLevel?: string;
  /** Builds the schedule provider; default {@link noopScheduleProvider}. */
  schedule?: (deps: ScheduleDeps) => ScheduleProvider;
  /** Route plugins mounted under `/api/v1`. */
  routes?: readonly ApiRoutes[];
}

export interface App {
  readonly app: FastifyInstance;
  readonly context: ServerContext;
}

/** Composes the whole server. Nothing is fetched until a session start or ping wakes it. */
export async function buildApp(options: AppOptions): Promise<App> {
  const { config, exit, clock = systemClock } = options;
  const app = Fastify({
    logger: {
      level: options.logLevel ?? 'info',
      stream: redactingDestination(
        secretFragments(config),
        options.logDestination ?? process.stdout,
      ),
    },
    // Trust one hop (the platform's proxy): the client address is the last X-Forwarded-For entry.
    trustProxy: (_address, hop) => hop === 0,
    // Per-request lines would be most of the log volume (a ping every 10 s per viewer).
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16 * 1024,
  });
  const logger = app.log;
  for (const warning of config.warnings) logger.warn(warning);

  const store = new SnapshotStore({
    clock,
    retentionMs: config.retentionMs,
    memoryLimitBytes: config.historyMemoryLimitBytes,
  });
  const schedule = (options.schedule ?? (() => noopScheduleProvider))({
    config,
    clock,
    logger,
    store,
  });
  const urls = { vehiclePositions: config.vehiclePositionsUrl, tripUpdates: config.tripUpdatesUrl };
  const pollers = FEED_KINDS.flatMap((feed) => {
    const url = urls[feed];
    if (!url) return [];
    return new FeedPoller({
      feed,
      url,
      clock,
      store,
      logger: logger.child({ component: 'poller' }),
      intervalMs: config.pollIntervalMs,
      timeoutMs: config.realtimeTimeoutMs,
      maxBytes: config.realtimeMaxBytes,
    });
  });
  const session = new SessionManager({
    clock,
    logger: logger.child({ component: 'session' }),
    idleTimeoutMs: config.idleTimeoutMs,
    maxActivationMs: config.maxActivationMs,
    exitOnIdle: config.exitOnIdle,
    store,
    schedule,
    pollers,
    onIdleExit: () => {
      void app.close().then(exit, exit);
    },
  });
  const context: ServerContext = {
    config,
    clock,
    logger,
    store,
    schedule,
    session,
    guard: createDataEndpointGuard(session, schedule),
  };

  const headers = securityHeaders(config.tileHost);
  app.addHook('onRequest', async (_request, reply) => {
    reply.headers(headers);
  });
  app.setErrorHandler(handleApiError);
  app.addHook('onClose', async () => session.dispose());

  await app.register(apiPlugin(context, options.routes ?? []), { prefix: API_PREFIX });
  const webBuild = hasWebBuild(config.webDistDir) ? config.webDistDir : null;
  if (!webBuild) logger.info('no web build found; serving the API only');
  await registerWebApp(app, webBuild);

  return { app, context };
}

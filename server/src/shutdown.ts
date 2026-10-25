import type { FastifyBaseLogger } from 'fastify';

/** How long closing may wait for in-flight requests before the process exits anyway. */
export const DRAIN_DEADLINE_MS = 5_000;

/**
 * Closes the server, letting in-flight requests finish, then calls `exit` (once). A hard deadline
 * calls `exit` even if a client holds a request open, so a shutting-down process can never linger
 * (and bill) indefinitely. The deadline uses a real, unreferenced timer: it guards the process,
 * not app behavior, so it must not depend on the injected clock.
 */
export function closeThenExit(
  app: { close(): PromiseLike<unknown> },
  exit: () => void,
  deadlineMs = DRAIN_DEADLINE_MS,
): void {
  let exited = false;
  const exitOnce = () => {
    if (exited) return;
    exited = true;
    exit();
  };
  setTimeout(exitOnce, deadlineMs).unref();
  app.close().then(exitOnce, exitOnce);
}

/**
 * Process policy for failures nothing handled: log and exit non-zero at once. State may be
 * inconsistent after such a failure, and a half-working process must not keep running.
 */
export function installCrashPolicy(
  target: NodeJS.EventEmitter,
  logger: FastifyBaseLogger,
  exit: (code: number) => void,
): void {
  const crash = (kind: string) => (error: unknown) => {
    logger.fatal({ err: error, kind }, 'unhandled failure; exiting');
    exit(1);
  };
  target.on('unhandledRejection', crash('unhandledRejection'));
  target.on('uncaughtException', crash('uncaughtException'));
}

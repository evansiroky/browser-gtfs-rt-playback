import type { FastifyBaseLogger } from 'fastify';

/**
 * Runs one extension hook (a store listener or a schedule provider call) so that a failure is
 * logged and contained: the caller's own state stays consistent and later hooks still run.
 * Returns whether the hook completed.
 */
export function runHook(logger: FastifyBaseLogger, hook: string, call: () => void): boolean {
  try {
    call();
    return true;
  } catch (error) {
    logger.error({ err: error, hook }, 'extension hook failed');
    return false;
  }
}

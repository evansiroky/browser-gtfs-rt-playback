import Fastify, { type FastifyBaseLogger } from 'fastify';

/** A real (pino) logger whose lines are collected into `lines`. */
export function captureLogger(lines: string[]): FastifyBaseLogger {
  return Fastify({
    logger: { level: 'debug', stream: { write: (line: string) => void lines.push(line) } },
  }).log;
}

/** A logger that discards everything, for tests that do not look at the log. */
export const silentLogger: FastifyBaseLogger = Fastify({ logger: false }).log;

/** The captured lines of {@link captureLogger}, parsed. */
export function logEntries(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

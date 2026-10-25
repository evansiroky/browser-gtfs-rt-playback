import Fastify, { type FastifyBaseLogger } from 'fastify';

/** A real (pino) logger whose lines are collected into `lines`. */
export function captureLogger(lines: string[]): FastifyBaseLogger {
  return Fastify({
    logger: { level: 'debug', stream: { write: (line: string) => void lines.push(line) } },
  }).log;
}

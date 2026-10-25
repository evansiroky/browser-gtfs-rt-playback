import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errorBody } from './errors.js';

export function isApiPath(url: string): boolean {
  const pathname = url.split('?', 1)[0] ?? '';
  return pathname === '/api' || pathname.startsWith('/api/');
}

export function hasWebBuild(webDistDir: string): boolean {
  return existsSync(path.join(webDistDir, 'index.html'));
}

/**
 * A request for a static file rather than a client-side route: anything under `/assets/` or a
 * top-level name with an extension (`/favicon.ico`). Client routes such as `/trips/a.b` (trip IDs
 * may contain dots) are deeper than one segment, so they still reach the app.
 */
function isFileRequest(pathname: string): boolean {
  return pathname.startsWith('/assets/') || /^\/[^/]+\.[A-Za-z0-9]+$/.test(pathname);
}

/**
 * Serves the built web app from `webDistDir` (files that exist at startup), with an SPA fallback:
 * any other `GET`/`HEAD` outside `/api` answers with `index.html` so client-side routes load,
 * except a missing static file, which is a plain 404 (a stale page must never receive HTML for a
 * script). `/api/*` never falls through to the app; it answers with the `not_found` envelope.
 */
export async function registerWebApp(
  app: FastifyInstance,
  webDistDir: string | null,
): Promise<void> {
  if (webDistDir) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      wildcard: false,
      setHeaders(reply, filePath) {
        const hashedAsset = filePath.startsWith(path.join(webDistDir, 'assets') + path.sep);
        reply.header(
          'cache-control',
          hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const pathname = request.url.split('?', 1)[0] ?? '';
    const read = request.method === 'GET' || request.method === 'HEAD';
    if (webDistDir && read && !isApiPath(pathname)) {
      if (isFileRequest(pathname)) {
        return reply
          .code(404)
          .type('text/plain; charset=utf-8')
          .header('cache-control', 'no-store')
          .send('Not found');
      }
      return reply.sendFile('index.html');
    }
    return reply
      .code(404)
      .header('cache-control', 'no-store')
      .send(errorBody('not_found', 'No such endpoint.'));
  });
}

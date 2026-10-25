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
 * Serves the built web app from `webDistDir` (files that exist at startup), with an SPA fallback:
 * any other `GET` outside `/api` answers with `index.html` so client-side routes load. `/api/*`
 * never falls through to the app; it answers with the `not_found` envelope.
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
    if (webDistDir && request.method === 'GET' && !isApiPath(request.url)) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply
      .code(404)
      .header('cache-control', 'no-store')
      .send(errorBody('not_found', 'No such endpoint.'));
  });
}

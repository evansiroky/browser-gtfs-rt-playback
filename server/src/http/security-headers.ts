/**
 * The Content-Security-Policy for every response (architecture.md "Security posture"): only this
 * origin, plus the map tile host. MapLibre fetches the style, vector tiles, sprites and glyphs
 * (`connect-src`), may load raster or sprite images (`img-src`), runs its workers from `blob:`
 * URLs and applies inline styles.
 */
export function contentSecurityPolicy(tileHost: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${tileHost}`,
    "font-src 'self'",
    `connect-src 'self' ${tileHost}`,
    'worker-src blob:',
    'child-src blob:',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(tileHost: string): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy(tileHost),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

/**
 * The Content-Security-Policy for every response (architecture.md "Security posture"): only this
 * origin, plus the configured tile host for map data. MapLibre needs `blob:` workers, `data:`/
 * `blob:` images and inline styles.
 */
export function contentSecurityPolicy(tileHost: string | null): string {
  const tiles = tileHost ? ` ${tileHost}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${tiles}`,
    `font-src 'self'${tiles}`,
    `connect-src 'self'${tiles}`,
    'worker-src blob:',
    'child-src blob:',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(tileHost: string | null): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy(tileHost),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

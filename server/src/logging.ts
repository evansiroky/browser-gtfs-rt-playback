/** Where log lines go; anything with pino's destination `write(line)` shape. */
export interface LogDestination {
  write(line: string): void;
}

/**
 * Wraps a log destination so that every configured feed-URL fragment (see
 * `SecretUrl.secretFragments`) is replaced by `[redacted]` before the line is written. Code never
 * logs feed URLs on purpose; this is the backstop for anything that slips through (for example
 * an error message from a dependency).
 */
export function redactingDestination(
  secrets: readonly string[],
  target: LogDestination,
): LogDestination {
  // Longest first, so a full URL is replaced before any of its parts.
  const ordered = [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length);
  const variants = ordered.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]);
  return {
    write(line) {
      let out = line;
      for (const secret of variants) out = out.split(secret).join('[redacted]');
      target.write(out);
    },
  };
}

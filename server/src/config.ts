import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SecretUrl } from './secret-url.js';

const MiB = 1024 * 1024;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Retention can be lowered but never raised above one hour (configuration.md). */
export const RETENTION_CEILING_MS = 60 * MINUTE;

/** Longest delay Node timers support; larger values silently become 1 ms. */
export const MAX_DURATION_MS = 2_147_483_647;
/** Shortest accepted duration, so a typo cannot hammer a feed host. */
export const MIN_DURATION_MS = SECOND;

/** The keyless public tile provider the web app's map style uses (architecture.md). */
export const DEFAULT_TILE_HOST = 'https://tiles.openfreemap.org';

/**
 * The deployment's configuration, read once at startup (`specs/behaviors/configuration.md`).
 * Feed URLs are {@link SecretUrl}s, so serializing or logging a `Config` never exposes them.
 * Durations are milliseconds, sizes bytes.
 */
export interface Config {
  readonly scheduleUrl: SecretUrl;
  /** Null when not configured; at least one realtime feed is. */
  readonly vehiclePositionsUrl: SecretUrl | null;
  readonly tripUpdatesUrl: SecretUrl | null;
  readonly port: number;
  readonly pollIntervalMs: number;
  readonly realtimeTimeoutMs: number;
  readonly realtimeMaxBytes: number;
  readonly scheduleTimeoutMs: number;
  readonly scheduleMaxBytes: number;
  readonly scheduleMemoryLimitBytes: number;
  readonly idleTimeoutMs: number;
  readonly maxActivationMs: number;
  readonly exitOnIdle: boolean;
  /** Already clamped to {@link RETENTION_CEILING_MS}. */
  readonly retentionMs: number;
  readonly historyMemoryLimitBytes: number;
  readonly rateLimitPerMinute: number;
  /** Map tile origin allowed by the CSP (style, tiles, sprites and glyphs). */
  readonly tileHost: string;
  /** Directory of the built web app; served when it contains `index.html`. */
  readonly webDistDir: string;
  /** Non-fatal adjustments made while loading (no values included). */
  readonly warnings: readonly string[];
}

export type Env = Readonly<Record<string, string | undefined>>;

/** The configuration is unusable; the server must not start. The message never echoes values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Default web build location: `<repo>/web/dist`, relative to this module in `server/{src,dist}`. */
const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

/** Pure: reads only `env`. Throws {@link ConfigError} listing every problem found. */
export function loadConfig(env: Env): Config {
  const problems: string[] = [];
  const warnings: string[] = [];
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };

  const feedUrl = (name: string): SecretUrl | null => {
    const value = read(name);
    if (value === undefined) return null;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      problems.push(`${name} is not a valid URL`);
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      problems.push(`${name} must be an http or https URL`);
      return null;
    }
    if (url.username || url.password) {
      problems.push(
        `${name} must not carry credentials before the host; put them in the query string`,
      );
      return null;
    }
    return new SecretUrl(url);
  };

  const integer = (
    name: string,
    fallback: number,
    { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
  ) => {
    const value = read(name);
    if (value === undefined) return fallback;
    const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}`);
      return fallback;
    }
    return parsed;
  };

  const duration = (name: string, fallback: number) =>
    integer(name, fallback, { min: MIN_DURATION_MS, max: MAX_DURATION_MS });

  const boolean = (name: string, fallback: boolean): boolean => {
    const value = read(name)?.toLowerCase();
    if (value === undefined) return fallback;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    problems.push(`${name} must be true or false`);
    return fallback;
  };

  const scheduleUrl = feedUrl('SCHEDULE_URL');
  if (read('SCHEDULE_URL') === undefined) problems.push('SCHEDULE_URL is required');
  const vehiclePositionsUrl = feedUrl('VEHICLE_POSITIONS_URL');
  const tripUpdatesUrl = feedUrl('TRIP_UPDATES_URL');
  if (read('VEHICLE_POSITIONS_URL') === undefined && read('TRIP_UPDATES_URL') === undefined) {
    problems.push('at least one of VEHICLE_POSITIONS_URL and TRIP_UPDATES_URL is required');
  }

  let retentionMs = duration('RETENTION_MS', RETENTION_CEILING_MS);
  if (retentionMs > RETENTION_CEILING_MS) {
    warnings.push(`RETENTION_MS is above the 60-minute ceiling; using 60 minutes`);
    retentionMs = RETENTION_CEILING_MS;
  }

  const realtimeMaxBytes = integer('RT_MAX_BYTES', 25 * MiB);
  const historyMemoryLimitBytes = integer('HISTORY_MEMORY_LIMIT_BYTES', 512 * MiB);
  if (historyMemoryLimitBytes < 2 * realtimeMaxBytes) {
    problems.push('HISTORY_MEMORY_LIMIT_BYTES must be at least twice RT_MAX_BYTES');
  }

  // An origin only: scheme, host (optionally a leading `*.` wildcard) and port. The pattern has no
  // room for userinfo, a path, a query or a fragment.
  const tileHost = read('TILE_HOST') ?? DEFAULT_TILE_HOST;
  const tileHostPattern = /^https?:\/\/(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:\d{1,5})?\/?$/;
  if (!tileHostPattern.test(tileHost)) {
    problems.push('TILE_HOST must be an http(s) origin such as https://tiles.example.com');
  }

  const config = {
    scheduleUrl,
    vehiclePositionsUrl,
    tripUpdatesUrl,
    port: integer('PORT', 8080, { min: 0, max: 65535 }),
    pollIntervalMs: duration('POLL_INTERVAL_MS', 10 * SECOND),
    realtimeTimeoutMs: duration('RT_TIMEOUT_MS', 8 * SECOND),
    realtimeMaxBytes,
    scheduleTimeoutMs: duration('SCHEDULE_TIMEOUT_MS', 120 * SECOND),
    scheduleMaxBytes: integer('SCHEDULE_MAX_BYTES', 100 * MiB),
    scheduleMemoryLimitBytes: integer('SCHEDULE_MEMORY_LIMIT_BYTES', 768 * MiB),
    idleTimeoutMs: duration('IDLE_TIMEOUT_MS', 15 * MINUTE),
    maxActivationMs: duration('MAX_ACTIVATION_MS', 120 * MINUTE),
    exitOnIdle: boolean('EXIT_ON_IDLE', false),
    retentionMs,
    historyMemoryLimitBytes,
    rateLimitPerMinute: integer('RATE_LIMIT_PER_MIN', 120),
    tileHost: tileHost.replace(/\/$/, ''),
    webDistDir: path.resolve(read('WEB_DIST_DIR') ?? DEFAULT_WEB_DIST_DIR),
    warnings,
  };

  if (problems.length > 0 || !config.scheduleUrl) throw new ConfigError(problems);
  return Object.freeze({ ...config, scheduleUrl: config.scheduleUrl });
}

/** Every substring of every configured feed URL that must never be written to output. */
export function secretFragments(config: Config): string[] {
  return [config.scheduleUrl, config.vehiclePositionsUrl, config.tripUpdatesUrl].flatMap(
    (url) => url?.secretFragments() ?? [],
  );
}

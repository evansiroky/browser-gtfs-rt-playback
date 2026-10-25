import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, RETENTION_CEILING_MS, type Env } from './config.js';

const SECRET = 'https://feeds.example.test/vp?api_key=SUPERSECRET123';
const base: Env = {
  SCHEDULE_URL: 'https://feeds.example.test/gtfs.zip?token=ZIPTOKEN999',
  VEHICLE_POSITIONS_URL: SECRET,
  TRIP_UPDATES_URL: 'http://feeds.example.test/tu',
};

function problems(env: Env): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  throw new Error('expected loadConfig to refuse');
}

describe('loadConfig', () => {
  it('applies the defaults from configuration.md', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      port: 8080,
      pollIntervalMs: 10_000,
      realtimeTimeoutMs: 8_000,
      realtimeMaxBytes: 25 * 1024 * 1024,
      scheduleTimeoutMs: 120_000,
      scheduleMaxBytes: 100 * 1024 * 1024,
      scheduleMemoryLimitBytes: 768 * 1024 * 1024,
      idleTimeoutMs: 15 * 60_000,
      maxActivationMs: 2 * 60 * 60_000,
      exitOnIdle: false,
      retentionMs: 60 * 60_000,
      historyMemoryLimitBytes: 512 * 1024 * 1024,
      rateLimitPerMinute: 120,
      tileHost: null,
      warnings: [],
    });
    expect(config.vehiclePositionsUrl?.reveal().href).toBe(SECRET);
    expect(config.webDistDir).toMatch(/web[\\/]dist$/);
  });

  it('reads every tunable', () => {
    const config = loadConfig({
      ...base,
      PORT: '4123',
      POLL_INTERVAL_MS: '5000',
      RT_TIMEOUT_MS: '4000',
      RT_MAX_BYTES: '1000',
      SCHEDULE_TIMEOUT_MS: '9',
      SCHEDULE_MAX_BYTES: '10',
      SCHEDULE_MEMORY_LIMIT_BYTES: '11',
      IDLE_TIMEOUT_MS: '60000',
      MAX_ACTIVATION_MS: '120000',
      EXIT_ON_IDLE: 'true',
      RETENTION_MS: '600000',
      HISTORY_MEMORY_LIMIT_BYTES: '2000',
      RATE_LIMIT_PER_MIN: '7',
      TILE_HOST: 'https://tiles.example.test/',
      WEB_DIST_DIR: '/srv/web',
    });
    expect(config).toMatchObject({
      port: 4123,
      pollIntervalMs: 5000,
      realtimeTimeoutMs: 4000,
      realtimeMaxBytes: 1000,
      scheduleTimeoutMs: 9,
      scheduleMaxBytes: 10,
      scheduleMemoryLimitBytes: 11,
      idleTimeoutMs: 60000,
      maxActivationMs: 120000,
      exitOnIdle: true,
      retentionMs: 600000,
      historyMemoryLimitBytes: 2000,
      rateLimitPerMinute: 7,
      tileHost: 'https://tiles.example.test',
      webDistDir: '/srv/web',
    });
    expect(loadConfig({ ...base, EXIT_ON_IDLE: '0' }).exitOnIdle).toBe(false);
    expect(loadConfig({ ...base, TILE_HOST: 'https://*.tiles.example.test' }).tileHost).toBe(
      'https://*.tiles.example.test',
    );
  });

  it('clamps retention above 60 minutes to 60, with a warning', () => {
    const config = loadConfig({ ...base, RETENTION_MS: String(2 * RETENTION_CEILING_MS) });
    expect(config.retentionMs).toBe(RETENTION_CEILING_MS);
    expect(config.warnings).toHaveLength(1);
    expect(loadConfig({ ...base, RETENTION_MS: '60000' }).retentionMs).toBe(60_000);
  });

  it('works with only one realtime feed', () => {
    const vpOnly = loadConfig({ ...base, TRIP_UPDATES_URL: undefined });
    expect(vpOnly.vehiclePositionsUrl).not.toBeNull();
    expect(vpOnly.tripUpdatesUrl).toBeNull();
    const tuOnly = loadConfig({ ...base, VEHICLE_POSITIONS_URL: '  ' });
    expect(tuOnly.vehiclePositionsUrl).toBeNull();
    expect(tuOnly.tripUpdatesUrl).not.toBeNull();
  });

  it.each<[string, Env]>([
    ['missing schedule URL', { ...base, SCHEDULE_URL: undefined }],
    ['empty schedule URL', { ...base, SCHEDULE_URL: '' }],
    ['both realtime URLs missing', { SCHEDULE_URL: base.SCHEDULE_URL }],
    ['schedule URL not http(s)', { ...base, SCHEDULE_URL: 'ftp://feeds.example.test/gtfs.zip' }],
    ['vehicle positions URL not http(s)', { ...base, VEHICLE_POSITIONS_URL: 'file:///etc/passwd' }],
    ['trip updates URL unparsable', { ...base, TRIP_UPDATES_URL: 'not a url' }],
    ['non-numeric tunable', { ...base, POLL_INTERVAL_MS: 'ten' }],
    ['fractional tunable', { ...base, RT_TIMEOUT_MS: '1.5' }],
    ['zero tunable', { ...base, IDLE_TIMEOUT_MS: '0' }],
    ['negative tunable', { ...base, MAX_ACTIVATION_MS: '-1' }],
    ['port out of range', { ...base, PORT: '70000' }],
    ['bad boolean', { ...base, EXIT_ON_IDLE: 'yes' }],
    [
      'history limit below two responses',
      { ...base, RT_MAX_BYTES: '1000', HISTORY_MEMORY_LIMIT_BYTES: '1999' },
    ],
    ['tile host with a path', { ...base, TILE_HOST: 'https://tiles.example.test/styles/x' }],
    ['tile host without scheme', { ...base, TILE_HOST: 'tiles.example.test' }],
    ['zero rate limit', { ...base, RATE_LIMIT_PER_MIN: '0' }],
  ])('refuses to start: %s', (_name, env) => {
    expect(problems(env).length).toBeGreaterThan(0);
  });

  it('reports every problem at once, naming settings but never values', () => {
    const env = {
      SCHEDULE_URL: 'ftp://secret.example.test/?key=ZIPTOKEN999',
      VEHICLE_POSITIONS_URL: 'gopher://secret.example.test/?api_key=SUPERSECRET123',
      POLL_INTERVAL_MS: 'https://secret.example.test/?api_key=SUPERSECRET123',
    };
    let message = '';
    try {
      loadConfig(env);
    } catch (error) {
      message = String(error) + inspect(error);
    }
    expect(message).toContain('SCHEDULE_URL');
    expect(message).toContain('VEHICLE_POSITIONS_URL');
    expect(message).toContain('POLL_INTERVAL_MS');
    expect(message).not.toMatch(/secret\.example|SUPERSECRET123|ZIPTOKEN999/);
  });

  it('never exposes feed URLs when converted to text', () => {
    const config = loadConfig(base);
    const renderings = [
      String(config),
      `${config.vehiclePositionsUrl}`,
      JSON.stringify(config),
      inspect(config, { depth: Infinity, showHidden: true }),
      String(config.scheduleUrl),
    ];
    for (const text of renderings) {
      expect(text).not.toMatch(/feeds\.example\.test|SUPERSECRET123|ZIPTOKEN999|api_key/);
    }
    expect(JSON.parse(JSON.stringify(config)).vehiclePositionsUrl).toBe('[redacted]');
  });
});

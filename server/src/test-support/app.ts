import { vi } from 'vitest';
import { buildApp, type AppOptions } from '../app.js';
import { FakeClock } from '../clock.js';
import type { Env } from '../config.js';
import { testConfig } from './feeds.js';

/** Builds the real app with a fake clock, captured logs and a spy `exit`. */
export async function testApp<S = undefined>(env: Env = {}, options: Partial<AppOptions<S>> = {}) {
  const clock = new FakeClock();
  const logs: string[] = [];
  const exit = vi.fn();
  const built = await buildApp<S>({
    config: testConfig(env),
    clock,
    exit,
    logDestination: { write: (line) => void logs.push(line) },
    ...options,
  });
  return { ...built, clock, logs, exit };
}

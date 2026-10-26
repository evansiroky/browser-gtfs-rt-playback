import { defineConfig } from 'vitest/config';

// Each spec file boots its own fake feeds, server and browser; files run one after another so
// that the machine (and the one-minute alignment some checks need) is not shared.
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Polls wait for the server's own timers and the page's requests, never a fixed sleep.
    expect: { poll: { timeout: 20_000, interval: 100 } },
  },
});

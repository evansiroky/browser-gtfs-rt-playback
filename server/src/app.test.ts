import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiRoutes } from './http/api.js';
import { decodeFeed } from './realtime/snapshot-store.js';
import type { ScheduleProvider, ScheduleStatus } from './session/schedule-provider.js';
import { testApp } from './test-support/app.js';
import { encodeFeed } from './test-support/feeds.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Stand-ins for what later plans plug in: a schedule loader with a query API and a ping store. */
class Loader implements ScheduleProvider {
  readonly store = null;
  #state: ScheduleStatus = { state: 'idle', loadedAt: null, error: null };
  start() {
    this.#state = { state: 'ready', loadedAt: 1, error: null };
  }
  retry() {}
  discard() {
    this.#state = { state: 'idle', loadedAt: null, error: null };
  }
  status() {
    return this.#state;
  }
  trip(id: string) {
    return this.#state.state === 'ready' ? { tripId: id, headsign: 'Downtown' } : null;
  }
}

class PingCounter {
  seen = 0;
}

interface Services {
  loader: Loader;
  pings: PingCounter;
}

describe('buildApp extension points', () => {
  it('builds typed services once, uses one as the schedule provider, runs init, and hands both to routes', async () => {
    const built: string[] = [];
    const tripRoutes: ApiRoutes<Services> = (api, { services, guard }) => {
      api.get('/trip/:id', { preHandler: guard.requireSchedule }, async (request) =>
        services.loader.trip((request.params as { id: string }).id),
      );
      api.get('/pings', async () => ({ seen: services.pings.seen }));
    };
    const result = await testApp(
      {},
      {
        services: (deps) => {
          built.push(`services:${typeof deps.store.onSnapshot}`);
          return { loader: new Loader(), pings: new PingCounter() };
        },
        schedule: ({ services }) => services.loader,
        init: (context) => {
          built.push('init');
          context.store.onSnapshot(() => context.services.pings.seen++);
        },
        routes: [tripRoutes],
      },
    );
    app = result.app;
    expect(built).toEqual(['services:function', 'init']);
    expect(result.context.schedule).toBe(result.context.services.loader);

    expect((await app.inject({ url: '/api/v1/trip/t1' })).statusCode).toBe(409);
    await app.inject({ method: 'POST', url: '/api/v1/session/start' });
    expect((await app.inject({ url: '/api/v1/trip/t1' })).json()).toEqual({
      tripId: 't1',
      headsign: 'Downtown',
    });

    const bytes = encodeFeed();
    result.context.store.add('vehiclePositions', bytes, decodeFeed(bytes));
    expect((await app.inject({ url: '/api/v1/pings' })).json()).toEqual({ seen: 1 });
  });

  it('works without services (context.services is undefined)', async () => {
    const result = await testApp();
    app = result.app;
    expect(result.context.services).toBeUndefined();
  });
});

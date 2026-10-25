import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionStatus } from '@gtfs-rt-debugger/shared';
import { ApiError } from '@/api/client';
import { activeStatus, dormantStatus } from '@/test/fixtures';
import { FakeClock, flush } from '@/test/fake-clock';
import {
  ActivityController,
  IDLE_TIMEOUT_MS,
  PING_INTERVAL_MS,
  type SessionApi,
} from './activity-controller';

interface Call {
  kind: 'start' | 'ping';
  signal: AbortSignal;
  resolve(status: SessionStatus): Promise<void>;
  reject(error: unknown): Promise<void>;
}

class FakeApi implements SessionApi {
  calls: Call[] = [];

  start = (signal: AbortSignal) => this.record('start', signal);
  ping = (signal: AbortSignal) => this.record('ping', signal);

  get kinds(): string[] {
    return this.calls.map((call) => call.kind);
  }

  get last(): Call {
    return this.calls[this.calls.length - 1]!;
  }

  private record(kind: Call['kind'], signal: AbortSignal): Promise<SessionStatus> {
    return new Promise((resolve, reject) => {
      this.calls.push({
        kind,
        signal,
        resolve: async (status) => {
          resolve(status);
          await flush();
        },
        reject: async (error) => {
          reject(error);
          await flush();
        },
      });
    });
  }
}

const SEC = 1000;

let clock: FakeClock;
let api: FakeApi;

function make(options: { visible?: boolean } = {}) {
  const controller = new ActivityController({ api, clock, ...options });
  controller.start();
  return controller;
}

/** Starts a controller and answers its start so it is steadily engaged. */
async function engaged(status: SessionStatus = activeStatus()) {
  const controller = make();
  await api.last.resolve(status);
  expect(controller.getSnapshot().phase).toBe('engaged');
  return controller;
}

beforeEach(() => {
  clock = new FakeClock();
  api = new FakeApi();
});

describe('page load', () => {
  it('sends exactly one start immediately, then is engaged once it is answered', async () => {
    const controller = make();
    expect(api.kinds).toEqual(['start']);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'starting', status: null });

    await api.last.resolve(activeStatus());
    expect(controller.getSnapshot()).toMatchObject({ phase: 'engaged', error: null });
    expect(controller.getSnapshot().status).toEqual(activeStatus());
    expect(api.kinds).toEqual(['start']);
  });

  it('start() is idempotent while running', () => {
    const controller = make();
    controller.start();
    expect(api.kinds).toEqual(['start']);
  });

  it('retries a failed first start on the cadence (still a start, never a ping)', async () => {
    const controller = make();
    await api.last.reject(new ApiError('network', 'down'));
    expect(controller.getSnapshot()).toMatchObject({ phase: 'starting', status: null });
    expect(controller.getSnapshot().error).toBeInstanceOf(ApiError);

    clock.advance(PING_INTERVAL_MS);
    expect(api.kinds).toEqual(['start', 'start']);
    await api.last.resolve(activeStatus());
    expect(controller.getSnapshot()).toMatchObject({ phase: 'engaged', error: null });

    clock.advance(PING_INTERVAL_MS);
    expect(api.kinds).toEqual(['start', 'start', 'ping']);
  });

  it('a page loaded in a hidden tab sends nothing until it is shown, then starts (not pings)', async () => {
    const controller = make({ visible: false });
    expect(controller.getSnapshot().phase).toBe('paused-hidden');
    clock.advance(5 * IDLE_TIMEOUT_MS);
    expect(api.kinds).toEqual([]);

    controller.setVisible(true);
    expect(api.kinds).toEqual(['start']);
    expect(controller.getSnapshot().phase).toBe('starting');
    await api.last.resolve(activeStatus());
    clock.advance(PING_INTERVAL_MS);
    expect(api.kinds).toEqual(['start', 'ping']);
  });
});

describe('cadence while engaged', () => {
  it('pings every 10 s and not before', async () => {
    await engaged();
    clock.advance(PING_INTERVAL_MS - 1);
    expect(api.kinds).toEqual(['start']);
    clock.advance(1);
    expect(api.kinds).toEqual(['start', 'ping']);
    await api.last.resolve(activeStatus());
    clock.advance(PING_INTERVAL_MS);
    await api.last.resolve(activeStatus());
    clock.advance(PING_INTERVAL_MS);
    expect(api.kinds).toEqual(['start', 'ping', 'ping', 'ping']);
  });

  it('keeps the cadence while the person keeps interacting, indefinitely', async () => {
    const controller = await engaged();
    for (let i = 0; i < 30; i++) {
      clock.advance(PING_INTERVAL_MS);
      controller.noteInteraction();
      await api.last.resolve(activeStatus());
    }
    expect(controller.getSnapshot().phase).toBe('engaged');
    expect(api.kinds.filter((kind) => kind === 'ping')).toHaveLength(30);
  });

  it('does not stack a new ping on one that has not answered yet', async () => {
    await engaged();
    clock.advance(PING_INTERVAL_MS);
    expect(api.kinds).toEqual(['start', 'ping']);
    // The first ping hangs; two more ticks pass.
    clock.advance(PING_INTERVAL_MS);
    clock.advance(PING_INTERVAL_MS);
    expect(api.kinds).toEqual(['start', 'ping']);

    await api.last.resolve(activeStatus());
    clock.advance(PING_INTERVAL_MS);
    expect(api.kinds).toEqual(['start', 'ping', 'ping']);
  });

  it('keeps the last status when a ping fails, records the error, and pings again next tick', async () => {
    const controller = await engaged(activeStatus({ historyStartsAt: 123 }));
    const before = controller.getSnapshot();

    clock.advance(PING_INTERVAL_MS);
    await api.last.reject(new ApiError('http', 'boom', { status: 503 }));
    const failed = controller.getSnapshot();
    expect(failed.status).toBe(before.status);
    expect(failed.statusAt).toBe(before.statusAt);
    expect(failed.error).toBeInstanceOf(ApiError);
    expect(failed.phase).toBe('engaged');

    clock.advance(PING_INTERVAL_MS);
    expect(api.kinds).toEqual(['start', 'ping', 'ping']);
    await api.last.resolve(activeStatus({ historyStartsAt: 456 }));
    expect(controller.getSnapshot().error).toBeNull();
    expect(controller.getSnapshot().status?.historyStartsAt).toBe(456);
  });

  it('records when the status last arrived', async () => {
    const controller = make();
    clock.advance(3 * SEC);
    await api.last.resolve(activeStatus());
    expect(controller.getSnapshot().statusAt).toBe(3 * SEC);
  });
});

describe('hidden tab', () => {
  it('pauses immediately: cadence cancelled, in-flight ping aborted, nothing more is sent', async () => {
    const controller = await engaged();
    clock.advance(PING_INTERVAL_MS);
    const inFlight = api.last;
    expect(inFlight.kind).toBe('ping');

    controller.setVisible(false);
    expect(controller.getSnapshot().phase).toBe('paused-hidden');
    expect(inFlight.signal.aborted).toBe(true);

    clock.advance(10 * IDLE_TIMEOUT_MS);
    expect(api.kinds).toEqual(['start', 'ping']);
  });

  it('ignores a late answer from the aborted request', async () => {
    const controller = await engaged(activeStatus({ historyStartsAt: 1 }));
    clock.advance(PING_INTERVAL_MS);
    const inFlight = api.last;
    controller.setVisible(false);
    await inFlight.resolve(activeStatus({ historyStartsAt: 2 }));
    expect(controller.getSnapshot().status?.historyStartsAt).toBe(1);

    controller.setVisible(true);
    await inFlight.reject(new Error('late'));
    expect(controller.getSnapshot().error).toBeNull();
  });

  it('keeps the last data and status while paused', async () => {
    const controller = await engaged();
    const status = controller.getSnapshot().status;
    controller.setVisible(false);
    clock.advance(IDLE_TIMEOUT_MS * 3);
    expect(controller.getSnapshot().status).toBe(status);
  });

  it('showing the tab sends exactly one ping, not a start, and resumes the cadence', async () => {
    const controller = await engaged();
    controller.setVisible(false);
    clock.advance(5 * 60 * SEC);

    controller.setVisible(true);
    expect(api.kinds).toEqual(['start', 'ping']);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'engaged', resuming: true });

    // Interactions right after resuming do not add pings.
    controller.noteInteraction();
    controller.noteInteraction();
    expect(api.kinds).toEqual(['start', 'ping']);

    await api.last.resolve(activeStatus());
    expect(controller.getSnapshot().resuming).toBe(false);
    clock.advance(PING_INTERVAL_MS);
    expect(api.kinds).toEqual(['start', 'ping', 'ping']);
  });

  it('showing the tab counts as an interaction: the page is not instantly idle again', async () => {
    const controller = await engaged();
    controller.setVisible(false);
    clock.advance(10 * 60 * SEC);
    controller.setVisible(true);
    expect(controller.getSnapshot().phase).toBe('engaged');
    clock.advance(IDLE_TIMEOUT_MS - 1);
    expect(controller.getSnapshot().phase).toBe('engaged');
  });

  it('hiding takes precedence over idle in the phase', async () => {
    const controller = await engaged();
    clock.advance(IDLE_TIMEOUT_MS);
    expect(controller.getSnapshot().phase).toBe('paused-idle');
    controller.setVisible(false);
    expect(controller.getSnapshot().phase).toBe('paused-hidden');
  });

  it('repeated visibility events with the same value do nothing', async () => {
    const controller = await engaged();
    controller.setVisible(true);
    controller.setVisible(true);
    expect(api.kinds).toEqual(['start']);
  });
});

describe('60 seconds without interaction', () => {
  it('pauses at exactly 60 s and not a moment before', async () => {
    const controller = await engaged();
    clock.advance(IDLE_TIMEOUT_MS - 1);
    expect(controller.getSnapshot().phase).toBe('engaged');
    clock.advance(1);
    expect(controller.getSnapshot().phase).toBe('paused-idle');
  });

  it('pinged every 10 s until then, and not at all after', async () => {
    await engaged();
    for (let i = 0; i < 5; i++) {
      clock.advance(PING_INTERVAL_MS);
      await api.last.resolve(activeStatus());
    }
    expect(api.kinds).toEqual(['start', 'ping', 'ping', 'ping', 'ping', 'ping']);
    clock.advance(PING_INTERVAL_MS);
    expect(api.kinds).toHaveLength(6);
    clock.advance(10 * IDLE_TIMEOUT_MS);
    expect(api.kinds).toHaveLength(6);
  });

  it('aborts the ping in flight when the minute runs out', async () => {
    await engaged();
    clock.advance(IDLE_TIMEOUT_MS - 5 * SEC);
    clock.advance(5 * SEC - 1);
    // Ping fired at 60 s - 10 s = 50 s is still waiting.
    const inFlight = api.last;
    expect(inFlight.signal.aborted).toBe(false);
    clock.advance(1);
    expect(inFlight.signal.aborted).toBe(true);
  });

  it('an interaction postpones the deadline by a full minute from that interaction', async () => {
    const controller = await engaged();
    clock.advance(40 * SEC);
    controller.noteInteraction();
    clock.advance(IDLE_TIMEOUT_MS - 1);
    expect(controller.getSnapshot().phase).toBe('engaged');
    clock.advance(1);
    expect(controller.getSnapshot().phase).toBe('paused-idle');
  });

  it('the next interaction resumes with one ping (not a start), however many follow', async () => {
    const controller = await engaged();
    clock.advance(IDLE_TIMEOUT_MS);
    const sent = api.calls.length;

    controller.noteInteraction();
    controller.noteInteraction();
    controller.noteInteraction();
    expect(api.calls.length).toBe(sent + 1);
    expect(api.last.kind).toBe('ping');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'engaged', resuming: true });

    await api.last.resolve(activeStatus());
    clock.advance(PING_INTERVAL_MS);
    expect(api.last.kind).toBe('ping');
    expect(api.calls.length).toBe(sent + 2);
  });

  it('can pause again after resuming', async () => {
    const controller = await engaged();
    clock.advance(IDLE_TIMEOUT_MS);
    controller.noteInteraction();
    await api.last.resolve(activeStatus());
    clock.advance(IDLE_TIMEOUT_MS);
    expect(controller.getSnapshot().phase).toBe('paused-idle');
  });

  it('interactions on a hidden page are only remembered, they do not send', async () => {
    const controller = await engaged();
    controller.setVisible(false);
    controller.noteInteraction();
    expect(api.kinds).toEqual(['start']);
  });
});

describe('resuming', () => {
  it('while resuming, the failure of the ping still releases the data refetch', async () => {
    const controller = await engaged();
    controller.setVisible(false);
    controller.setVisible(true);
    expect(controller.getSnapshot().resuming).toBe(true);
    await api.last.reject(new ApiError('network', 'down'));
    expect(controller.getSnapshot()).toMatchObject({ resuming: false, phase: 'engaged' });
  });

  it('a resume before any start has succeeded sends a start', async () => {
    const controller = make();
    await api.last.reject(new ApiError('network', 'down'));
    controller.setVisible(false);
    controller.setVisible(true);
    expect(api.kinds).toEqual(['start', 'start']);
  });
});

describe('maximum duration', () => {
  const ended = dormantStatus('max-duration');

  it('a ping answered with dormant + max-duration ends the session and stops all sending', async () => {
    const controller = await engaged();
    clock.advance(PING_INTERVAL_MS);
    await api.last.resolve(ended);
    expect(controller.getSnapshot().phase).toBe('ended');
    expect(controller.getSnapshot().status).toEqual(ended);

    clock.advance(10 * IDLE_TIMEOUT_MS);
    expect(api.kinds).toEqual(['start', 'ping']);
    expect(clock.pendingTimers).toBe(0);
  });

  it('never auto-restarts, not even across hide/show and idle/interaction cycles', async () => {
    const controller = await engaged();
    clock.advance(PING_INTERVAL_MS);
    await api.last.resolve(ended);

    controller.setVisible(false);
    clock.advance(IDLE_TIMEOUT_MS);
    controller.setVisible(true);
    controller.noteInteraction();
    clock.advance(IDLE_TIMEOUT_MS * 2);
    controller.noteInteraction();
    controller.setVisible(false);
    controller.setVisible(true);

    expect(api.kinds).toEqual(['start', 'ping']);
    expect(controller.getSnapshot().phase).toBe('ended');
  });

  it('stays ended while hidden too (ended outranks paused)', async () => {
    const controller = await engaged();
    clock.advance(PING_INTERVAL_MS);
    await api.last.resolve(ended);
    controller.setVisible(false);
    expect(controller.getSnapshot().phase).toBe('ended');
  });

  it('Restart sends a start, and its success resumes the cadence without another request', async () => {
    const controller = await engaged();
    clock.advance(PING_INTERVAL_MS);
    await api.last.resolve(ended);

    controller.restart();
    expect(api.kinds).toEqual(['start', 'ping', 'start']);
    await api.last.resolve(activeStatus());
    expect(controller.getSnapshot()).toMatchObject({ phase: 'engaged', error: null });
    expect(api.kinds).toEqual(['start', 'ping', 'start']);

    clock.advance(PING_INTERVAL_MS - 1);
    expect(api.kinds).toHaveLength(3);
    clock.advance(1);
    expect(api.kinds).toEqual(['start', 'ping', 'start', 'ping']);
  });

  it('a failed Restart leaves the session ended, and Restart can be pressed again', async () => {
    const controller = await engaged();
    clock.advance(PING_INTERVAL_MS);
    await api.last.resolve(ended);

    controller.restart();
    await api.last.reject(new ApiError('network', 'down'));
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ended' });
    expect(controller.getSnapshot().error).toBeInstanceOf(ApiError);

    clock.advance(IDLE_TIMEOUT_MS);
    expect(api.kinds).toEqual(['start', 'ping', 'start']);
    controller.restart();
    expect(api.kinds).toEqual(['start', 'ping', 'start', 'start']);
  });

  it('only max-duration ends the session; a dormant status for another reason does not', async () => {
    const controller = await engaged();
    clock.advance(PING_INTERVAL_MS);
    await api.last.resolve(dormantStatus('idle'));
    expect(controller.getSnapshot().phase).toBe('engaged');
    clock.advance(PING_INTERVAL_MS);
    expect(api.kinds).toEqual(['start', 'ping', 'ping']);
  });
});

describe('restart / retry', () => {
  it('Retry while engaged sends a start (not a ping) and restarts the 10 s cadence', async () => {
    const controller = await engaged();
    clock.advance(6 * SEC);
    controller.restart();
    expect(api.kinds).toEqual(['start', 'start']);
    await api.last.resolve(activeStatus());

    clock.advance(PING_INTERVAL_MS - 1);
    expect(api.kinds).toHaveLength(2);
    clock.advance(1);
    expect(api.kinds).toEqual(['start', 'start', 'ping']);
  });

  it('replaces a request still in flight rather than stacking on it', async () => {
    const controller = await engaged();
    clock.advance(PING_INTERVAL_MS);
    const ping = api.last;
    controller.restart();
    expect(ping.signal.aborted).toBe(true);
    expect(api.kinds).toEqual(['start', 'ping', 'start']);
  });

  it('does nothing before start() and after stop()', () => {
    const controller = new ActivityController({ api, clock });
    controller.restart();
    expect(api.kinds).toEqual([]);
  });
});

describe('stop', () => {
  it('cancels timers and the in-flight request, and ignores later events', async () => {
    const controller = await engaged();
    clock.advance(PING_INTERVAL_MS);
    const inFlight = api.last;

    controller.stop();
    expect(inFlight.signal.aborted).toBe(true);
    expect(clock.pendingTimers).toBe(0);
    controller.noteInteraction();
    controller.setVisible(false);
    controller.setVisible(true);
    clock.advance(IDLE_TIMEOUT_MS);
    expect(api.calls).toHaveLength(2);
  });

  it('can be started again afterwards with a fresh start', async () => {
    const controller = await engaged();
    controller.stop();
    controller.start();
    expect(api.kinds).toEqual(['start', 'start']);
  });
});

describe('snapshots', () => {
  it('notifies subscribers on change only, and keeps the snapshot identity otherwise', async () => {
    const controller = make();
    const seen: string[] = [];
    const unsubscribe = controller.subscribe(() => seen.push(controller.getSnapshot().phase));
    await api.last.resolve(activeStatus());
    expect(seen).toEqual(['engaged']);

    const snapshot = controller.getSnapshot();
    controller.noteInteraction();
    controller.setVisible(true);
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(seen).toEqual(['engaged']);

    controller.setVisible(false);
    expect(seen).toEqual(['engaged', 'paused-hidden']);

    unsubscribe();
    controller.setVisible(true);
    expect(seen).toHaveLength(2);
  });
});

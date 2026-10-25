import type { Clock } from '@/session/activity-controller';

interface Timer {
  id: number;
  at: number;
  callback: () => void;
}

/** A hand-cranked clock: time only moves in `advance`, which runs due timers in order. */
export class FakeClock implements Clock {
  private time = 0;
  private nextId = 1;
  private timers: Timer[] = [];

  now = () => this.time;

  setTimeout = (callback: () => void, ms: number): number => {
    const timer = { id: this.nextId++, at: this.time + ms, callback };
    this.timers.push(timer);
    return timer.id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };

  get pendingTimers(): number {
    return this.timers.length;
  }

  /**
   * Time jumps to `ms` from now in one step (a slept laptop, a throttled background tab), and
   * only then do the overdue timers fire, in due order, each seeing the new time.
   */
  jump(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= this.time)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      due.callback();
    }
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = Math.max(this.time, due.at);
      due.callback();
    }
    this.time = target;
  }
}

/** Lets already-resolved promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

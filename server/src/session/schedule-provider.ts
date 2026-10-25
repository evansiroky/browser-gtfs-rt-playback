import type { SessionStatus } from '@gtfs-rt-debugger/shared';

export type ScheduleStatus = SessionStatus['schedule'];

/**
 * The schedule side of an activation, implemented by the schedule loader. The session manager
 * calls it; it never calls the session manager.
 *
 * - `start()` — an activation began: download the schedule (once per activation).
 * - `retry()` — a session start arrived while `status().state` is `failed`: load again.
 * - `discard()` — the activation ended: abort any in-flight load and drop all schedule data, so
 *   `status()` reports `idle` again.
 * - `status()` — the `schedule` block of `SessionStatus`, read on every status response.
 */
export interface ScheduleProvider {
  start(): void;
  retry(): void;
  discard(): void;
  status(): ScheduleStatus;
}

/** Default until a real provider is plugged in: never loads anything and always reports `idle`. */
export const noopScheduleProvider: ScheduleProvider = {
  start() {},
  retry() {},
  discard() {},
  status: () => ({ state: 'idle', loadedAt: null, error: null }),
};

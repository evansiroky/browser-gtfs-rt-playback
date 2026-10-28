// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activeStatus } from '@/test/fixtures';
import { FakeClock, flush } from '@/test/fake-clock';
import { ActivityController, IDLE_TIMEOUT_MS } from './activity-controller';
import { bindDomActivity, INTERACTION_THROTTLE_MS } from './dom-activity';

let clock: FakeClock;
let controller: ActivityController;
let unbind: () => void;
const noteInteraction = vi.fn();
const ping = vi.fn();

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  clock = new FakeClock();
  noteInteraction.mockReset();
  ping.mockReset().mockImplementation(() => Promise.resolve(activeStatus()));
  controller = new ActivityController({
    clock,
    api: { start: () => Promise.resolve(activeStatus()), ping },
  });
  const original = controller.noteInteraction.bind(controller);
  vi.spyOn(controller, 'noteInteraction').mockImplementation(() => {
    noteInteraction();
    original();
  });
  controller.start();
  await flush();
  unbind = bindDomActivity(controller, { clock });
  return () => {
    unbind();
    controller.stop();
  };
});

describe('bindDomActivity', () => {
  it('forwards every kind of interaction the spec lists', () => {
    const events: [EventTarget, string][] = [
      [window, 'pointermove'],
      [window, 'pointerdown'],
      [window, 'click'],
      [window, 'keydown'],
      [window, 'wheel'],
      [window, 'touchstart'],
      [window, 'touchmove'],
      [document.body, 'scroll'],
    ];
    for (const [target, type] of events) {
      clock.advance(INTERACTION_THROTTLE_MS);
      noteInteraction.mockClear();
      target.dispatchEvent(new Event(type, { bubbles: type !== 'scroll' }));
      expect(noteInteraction, type).toHaveBeenCalledOnce();
    }
  });

  it('throttles a burst of events to one per second', () => {
    for (let i = 0; i < 100; i++) window.dispatchEvent(new Event('pointermove'));
    expect(noteInteraction).toHaveBeenCalledOnce();
    clock.advance(INTERACTION_THROTTLE_MS - 1);
    window.dispatchEvent(new Event('pointermove'));
    expect(noteInteraction).toHaveBeenCalledOnce();
    clock.advance(1);
    window.dispatchEvent(new Event('pointermove'));
    expect(noteInteraction).toHaveBeenCalledTimes(2);
  });

  it('resumes an idle page on its first interaction with one ping', () => {
    window.dispatchEvent(new Event('pointermove'));
    clock.advance(IDLE_TIMEOUT_MS);
    expect(controller.getSnapshot().phase).toBe('paused-idle');
    ping.mockClear();

    window.dispatchEvent(new Event('keydown'));
    expect(controller.getSnapshot().phase).toBe('engaged');
    expect(ping).toHaveBeenCalledOnce();
  });

  it('registers passive, capturing listeners', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    bindDomActivity(controller, { clock })();
    for (const call of spy.mock.calls) {
      expect(call[2]).toMatchObject({ passive: true, capture: true });
    }
    expect(spy).toHaveBeenCalled();
  });

  it('follows document visibility', () => {
    setVisibility('hidden');
    expect(controller.getSnapshot().phase).toBe('paused-hidden');
    setVisibility('visible');
    expect(controller.getSnapshot().phase).toBe('engaged');
  });

  it('stops listening once unbound', () => {
    unbind();
    window.dispatchEvent(new Event('keydown'));
    setVisibility('hidden');
    expect(noteInteraction).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('engaged');
  });
});

import { systemClock, type ActivityController, type Clock } from './activity-controller';

/** Interactions closer together than this are collapsed; it is far below the 60 s idle limit. */
export const INTERACTION_THROTTLE_MS = 1_000;

const INTERACTION_EVENTS = [
  'pointermove',
  'pointerdown',
  'click',
  'keydown',
  'wheel',
  'touchstart',
  'touchmove',
  'scroll',
] as const;

/**
 * Feeds page visibility and user interaction into the controller. Listeners are passive and
 * capturing, so they also see events that map widgets or other handlers stop from bubbling and
 * scrolls of nested elements. Returns the unbind function.
 */
export function bindDomActivity(
  controller: ActivityController,
  options: { document?: Document; window?: Window; clock?: Clock } = {},
): () => void {
  const doc = options.document ?? document;
  const win = options.window ?? window;
  const clock = options.clock ?? systemClock;
  let lastForwardedAt = Number.NEGATIVE_INFINITY;

  const onInteraction = () => {
    const now = clock.now();
    if (now - lastForwardedAt < INTERACTION_THROTTLE_MS) return;
    lastForwardedAt = now;
    controller.noteInteraction();
  };
  const onVisibility = () => controller.setVisible(doc.visibilityState === 'visible');

  const listenerOptions = { passive: true, capture: true } as const;
  for (const type of INTERACTION_EVENTS) win.addEventListener(type, onInteraction, listenerOptions);
  doc.addEventListener('visibilitychange', onVisibility);
  onVisibility();

  return () => {
    for (const type of INTERACTION_EVENTS) {
      win.removeEventListener(type, onInteraction, listenerOptions);
    }
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}

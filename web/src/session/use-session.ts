import { useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import type { ActivitySnapshot } from './activity-controller';
import { SessionContext } from './session-context';

export interface SessionView extends ActivitySnapshot {
  /** The Restart / Retry actions: calls `POST /session/start`. */
  restart: () => void;
}

export function useSession(): SessionView {
  const controller = useContext(SessionContext);
  if (!controller) throw new Error('useSession must be used inside <SessionProvider>');

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const restart = useCallback(() => controller.restart(), [controller]);
  return useMemo(() => ({ ...snapshot, restart }), [snapshot, restart]);
}

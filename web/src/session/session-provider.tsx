import { useEffect, useState, type ReactNode } from 'react';
import { pingSession, startSession } from '@/api/client';
import { ActivityController } from './activity-controller';
import { bindDomActivity } from './dom-activity';
import { SessionContext } from './session-context';

function createController(): ActivityController {
  return new ActivityController({
    api: {
      start: (signal) => startSession(signal),
      ping: (signal) => pingSession(signal),
    },
    visible: document.visibilityState === 'visible',
  });
}

/**
 * Owns the page's one {@link ActivityController}: sends the start on mount and stops all
 * session traffic on unmount. A controller can be injected for tests.
 */
export function SessionProvider({
  controller: injected,
  children,
}: {
  controller?: ActivityController;
  children: ReactNode;
}) {
  const [controller] = useState(() => injected ?? createController());

  useEffect(() => {
    const unbind = bindDomActivity(controller);
    controller.start();
    return () => {
      unbind();
      controller.stop();
    };
  }, [controller]);

  return <SessionContext value={controller}>{children}</SessionContext>;
}

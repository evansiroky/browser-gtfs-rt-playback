import { QueryClient } from '@tanstack/react-query';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // Polling is driven by the session (see `pollWhileEngaged`), never by window focus.
      queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
    },
  });
}

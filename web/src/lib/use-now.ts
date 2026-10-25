import { useEffect, useState } from 'react';

/** Epoch seconds, refreshed every `intervalMs` so rendered ages keep advancing. */
export function useNowSeconds(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

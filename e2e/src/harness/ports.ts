import { createServer } from 'node:net';

/**
 * A free TCP port on loopback: the first one at or above `E2E_PORT_BASE` when that is set (to
 * keep runs inside a reserved range), otherwise whatever the OS offers.
 */
export async function freePort(): Promise<number> {
  const base = process.env.E2E_PORT_BASE ? Number(process.env.E2E_PORT_BASE) : null;
  for (let port = base ?? 0; port <= 65535; port++) {
    const bound = await tryListen(port);
    if (bound !== null) return bound;
    if (base === null) break;
  }
  throw new Error('no free port found');
}

function tryListen(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(null));
    probe.listen(port, '127.0.0.1', () => {
      const address = probe.address();
      const bound = typeof address === 'object' && address ? address.port : null;
      probe.close(() => resolve(bound));
    });
  });
}

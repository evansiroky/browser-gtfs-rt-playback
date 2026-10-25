import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const { app } = await buildApp({ config, exit: () => process.exit(0) });

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });

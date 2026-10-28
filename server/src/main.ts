import { dashboardRoutes } from './api/dashboard.js';
import { tripsRoutes } from './api/trips.js';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { ScheduleLoader } from './schedule/loader.js';
import { shapesRoutes, type ScheduleServices } from './schedule/routes.js';
import { closeThenExit, installCrashPolicy } from './shutdown.js';

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const { app } = await buildApp<ScheduleServices>({
  config,
  exit: () => process.exit(0),
  services: ({ config, clock, logger }) => ({
    loader: new ScheduleLoader({ config, clock, logger: logger.child({ component: 'schedule' }) }),
  }),
  schedule: ({ services }) => services.loader,
  routes: [shapesRoutes, dashboardRoutes, tripsRoutes],
});
installCrashPolicy(process, app.log, (code) => process.exit(code));

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  closeThenExit(app, () => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });

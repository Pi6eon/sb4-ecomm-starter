import { buildApp, buildMetricsApp } from './app.js';

const app = await buildApp();
const metricsApp = buildMetricsApp(app.metricsRegistry);
const port = Number(process.env.PORT ?? 3000);
const metricsPort = Number(process.env.METRICS_PORT ?? 3001);

try {
  await app.listen({ host: '0.0.0.0', port });
  await metricsApp.listen({ host: '0.0.0.0', port: metricsPort });
} catch (error) {
  await Promise.allSettled([app.close(), metricsApp.close()]);
  app.log.error(error, 'Unable to start BFF');
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  const shutdown = async (signal) => {
    try {
      await Promise.all([app.close(), metricsApp.close()]);
      app.log.info({ signal }, 'BFF shutdown complete');
    } catch (error) {
      app.log.error({ err: error, signal }, 'BFF shutdown failed');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

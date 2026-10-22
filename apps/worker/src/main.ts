import { ConnectorRuntime, buildRegistry } from '@pcp/connector-runtime';
import { createPrismaClient } from '@pcp/database';
import { postgresCheck, redisCheck } from '@pcp/health';
import { createQueues, reconcileSchedules, startProcessors } from '@pcp/jobs';
import { loadKeyRing } from '@pcp/secrets';
import { loadConfig } from './config.js';
import { createHealthServer } from './health-server.js';

const config = loadConfig(process.env);
const keyRing = loadKeyRing(process.env);
const prisma = createPrismaClient(config.databaseUrl);
const scheduler = createPrismaClient(config.schedulerDatabaseUrl);
const runtime = new ConnectorRuntime(prisma, await buildRegistry(process.env), keyRing);
const queues = createQueues(config.redisUrl);
const processors = startProcessors({ redisUrl: config.redisUrl, prisma, runtime });

// PostgreSQL holds the schedules; reconcile Redis at startup and periodically after config changes.
const reconcile = () =>
  reconcileSchedules(scheduler, queues).catch((err) =>
    console.error(`schedule reconcile failed: ${String(err)}`),
  );
await reconcile();
const timer = setInterval(reconcile, config.reconcileEverySeconds * 1000);

const server = createHealthServer({
  service: 'worker',
  deploymentMode: config.deploymentMode,
  checks: [postgresCheck(config.databaseUrl), redisCheck(config.redisUrl)],
});
server.listen(config.healthPort, '0.0.0.0');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    clearInterval(timer);
    server.close();
    await processors.close();
    await queues.close();
    await Promise.all([prisma.$disconnect(), scheduler.$disconnect()]);
    process.exit(0);
  });
}

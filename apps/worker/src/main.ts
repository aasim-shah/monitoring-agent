import { ConnectorRuntime, buildRegistry } from '@pcp/connector-runtime';
import { createPrismaClient } from '@pcp/database';
import { postgresCheck, redisCheck } from '@pcp/health';
import { createQueues, reconcileSchedules, startProcessors } from '@pcp/jobs';
import { loadKeyRing } from '@pcp/secrets';
import nodemailer from 'nodemailer';
import { authoritativeTxt, nodeDns } from '@pcp/website-probe';
import { alertingHandlers } from './alerting-handlers.js';
import { websiteProbeHandler } from './website-handler.js';
import { loadConfig } from './config.js';
import { createHealthServer } from './health-server.js';

const config = loadConfig(process.env);
const keyRing = loadKeyRing(process.env);
const prisma = createPrismaClient(config.databaseUrl);
const scheduler = createPrismaClient(config.schedulerDatabaseUrl);
const runtime = new ConnectorRuntime(prisma, await buildRegistry(process.env), keyRing);
const queues = createQueues(config.redisUrl);
const mailer = config.smtpUrl
  ? nodemailer.createTransport({
      url: config.smtpUrl,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    })
  : null;
const handlers = alertingHandlers({
  prisma,
  queues,
  keyRing: keyRing.ring,
  appOrigin: config.appOrigin,
  now: () => new Date(),
  sendMail: async (mail) => {
    // Without SMTP the delivery fails visibly (and dead-letters) instead of pretending to send.
    if (!mailer) throw new Error('SMTP_URL is not configured on the worker');
    await mailer.sendMail({ from: config.mailFrom, ...mail });
  },
});
const probeWebsite = websiteProbeHandler({
  prisma,
  now: () => new Date(),
  // The zone's own nameservers: a record added minutes ago is not hidden by resolver caches.
  resolveTxt: authoritativeTxt(nodeDns),
  // Public addresses only; the allowlist exists for test stacks (PCP_PROBE_ALLOWLIST).
  destination: config.probeAllowlist.length
    ? { allowPrivate: true, allowlist: config.probeAllowlist }
    : { allowPrivate: false },
  vmImportUrl: config.vmImportUrl,
});
const processors = startProcessors({
  redisUrl: config.redisUrl,
  prisma,
  runtime,
  handlers: { ...handlers, 'website-probe': (ctx, id) => probeWebsite(ctx, id) },
});

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

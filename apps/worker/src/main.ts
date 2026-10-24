import { providerFromConfig, scripted } from '@pcp/ai-orchestrator';
import { ConnectorRuntime, buildRegistry } from '@pcp/connector-runtime';
import { createPrismaClient } from '@pcp/database';
import { postgresCheck, redisCheck } from '@pcp/health';
import { createQueues, reconcileSchedules, startProcessors } from '@pcp/jobs';
import { loadKeyRing } from '@pcp/secrets';
import nodemailer from 'nodemailer';
import { authoritativeTxt, nodeDns } from '@pcp/website-probe';
import { alertingHandlers } from './alerting-handlers.js';
import { dispatchDueReports } from './report-dispatcher.js';
import { reauthorizationNotice } from './reauth-notice.js';
import { reportHandlers } from './report-handlers.js';
import { purgeDueTenants, tenantHandlers } from './tenant-handlers.js';
import { createReportSources } from './report-sources.js';
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
const delivery = {
  keyRing: keyRing.ring,
  appOrigin: config.appOrigin,
  now: () => new Date(),
  sendMail: async (mail: { to: string[]; subject: string; text: string; html: string }) => {
    // Without SMTP the delivery fails visibly (and dead-letters) instead of pretending to send.
    if (!mailer) throw new Error('SMTP_URL is not configured on the worker');
    await mailer.sendMail({ from: config.mailFrom, ...mail });
  },
};
const handlers = alertingHandlers({ prisma, queues, ...delivery });
const reports = reportHandlers({
  prisma,
  queues,
  now: () => new Date(),
  // The e2e stack's scripted narrator cites a section and states no numbers of its own.
  provider: config.ai.fake
    ? scripted('scripted', () => ({ text: 'The scripted summary covers this report day [S1].' }))
    : providerFromConfig(config.ai.providers),
  appOrigin: config.appOrigin,
  sources: createReportSources({ prisma, vmQueryUrl: config.vmQueryUrl }),
  delivery,
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
  handlers: {
    ...handlers,
    ...reports,
    ...tenantHandlers({ prisma, now: () => new Date() }),
    'website-probe': (ctx, id) => probeWebsite(ctx, id),
  },
  // A revoked Google grant: tell whoever connected it, and the owners, once (M13b).
  onReauthorizationRequired: reauthorizationNotice({ prisma, ...delivery }),
});

// PostgreSQL holds the schedules; reconcile Redis at startup and periodically after config changes.
const reconcile = () =>
  reconcileSchedules(scheduler, queues).catch((err) =>
    console.error(`schedule reconcile failed: ${String(err)}`),
  );
await reconcile();
const timer = setInterval(reconcile, config.reconcileEverySeconds * 1000);
// Daily reports (M15): due schedules every minute, through pcp_scheduler functions only.
const dispatch = () =>
  dispatchDueReports({ scheduler, prisma, queues, now: () => new Date() }).catch((err) =>
    console.error(`report dispatch failed: ${String(err)}`),
  );
await dispatch();
const reportTimer = setInterval(dispatch, 60_000);
// Tenant purge (M19.8): organizations past their 30-day grace, and expired export links, hourly.
const purge = () =>
  purgeDueTenants({ prisma, scheduler, now: () => new Date(), vmUrl: config.vmQueryUrl })
    .then(({ purged }) => purged.length && console.log(`purged organizations: ${purged.join(', ')}`))
    .catch((err) => console.error(`tenant purge failed: ${String(err)}`));
await purge();
const purgeTimer = setInterval(purge, 3_600_000);

const server = createHealthServer({
  service: 'worker',
  deploymentMode: config.deploymentMode,
  checks: [postgresCheck(config.databaseUrl), redisCheck(config.redisUrl)],
});
server.listen(config.healthPort, '0.0.0.0');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    clearInterval(timer);
    clearInterval(reportTimer);
    clearInterval(purgeTimer);
    server.close();
    await processors.close();
    await queues.close();
    await Promise.all([prisma.$disconnect(), scheduler.$disconnect()]);
    process.exit(0);
  });
}

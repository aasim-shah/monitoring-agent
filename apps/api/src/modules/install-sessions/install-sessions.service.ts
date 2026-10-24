import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import type { AppConfig } from '../../config.js';
import { ApiException, notFound } from '../../common/errors.js';
import { APP_CONFIG, CLOCK, INSTALLER_RUNNER, PRISMA } from '../../tokens.js';
import { EnrollmentsService } from '../agents/enrollments.service.js';
import { AuditService } from '../auditing/audit.service.js';
import type { InstallerRunner } from './runner.client.js';

/** A session lives at most 1 h (WB-05 UC-05-05); its token expires with it. */
const SESSION_MINUTES = 60;
const TERMINAL = ['installed', 'failed', 'aborted'];

export interface HostReport {
  organizationId: string;
  status: 'connecting' | 'awaiting_confirmation' | 'installing' | 'installed' | 'failed';
  fingerprint?: string;
  output?: string;
  scriptVersion?: string;
  cleanup?: 'done' | 'failed' | 'not_needed';
  error?: string;
}

const system = (organizationId: string): TenantContext => ({
  organizationId,
  actor: { kind: 'system', jobId: 'installer-runner' },
  roles: ['owner'],
  productIds: 'all',
  environmentIds: 'all',
  requestId: 'installer-runner',
});

/** The command the admin runs once per server to let the session's key in (key mode). */
export function setupCommand(publicKey: string): string {
  return [
    'sudo useradd -m -s /bin/bash pcp-install',
    "echo 'pcp-install ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/pcp-install >/dev/null",
    'sudo install -d -m 700 -o pcp-install -g pcp-install /home/pcp-install/.ssh',
    `echo '${publicKey}' | sudo tee /home/pcp-install/.ssh/authorized_keys >/dev/null`,
    'sudo chown pcp-install:pcp-install /home/pcp-install/.ssh/authorized_keys',
  ].join(' && ');
}

/**
 * Assisted SSH install (M17.3, spec §8.11): the API owns the session record and the audit trail;
 * the installer runner holds the key, any password, and the enrollment token in memory only.
 */
@Injectable()
export class InstallSessionsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(INSTALLER_RUNNER) private readonly runner: InstallerRunner,
    private readonly enrollments: EnrollmentsService,
    private readonly audit: AuditService,
  ) {}

  async create(
    ctx: TenantContext,
    environmentId: string,
    input: { mode: 'key' | 'password'; hosts: Array<{ host: string; port: number; username?: string }> },
  ) {
    if (input.mode === 'password' && input.hosts.some((h) => !h.username))
      throw new ApiException(400, 'username_required', 'Password mode needs the user name for each server');
    const enrollment = await this.enrollments.create(ctx, environmentId, {
      agentType: 'host',
      maxUses: input.hosts.length,
      expiresInMinutes: SESSION_MINUTES,
    });
    const expiresAt = new Date(this.now().getTime() + SESSION_MINUTES * 60_000);
    const session = await withTenant(this.prisma, ctx, async (tx) => {
      const env = await tx.environment.findUnique({
        where: { id: environmentId },
        select: { productId: true },
      });
      if (!env) throw notFound();
      const row = await tx.installSession.create({
        data: {
          organizationId: ctx.organizationId,
          productId: env.productId,
          environmentId,
          enrollmentId: enrollment.id,
          mode: input.mode,
          status: 'awaiting_key',
          createdByUserId: ctx.actor.kind === 'user' ? ctx.actor.userId : null,
          expiresAt,
          hosts: {
            create: input.hosts.map((h) => ({
              host: h.host,
              port: h.port,
              username: h.username ?? 'pcp-install',
              status: 'pending',
            })),
          },
        },
        include: { hosts: { orderBy: { host: 'asc' } } },
      });
      await this.audit.record(tx, ctx, {
        action: 'install_session.created',
        targetType: 'install_session',
        targetId: row.id,
        metadata: { mode: input.mode, hosts: input.hosts.map((h) => `${h.host}:${h.port}`) },
      });
      return row;
    });
    // Keep the request order for the response and the runner.
    const hosts = input.hosts.map((h) => session.hosts.find((x) => x.host === h.host && x.port === h.port)!);
    let publicKey = '';
    try {
      ({ publicKey } = await this.runner.create({
        sessionId: session.id,
        organizationId: ctx.organizationId,
        mode: input.mode,
        hosts: hosts.map((h) => ({ id: h.id, host: h.host, port: h.port, username: h.username })),
        install: enrollment.install,
        expiresAt: expiresAt.toISOString(),
      }));
    } catch (err) {
      await this.finish(ctx, session.id, 'failed');
      throw err;
    }
    return {
      id: session.id,
      mode: session.mode,
      status: session.status,
      expiresAt: session.expiresAt.toISOString(),
      publicKey: input.mode === 'key' ? publicKey : null,
      setupCommand: input.mode === 'key' ? setupCommand(publicKey) : null,
      egressIps: this.config.installer?.egressIps ?? [],
      hosts: hosts.map((h) => this.hostView(h)),
    };
  }

  async connect(ctx: TenantContext, id: string, password?: string) {
    const session = await this.load(ctx, id);
    this.assertOpen(session);
    if (session.mode === 'password' && !password)
      throw new ApiException(400, 'password_required', 'Enter the password for the servers');
    await withTenant(this.prisma, ctx, async (tx) => {
      await tx.installSession.update({ where: { id }, data: { status: 'connecting' } });
      await this.audit.record(tx, ctx, {
        action: 'install_session.connect',
        targetType: 'install_session',
        targetId: id,
      });
    });
    await this.runner.connect(id, session.mode === 'password' ? password : undefined);
  }

  async confirm(ctx: TenantContext, id: string, hostId: string, fingerprint: string) {
    const session = await this.load(ctx, id);
    this.assertOpen(session);
    const host = session.hosts.find((h) => h.id === hostId);
    if (!host) throw notFound();
    if (host.status !== 'awaiting_confirmation' || !host.fingerprint)
      throw new ApiException(409, 'not_connected', 'Connect to the server and check its fingerprint first');
    if (host.fingerprint !== fingerprint)
      throw new ApiException(409, 'fingerprint_mismatch', 'This is not the fingerprint the server presented');
    await withTenant(this.prisma, ctx, async (tx) => {
      await tx.installSessionHost.update({
        where: { id: hostId },
        data: { fingerprintConfirmedAt: this.now() },
      });
      await this.audit.record(tx, ctx, {
        action: 'install_session.fingerprint_confirmed',
        targetType: 'install_session',
        targetId: id,
        metadata: { host: `${host.host}:${host.port}`, fingerprint },
      });
    });
    await this.runner.confirm(id, hostId, fingerprint);
  }

  async get(ctx: TenantContext, id: string) {
    const s = await this.load(ctx, id);
    const expired = !TERMINAL.includes(s.status) && s.status !== 'completed' && s.expiresAt < this.now();
    return {
      id: s.id,
      mode: s.mode,
      status: expired ? 'expired' : s.status,
      expiresAt: s.expiresAt.toISOString(),
      egressIps: this.config.installer?.egressIps ?? [],
      hosts: s.hosts.map((h) => this.hostView(h)),
    };
  }

  async abort(ctx: TenantContext, id: string) {
    await this.load(ctx, id);
    await this.runner.abort(id);
    await this.finish(ctx, id, 'aborted');
  }

  /** The runner's progress for one host (internal route); the session status follows its hosts. */
  async report(sessionId: string, hostId: string, r: HostReport) {
    const ctx = system(r.organizationId);
    const done = await withTenant(this.prisma, ctx, async (tx) => {
      const host = await tx.installSessionHost.findFirst({ where: { id: hostId, sessionId } });
      if (!host || TERMINAL.includes(host.status)) return host ? null : undefined;
      await tx.installSessionHost.update({
        where: { id: hostId },
        data: {
          status: r.status,
          ...(r.fingerprint !== undefined ? { fingerprint: r.fingerprint } : {}),
          ...(r.output !== undefined ? { output: r.output.slice(0, 65_600) } : {}),
          ...(r.scriptVersion !== undefined ? { scriptVersion: r.scriptVersion } : {}),
          ...(r.cleanup !== undefined ? { cleanup: r.cleanup } : {}),
          ...(r.error !== undefined ? { error: r.error } : {}),
        },
      });
      if (TERMINAL.includes(r.status))
        await this.audit.record(tx, ctx, {
          action: 'install_session.host_finished',
          targetType: 'install_session',
          targetId: sessionId,
          metadata: {
            host: `${host.host}:${host.port}`,
            fingerprint: r.fingerprint ?? host.fingerprint,
            status: r.status,
            cleanup: r.cleanup ?? null,
            scriptVersion: r.scriptVersion ?? null,
          },
        });
      const hosts = await tx.installSessionHost.findMany({ where: { sessionId }, select: { status: true } });
      const status = sessionStatus(hosts.map((h) => h.status));
      await tx.installSession.update({ where: { id: sessionId }, data: { status } });
      return status === 'completed' || status === 'failed';
    });
    if (done === undefined) throw notFound();
    if (done) await this.revokeToken(ctx, sessionId);
  }

  private async finish(ctx: TenantContext, id: string, status: 'aborted' | 'failed') {
    await withTenant(this.prisma, ctx, async (tx) => {
      await tx.installSessionHost.updateMany({
        where: { sessionId: id, status: { notIn: TERMINAL } },
        data: { status: 'aborted' },
      });
      await tx.installSession.update({ where: { id }, data: { status } });
      if (status === 'aborted')
        await this.audit.record(tx, ctx, {
          action: 'install_session.aborted',
          targetType: 'install_session',
          targetId: id,
        });
    });
    await this.revokeToken(ctx, id);
  }

  /** A finished session's fleet token enrolls nothing more. */
  private async revokeToken(ctx: TenantContext, id: string) {
    await withTenant(this.prisma, ctx, async (tx) => {
      const s = await tx.installSession.findUnique({ where: { id }, select: { enrollmentId: true } });
      if (s?.enrollmentId)
        await tx.agentEnrollment.updateMany({
          where: { id: s.enrollmentId, revokedAt: null },
          data: { revokedAt: this.now() },
        });
    });
  }

  private async load(ctx: TenantContext, id: string) {
    const s = await withTenant(this.prisma, ctx, (tx) =>
      tx.installSession.findUnique({
        where: { id },
        include: { hosts: { orderBy: [{ host: 'asc' }, { port: 'asc' }] } },
      }),
    );
    if (!s) throw notFound();
    return s;
  }

  private assertOpen(s: { status: string; expiresAt: Date }) {
    if (['completed', 'failed', 'aborted'].includes(s.status) || s.expiresAt < this.now())
      throw new ApiException(409, 'install_session_closed', 'This session has ended; start a new one');
  }

  private hostView(h: {
    id: string;
    host: string;
    port: number;
    username: string;
    fingerprint: string | null;
    fingerprintConfirmedAt: Date | null;
    status: string;
    output: string;
    scriptVersion: string | null;
    cleanup: string | null;
    error: string | null;
  }) {
    return {
      id: h.id,
      host: h.host,
      port: h.port,
      username: h.username,
      fingerprint: h.fingerprint,
      fingerprintConfirmedAt: h.fingerprintConfirmedAt?.toISOString() ?? null,
      status: h.status,
      output: h.output,
      scriptVersion: h.scriptVersion,
      cleanup: h.cleanup,
      error: h.error,
    };
  }
}

/** A session is done when every host is; it failed if any host did not install. */
export function sessionStatus(hosts: string[]): string {
  if (hosts.every((s) => TERMINAL.includes(s)))
    return hosts.every((s) => s === 'installed') ? 'completed' : 'failed';
  if (hosts.some((s) => s === 'installing')) return 'installing';
  if (hosts.some((s) => s === 'awaiting_confirmation')) return 'awaiting_confirmation';
  return 'connecting';
}

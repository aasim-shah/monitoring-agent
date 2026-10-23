import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@pcp/database';
import {
  CONFIDENCE,
  completeRun,
  contradictEdge,
  ingestObservation,
  proposeEdge,
  startRun,
} from '@pcp/discovery-engine';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import type { Redis } from 'ioredis';
import { notFound } from '../../common/errors.js';
import { DNS_RESOLVER, PRISMA, REDIS } from '../../tokens.js';

export type DnsResolver = (hostname: string) => Promise<string[]>;

const DB_PROVIDERS = ['postgres', 'mysql', 'mongodb'];
/** Inventory pack → database connector provider (same engine). */
const PACK_ENGINE: Record<string, string> = { postgresql: 'postgres', mysql: 'mysql', mongodb: 'mongodb' };
const LOOPBACK = /^(127\.|::1$|localhost$)/;

interface InventoryService {
  pack: string;
  name: string;
  ports?: Array<{ address: string; port: number }>;
  processCount?: number;
}

/**
 * A discovery run for one product (WB-10 UC-10-01, UC-10-03): reconcile its sources into
 * assets, then evaluate the correlation rules that today's data supports.
 *
 * | Rule | Edge | Confidence |
 * |---|---|---|
 * | host-to-service | host HOSTS service (agent inventory) | 0.95 direct → verified |
 * | dns-to-host | website ROUTES_TO host (A/AAAA = agent egress IP) | 0.8 → proposed; drift when DNS moves |
 * | db-on-host | database DEPLOYED_ON host (connection host = host IP/hostname) | 0.8 → proposed |
 * | name-similarity | database DEPLOYED_ON host (only same-engine service in the product) | 0.3 → proposed |
 */
@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger('Discovery');

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(DNS_RESOLVER) private readonly resolve: DnsResolver,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Debounced background run (agent inventory, validated connections): at most one per product per minute. */
  trigger(ctx: TenantContext, productId: string): void {
    void this.redis
      .set(`discovery:debounce:${productId}`, '1', 'EX', 60, 'NX')
      .then((ok) => (ok ? this.run(ctx, productId) : undefined))
      .catch((err: Error) => this.logger.warn(`discovery for ${productId} failed: ${err.message}`));
  }

  async run(ctx: TenantContext, productId: string): Promise<{ assets: number; edges: number }> {
    const org = ctx.organizationId;
    const data = await withTenant(this.prisma, ctx, async (tx) => {
      const product = await tx.product.findUnique({ where: { id: productId }, select: { domains: true } });
      if (!product) throw notFound();
      const agents = await tx.agent.findMany({
        where: { productId, status: 'active' },
        include: { inventory: true, environment: { select: { name: true } } },
      });
      const connections = await tx.connection.findMany({
        where: {
          // Private (worker) and managed (Atlas, Supabase, …) databases alike.
          provider: { in: DB_PROVIDERS },
          status: { notIn: ['disconnected', 'revoked'] },
          scopes: { some: { productId } },
        },
      });
      return { domains: product.domains, agents, connections };
    });

    // DNS outside the transaction: lookups can take a while.
    const resolved = new Map<string, string[]>();
    for (const d of data.domains) resolved.set(d, await this.resolve(d).catch(() => []));

    return withTenant(this.prisma, ctx, async (tx) => {
      // One run per product at a time: a background run (agent inventory) and an on-demand
      // run would otherwise both create the same assets.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`discovery:${productId}`}))`;
      let edges = 0;
      const seen: Record<'agent' | 'connector' | 'product_config', string[]> = {
        agent: [],
        connector: [],
        product_config: [],
      };
      const runs = {
        agent: await startRun(tx, org, productId, 'agent'),
        connector: await startRun(tx, org, productId, 'connector'),
        product_config: await startRun(tx, org, productId, 'product_config'),
      };

      // Hosts and private workers (identity: the agent).
      const hosts: Array<{
        assetId: string;
        ip: string | null;
        hostname: string;
        services: Array<{ pack: string; assetId: string }>;
      }> = [];
      for (const a of data.agents) {
        const host = await ingestObservation(tx, org, {
          source: 'agent',
          assetType: a.agentType === 'private_worker' ? 'worker' : 'host',
          identity: { kind: 'stable', key: `agent:${a.id}` },
          name: a.hostname,
          attributes: {
            agentId: a.id,
            os: a.os,
            arch: a.arch,
            agentVersion: a.agentVersion,
            ip: a.lastSeenIp,
            environment: a.environment.name,
          },
          productId,
          environmentId: a.environmentId,
        });
        seen.agent.push(host.assetId);
        const entry = {
          assetId: host.assetId,
          ip: a.lastSeenIp,
          hostname: a.hostname,
          services: [] as Array<{ pack: string; assetId: string }>,
        };
        if (a.agentType === 'host') hosts.push(entry);
        // host-to-service: the agent saw the process listening (direct fact).
        for (const s of (a.inventory?.services ?? []) as unknown as InventoryService[]) {
          const svc = await ingestObservation(tx, org, {
            source: 'agent',
            assetType: 'service',
            identity: { kind: 'stable', key: `agent:${a.id}/${s.pack}` },
            name: s.name,
            attributes: {
              pack: s.pack,
              ports: s.ports ?? [],
              processCount: s.processCount ?? 0,
              hostAgentId: a.id,
            },
            productId,
            environmentId: a.environmentId,
          });
          seen.agent.push(svc.assetId);
          entry.services.push({ pack: s.pack, assetId: svc.assetId });
          await proposeEdge(tx, org, {
            source: host.assetId,
            target: svc.assetId,
            type: 'HOSTS',
            confidence: CONFIDENCE.directFact,
            evidenceKind: 'direct',
            direct: true,
            detail: { agentId: a.id, pack: s.pack, ports: s.ports ?? [] },
            ruleId: 'host-to-service',
          });
          edges++;
        }
      }

      // Private databases (identity: the connection).
      for (const c of data.connections) {
        const cfg = (c.config ?? {}) as Record<string, unknown>;
        const db = await ingestObservation(tx, org, {
          source: 'connector',
          assetType: 'database',
          identity: { kind: 'stable', key: `connection:${c.id}` },
          name: c.displayName,
          attributes: {
            engine: c.provider,
            host: cfg.host,
            port: cfg.port,
            database: cfg.database,
            connectionId: c.id,
            status: c.status,
            managed: c.executionLocation === 'cloud',
          },
          productId,
        });
        seen.connector.push(db.assetId);
        const dbHost = String(cfg.host ?? '');
        const byAddress = hosts.find(
          (h) => !LOOPBACK.test(dbHost) && (h.ip === dbHost || h.hostname === dbHost),
        );
        if (byAddress) {
          await proposeEdge(tx, org, {
            source: db.assetId,
            target: byAddress.assetId,
            type: 'DEPLOYED_ON',
            confidence: CONFIDENCE.ipMatch,
            evidenceKind: 'ip_match',
            direct: false,
            detail: { connectionHost: dbHost },
            ruleId: 'db-on-host',
          });
          edges++;
        } else {
          const sameEngine = hosts.filter((h) => h.services.some((s) => PACK_ENGINE[s.pack] === c.provider));
          if (sameEngine.length === 1) {
            await proposeEdge(tx, org, {
              source: db.assetId,
              target: sameEngine[0]!.assetId,
              type: 'DEPLOYED_ON',
              confidence: CONFIDENCE.nameOnly,
              evidenceKind: 'name',
              direct: false,
              detail: { reason: `the only ${c.provider} service in this product` },
              ruleId: 'name-similarity',
            });
            edges++;
          }
        }
      }

      // Websites from the product's domains, and dns-to-host.
      for (const domain of data.domains) {
        const site = await ingestObservation(tx, org, {
          source: 'product_config',
          assetType: 'website',
          identity: { kind: 'stable', key: `domain:${domain.toLowerCase()}` },
          name: domain,
          attributes: { addresses: resolved.get(domain) ?? [] },
          productId,
        });
        seen.product_config.push(site.assetId);
        const addresses = new Set(resolved.get(domain) ?? []);
        for (const h of hosts.filter((x) => x.ip && addresses.has(x.ip))) {
          await proposeEdge(tx, org, {
            source: site.assetId,
            target: h.assetId,
            type: 'ROUTES_TO',
            confidence: CONFIDENCE.ipMatch,
            evidenceKind: 'ip_match',
            direct: false,
            detail: { domain, ip: h.ip },
            ruleId: 'dns-to-host',
          });
          edges++;
        }
        // A verified route to a host the domain no longer resolves to has drifted (BR-10-04).
        const routes = await tx.assetRelationship.findMany({
          where: { sourceAssetId: site.assetId, relationshipType: 'ROUTES_TO', verification: 'verified' },
          include: { target: { select: { attributes: true } } },
        });
        for (const r of routes) {
          const ip = (r.target.attributes as Prisma.JsonObject | null)?.ip;
          if (typeof ip === 'string' && !addresses.has(ip))
            await contradictEdge(tx, org, r.id, {
              domain,
              resolvedTo: [...addresses],
              hostIp: ip,
              ruleId: 'dns-to-host',
            });
        }
      }

      for (const source of ['agent', 'connector', 'product_config'] as const)
        await completeRun(tx, org, runs[source], seen[source]);
      return { assets: seen.agent.length + seen.connector.length + seen.product_config.length, edges };
    });
  }
}

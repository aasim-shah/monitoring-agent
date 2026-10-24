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
/** Cloud connectors whose discovered inventory becomes assets (M7). */
const INVENTORY_PROVIDERS = ['cloudflare', 'github', 'prometheus'];
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
      const cloud = await tx.connection.findMany({
        where: {
          provider: { in: INVENTORY_PROVIDERS },
          status: { notIn: ['disconnected', 'revoked'] },
          scopes: { some: { productId } },
        },
        include: {
          scopes: { where: { productId }, select: { externalId: true } },
          inventory: { take: 5000 },
        },
      });
      return { domains: product.domains, agents, connections, cloud };
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

      // Connector inventory (M7): scoped zones, repositories, and Prometheus targets.
      for (const c of data.cloud) {
        const scoped = new Set(c.scopes.map((x) => x.externalId));
        const attrs = (i: { attributes: unknown }) => (i.attributes ?? {}) as Record<string, unknown>;
        if (c.provider === 'cloudflare') {
          for (const zone of c.inventory.filter(
            (i) => i.resourceType === 'cloudflare_zone' && scoped.has(i.externalId),
          )) {
            const records = c.inventory
              .filter((i) => i.resourceType === 'dns_record' && attrs(i).zoneId === zone.externalId)
              .map((i) => attrs(i));
            const domain = await ingestObservation(tx, org, {
              source: 'connector',
              assetType: 'domain',
              identity: { kind: 'stable', key: `cloudflare:zone:${zone.externalId}` },
              name: zone.name,
              attributes: {
                provider: 'cloudflare',
                connectionId: c.id,
                status: attrs(zone).status ?? null,
                records: records
                  .slice(0, 200)
                  .map((r) => ({ type: r.type, name: r.name, content: r.content, proxied: r.proxied })),
              },
              productId,
            });
            seen.connector.push(domain.assetId);
            for (const r of records.filter((x) => x.type === 'A' || x.type === 'AAAA')) {
              const host = hosts.find((h) => h.ip && h.ip === r.content);
              if (!host) continue;
              await proposeEdge(tx, org, {
                source: domain.assetId,
                target: host.assetId,
                type: 'ROUTES_TO',
                confidence: CONFIDENCE.ipMatch,
                evidenceKind: 'ip_match',
                direct: false,
                detail: { record: r.name, ip: r.content, provider: 'cloudflare' },
                ruleId: 'cloudflare-dns-to-host',
              });
              edges++;
            }
          }
        } else if (c.provider === 'github') {
          for (const repo of c.inventory.filter(
            (i) => i.resourceType === 'github_repository' && scoped.has(i.externalId),
          )) {
            const a = attrs(repo);
            const asset = await ingestObservation(tx, org, {
              source: 'connector',
              assetType: 'repository',
              identity: { kind: 'stable', key: `github:repo:${repo.externalId}` },
              name: repo.name,
              attributes: {
                provider: 'github',
                connectionId: c.id,
                defaultBranch: a.defaultBranch ?? null,
                visibility: a.visibility ?? null,
                url: a.url ?? null,
              },
              productId,
            });
            seen.connector.push(asset.assetId);
          }
        } else if (c.provider === 'prometheus') {
          for (const target of c.inventory.filter((i) => i.resourceType === 'prometheus_target')) {
            const a = attrs(target);
            const ip = typeof a.ip === 'string' ? a.ip : null;
            const hostname = typeof a.hostname === 'string' ? a.hostname : null;
            // The same machine as an agent host when the IP or hostname matches; never merged on a guess.
            const matched = hosts.find((h) => (ip && h.ip === ip) || (hostname && h.hostname === hostname));
            const hostId = matched
              ? matched.assetId
              : (
                  await ingestObservation(tx, org, {
                    source: 'connector',
                    assetType: 'host',
                    identity: {
                      kind: 'weak',
                      name: hostname ?? ip ?? String(a.instance),
                      ...(ip ? { ip } : {}),
                    },
                    name: hostname ?? ip ?? String(a.instance),
                    attributes: { provider: 'prometheus', instance: a.instance, ip },
                    productId,
                  })
                ).assetId;
            if (!matched) seen.connector.push(hostId);
            const job = String(a.job ?? 'unknown');
            const svc = await ingestObservation(tx, org, {
              source: 'connector',
              assetType: 'service',
              identity: { kind: 'stable', key: `prometheus:${c.id}:${job}:${String(a.instance)}` },
              name: job,
              attributes: {
                provider: 'prometheus',
                connectionId: c.id,
                instance: a.instance,
                health: a.health ?? null,
              },
              productId,
            });
            seen.connector.push(svc.assetId);
            await proposeEdge(tx, org, {
              source: hostId,
              target: svc.assetId,
              type: 'HOSTS',
              confidence: matched ? CONFIDENCE.ipMatch : CONFIDENCE.nameOnly,
              evidenceKind: matched ? 'ip_match' : 'name',
              direct: false,
              detail: { instance: a.instance, job, provider: 'prometheus' },
              ruleId: 'prometheus-target',
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

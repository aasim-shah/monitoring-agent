import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@pcp/database';
import type { TenantContext } from '@pcp/shared-contracts';
import { withTenant } from '@pcp/tenant-security';
import type { AppConfig } from '../../config.js';
import { ApiException } from '../../common/errors.js';
import { APP_CONFIG, CLOCK, PRISMA } from '../../tokens.js';

export const SEARCH_RANGES = { '1h': 3600, '6h': 6 * 3600, '24h': 86400, '7d': 7 * 86400 } as const;
export type SearchRange = keyof typeof SEARCH_RANGES;
const LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LogLine {
  time: string;
  message: string;
  agentId: string | null;
  service: string | null;
  level: string | null;
}

/**
 * Retained-log search (M18.1, BR-12-08): VictoriaLogs with the caller's tenant AccountID, and the
 * product (and agent) filter outside the user's own filter, which may not use pipes.
 */
@Injectable()
export class LogSearchService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  async search(
    ctx: TenantContext,
    productId: string,
    input: { query?: string; range?: string; agentId?: string },
  ) {
    if (!this.config.vlogsUrl)
      throw new ApiException(
        409,
        'retained_logs_unavailable',
        'Retained logs are not enabled on this platform',
      );
    const range = (input.range ?? '1h') as SearchRange;
    if (!(range in SEARCH_RANGES))
      throw new ApiException(
        400,
        'invalid_range',
        `range must be one of ${Object.keys(SEARCH_RANGES).join(', ')}`,
      );
    const userQuery = (input.query ?? '').trim() || '*';
    if (userQuery.includes('|') || userQuery.length > 1000)
      throw new ApiException(400, 'invalid_query', 'Use filters only (no pipes), at most 1000 characters');
    if (input.agentId && !UUID.test(input.agentId))
      throw new ApiException(400, 'invalid_agent', 'Invalid agent');
    const org = await withTenant(this.prisma, ctx, (tx) =>
      tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { logsAccountId: true } }),
    );
    const scope = [`product_id:="${productId}"`, ...(input.agentId ? [`agent_id:="${input.agentId}"`] : [])];
    const query = `${scope.join(' ')} (${userQuery}) | sort by (_time desc) | limit ${LIMIT}`;
    const end = this.now();
    const params = new URLSearchParams({
      query,
      start: new Date(end.getTime() - SEARCH_RANGES[range] * 1000).toISOString(),
      end: end.toISOString(),
    });
    let res: Response;
    try {
      res = await fetch(`${this.config.vlogsUrl}/select/logsql/query?${params}`, {
        headers: { AccountID: String(org?.logsAccountId ?? 0), ProjectID: '0' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ApiException(503, 'logs_unavailable', 'Log storage did not answer in time');
    }
    if (res.status === 400) throw new ApiException(400, 'invalid_query', (await res.text()).slice(0, 300));
    if (!res.ok) throw new ApiException(503, 'logs_unavailable', 'Log storage returned an error');
    const lines: LogLine[] = [];
    for (const raw of (await res.text()).split('\n')) {
      if (!raw.trim()) continue;
      const r = JSON.parse(raw) as Record<string, string>;
      lines.push({
        time: r._time ?? '',
        message: r._msg ?? '',
        agentId: r.agent_id ?? null,
        service: r.service ?? null,
        level: r.level ?? null,
      });
    }
    return { range, lines, truncated: lines.length >= LIMIT };
  }
}

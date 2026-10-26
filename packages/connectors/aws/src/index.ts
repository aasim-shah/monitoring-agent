import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { S3Client, ListBucketsCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import {
  AmplifyClient,
  ListAppsCommand,
  ListBranchesCommand,
  ListJobsCommand,
} from '@aws-sdk/client-amplify';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  ListMetricsCommand,
  type Statistic,
} from '@aws-sdk/client-cloudwatch';
import { ConnectorError, type Connector, type ExecutionContext, type MetricPoint } from '@pcp/connector-sdk';
import type { Observation } from '@pcp/shared-contracts';

export const AWS_RESOURCE_TYPES = ['aws_s3_bucket', 'aws_lambda_function', 'aws_amplify_branch'] as const;
/**
 * Only AWS APIs that cost nothing: listing calls, and CloudWatch GetMetricStatistics inside the free
 * tier. Cost Explorer ($0.01 a request) and GetMetricData (outside the free tier) are never called.
 */
const SERVICES = ['s3', 'lambda', 'amplify'] as const;
type Service = (typeof SERVICES)[number];
interface Config {
  roleArn: string;
  externalId: string;
  regions: string[];
  services: Service[];
}
/** Used both as a customer policy and an STS session ceiling. No object contents, secrets, or writes. */
export const AWS_READ_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: [
        's3:ListAllMyBuckets',
        's3:GetBucketLocation',
        'lambda:ListFunctions',
        'amplify:ListApps',
        'amplify:ListBranches',
        'amplify:ListJobs',
        'cloudwatch:GetMetricStatistics',
        'cloudwatch:ListMetrics',
      ],
      Resource: '*',
    },
  ],
};
const TIME_LIMIT_GAP = 'AWS time limit reached; remaining resources were skipped and retry on the next run';
const date = (d: Date) => d.toISOString().slice(0, 10);
const shift = (day: string, n: number) => date(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000));
const configErrors = (c: Record<string, unknown>) => {
  const errors: string[] = [];
  if (typeof c.roleArn !== 'string' || !/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(c.roleArn))
    errors.push('roleArn');
  if (
    !Array.isArray(c.regions) ||
    c.regions.length < 1 ||
    c.regions.length > 10 ||
    c.regions.some((r) => typeof r !== 'string' || !/^(us|eu|ap|sa|ca|me|af|il|mx)-(?:[a-z]+-)+\d$/.test(r))
  )
    errors.push('regions');
  if (
    !Array.isArray(c.services) ||
    !c.services.length ||
    c.services.some((s) => !SERVICES.includes(s as Service))
  )
    errors.push('services');
  if (typeof c.externalId !== 'string' || c.externalId.length < 16 || c.externalId.length > 128)
    errors.push('externalId');
  return errors;
};
function configuration(ctx: ExecutionContext): Config {
  if (configErrors(ctx.config).length)
    throw new ConnectorError('invalid_config', 'Invalid AWS role, external ID, regions, or services');
  return ctx.config as unknown as Config;
}
function failure(err: unknown): ConnectorError {
  const name = err instanceof Error ? err.name : '';
  if (/AccessDenied|Unauthorized|Forbidden/.test(name))
    return new ConnectorError(
      'permission_denied',
      'AWS denied this read operation; check the role policy and trust external ID',
    );
  if (/Throttl|LimitExceeded|TooManyRequests/.test(name))
    return new ConnectorError('rate_limited', 'AWS read quota exceeded');
  if (/ExpiredToken|InvalidClientToken|UnrecognizedClient/.test(name))
    return new ConnectorError('reauthorization_required', 'AWS credentials expired or were rejected');
  if (name === 'CredentialsProviderError')
    return new ConnectorError(
      'provider_unavailable',
      'The platform has no AWS credentials to assume your role; the operator must set them (docs/runbooks/aws-read-only.md)',
    );
  if (err instanceof ConnectorError) return err;
  return new ConnectorError('provider_unavailable', `AWS read failed (${name || 'unavailable'})`);
}

/** Official SDK clients use fixed AWS endpoints and the platform's default credential chain. */
export function createAwsConnector(options: { now?: () => Date } = {}): Connector {
  const now = options.now ?? (() => new Date());
  async function session(ctx: ExecutionContext) {
    const cfg = configuration(ctx);
    const base = {
      region: cfg.regions[0]!,
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
    };
    const signal = AbortSignal.timeout(Math.max(1, Math.min(60000, Date.parse(ctx.deadline) - Date.now())));
    const sts = new STSClient(base);
    let assumed;
    try {
      assumed = await sts.send(
        new AssumeRoleCommand({
          RoleArn: cfg.roleArn,
          ExternalId: cfg.externalId,
          RoleSessionName: `pcp-${ctx.connectionId}`.slice(0, 64),
          DurationSeconds: 900,
          Policy: JSON.stringify(AWS_READ_POLICY),
        }),
        { abortSignal: signal },
      );
    } catch (err) {
      throw failure(err);
    } finally {
      sts.destroy();
    }
    const c = assumed.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken)
      throw new ConnectorError('invalid_response', 'AWS returned no temporary role credentials');
    const credentials = {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
    };
    const clients: Array<{ destroy(): void }> = [];
    const settings = (region: string) => ({ ...base, region, credentials });
    const client = <T extends { destroy(): void }>(c: T): T => {
      clients.push(c);
      return c;
    };
    const account = cfg.roleArn.split(':')[4]!;
    return { cfg, account, signal, settings, client, close: () => clients.forEach((c) => c.destroy()) };
  }
  type Session = Awaited<ReturnType<typeof session>>;
  const observation = (
    ctx: ExecutionContext,
    type: string,
    id: string,
    name: string,
    region: string,
  ): Observation => ({
    connectionId: ctx.connectionId,
    source: 'provider_api',
    provider: 'aws',
    resourceType: type,
    externalId: id,
    attributes: { name, region, accountId: configuration(ctx).roleArn.split(':')[4], timeZone: 'UTC' },
    observedAt: now().toISOString(),
    method: 'aws_read_api',
    confidence: 1,
    evidence: { api: type },
  });
  /** After the deadline, remaining reads are skipped under one gap instead of one failure each. */
  async function guarded<T>(
    s: { signal: AbortSignal },
    label: string,
    gaps: string[],
    fn: () => Promise<T>,
  ): Promise<T | null> {
    if (s.signal.aborted) {
      gaps.push(TIME_LIMIT_GAP);
      return null;
    }
    try {
      return await fn();
    } catch (e) {
      gaps.push(s.signal.aborted ? TIME_LIMIT_GAP : `${label}: ${failure(e).message}`);
      return null;
    }
  }
  /** Bounded concurrency: sequential reads of many resources would exhaust the operation deadline. */
  async function each<T>(items: readonly T[], fn: (item: T) => Promise<unknown>, limit = 5) {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) await fn(items[next++]!);
      }),
    );
  }
  /** Bounded pagination: never silently publish an apparently complete truncated result. */
  async function pages<T>(fn: (token?: string) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    for (let i = 0; i < 100; i++) {
      const p = await fn(token);
      out.push(...p.items);
      if (!p.next) return out;
      if (p.next === token) throw new ConnectorError('invalid_response', 'AWS repeated a pagination token');
      token = p.next;
    }
    throw new ConnectorError(
      'provider_unavailable',
      'AWS pagination limit reached; narrow the connection scope',
    );
  }
  async function discover(ctx: ExecutionContext) {
    const s = await session(ctx);
    const observations: Observation[] = [];
    const gaps: string[] = [];
    try {
      if (s.cfg.services.includes('s3'))
        await guarded(s, 'S3 discovery', gaps, async () => {
          const api = s.client(new S3Client(s.settings(s.cfg.regions[0]!)));
          const buckets = await pages(async (token) => {
            const r = await api.send(new ListBucketsCommand({ ContinuationToken: token, MaxBuckets: 1000 }), {
              abortSignal: s.signal,
            });
            return { items: r.Buckets ?? [], next: r.ContinuationToken };
          });
          // ListBuckets reports each bucket's region; GetBucketLocation is only a fallback.
          await each(buckets, (b) =>
            b.Name
              ? guarded(s, `S3 ${b.Name}`, gaps, async () => {
                  let region = b.BucketRegion;
                  if (!region) {
                    const r = await api.send(
                      new GetBucketLocationCommand({ Bucket: b.Name, ExpectedBucketOwner: s.account }),
                      { abortSignal: s.signal },
                    );
                    region =
                      r.LocationConstraint === 'EU' ? 'eu-west-1' : r.LocationConstraint || 'us-east-1';
                  }
                  if (s.cfg.regions.includes(region))
                    observations.push(
                      observation(ctx, 'aws_s3_bucket', `arn:aws:s3:::${b.Name}`, b.Name!, region),
                    );
                })
              : Promise.resolve(),
          );
        });
      await each(s.cfg.regions, async (region) => {
        if (s.cfg.services.includes('lambda'))
          await guarded(s, `Lambda ${region}`, gaps, async () => {
            const api = s.client(new LambdaClient(s.settings(region)));
            const functions = await pages(async (token) => {
              const r = await api.send(new ListFunctionsCommand({ Marker: token, MaxItems: 50 }), {
                abortSignal: s.signal,
              });
              return { items: r.Functions ?? [], next: r.NextMarker };
            });
            for (const f of functions)
              if (f.FunctionArn && f.FunctionName)
                observations.push(
                  observation(
                    ctx,
                    'aws_lambda_function',
                    f.FunctionArn,
                    `${f.FunctionName} (${region})`,
                    region,
                  ),
                );
          });
        if (s.cfg.services.includes('amplify'))
          await guarded(s, `Amplify ${region}`, gaps, async () => {
            const api = s.client(new AmplifyClient(s.settings(region)));
            const apps = await pages(async (token) => {
              const r = await api.send(new ListAppsCommand({ nextToken: token, maxResults: 100 }), {
                abortSignal: s.signal,
              });
              return { items: r.apps ?? [], next: r.nextToken };
            });
            await each(apps, async (app) => {
              if (app.appId && app.appArn)
                await guarded(s, `Amplify ${app.appId} branches`, gaps, async () => {
                  const branches = await pages(async (token) => {
                    const r = await api.send(
                      new ListBranchesCommand({ appId: app.appId, nextToken: token, maxResults: 50 }),
                      { abortSignal: s.signal },
                    );
                    return { items: r.branches ?? [], next: r.nextToken };
                  });
                  for (const b of branches)
                    if (b.branchName)
                      observations.push(
                        observation(
                          ctx,
                          'aws_amplify_branch',
                          `${app.appArn}/branches/${b.branchName}`,
                          `${app.name ?? app.appId} / ${b.branchName} (${region})`,
                          region,
                        ),
                      );
                });
            });
          });
      });
      // DiscoveryPage has no gap field: preserve named gaps as a non-scopable inventory observation.
      if (gaps.length)
        observations.push({
          ...observation(ctx, 'aws_coverage', `aws-coverage:${s.account}`, 'AWS discovery gaps', 'global'),
          attributes: { name: 'AWS discovery gaps', gaps: [...new Set(gaps)] },
        });
      return { observations };
    } finally {
      s.close();
    }
  }
  /** One daily statistic per CloudWatch metric; days without a datapoint stay absent, never zero. */
  interface Query {
    id: string;
    namespace: string;
    metric: string;
    dimensions: Array<{ Name: string; Value: string }>;
    stat: Statistic;
  }
  async function metrics(
    s: Session,
    region: string,
    queries: Query[],
    scope: { resourceType: string; externalId: string },
    start: string,
    end: string,
  ): Promise<MetricPoint[]> {
    const api = s.client(new CloudWatchClient(s.settings(region)));
    const points: MetricPoint[] = [];
    for (const q of queries) {
      // A resource is published whole or not at all: the deadline skips it under one gap.
      if (s.signal.aborted) throw new ConnectorError('provider_unavailable', TIME_LIMIT_GAP);
      const r = await api.send(
        new GetMetricStatisticsCommand({
          Namespace: q.namespace,
          MetricName: q.metric,
          Dimensions: q.dimensions,
          StartTime: new Date(`${start}T00:00:00Z`),
          EndTime: new Date(`${end}T00:00:00Z`),
          Period: 86400,
          Statistics: [q.stat],
        }),
        { abortSignal: s.signal },
      );
      for (const d of r.Datapoints ?? []) {
        if (!d.Timestamp) continue;
        const value = d[q.stat];
        points.push({
          ...scope,
          metric: q.id,
          day: date(d.Timestamp),
          value: value !== undefined && Number.isFinite(value) ? value : null,
          completeness: date(d.Timestamp) >= date(now()) ? 'partial' : 'complete',
        });
      }
    }
    return points;
  }
  return {
    type: 'aws',
    version: '1.0.0',
    displayName: 'AWS',
    executionLocations: ['cloud'],
    credentialFields: [],
    capabilities: () => ['config_validation', 'validate', 'discover', 'health', 'sync'],
    configSchema: () => ({
      type: 'object',
      required: ['roleArn', 'regions', 'services'],
      properties: {
        roleArn: { type: 'string' },
        externalId: { type: 'string', readOnly: true },
        regions: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        services: { type: 'array', items: { enum: SERVICES } },
      },
    }),
    validateConfig: (c) => ({
      ok: configErrors(c as Record<string, unknown>).length === 0,
      errors: configErrors(c as Record<string, unknown>),
    }),
    async validate(ctx) {
      const s = await session(ctx);
      try {
        const api = s.client(new STSClient(s.settings(s.cfg.regions[0]!)));
        const id = await api.send(new GetCallerIdentityCommand({}), { abortSignal: s.signal });
        return { ok: id.Account === s.account, accountId: id.Account };
      } catch (e) {
        throw failure(e);
      } finally {
        s.close();
      }
    },
    async health(ctx) {
      const s = await session(ctx);
      s.close();
      return { ok: true };
    },
    discover,
    async sync(ctx, input) {
      const s = await session(ctx);
      const gaps: string[] = [];
      const points: MetricPoint[] = [];
      const today = date(now());
      const days = Math.max(1, Math.min(90, Math.floor(input.days)));
      const start = shift(today, 1 - days);
      const end = shift(today, 1);
      const query = (
        id: string,
        namespace: string,
        metric: string,
        dimensions: Array<{ Name: string; Value: string }>,
        stat: Statistic,
      ): Query => ({ id, namespace, metric, dimensions, stat });
      try {
        await each(input.scopes, (scope) =>
          guarded(s, scope.externalId, gaps, async () => {
            const id = scope.externalId;
            const arn = id.split(':');
            const region = arn[3]!;
            if (scope.resourceType === 'aws_lambda_function' && s.cfg.services.includes('lambda')) {
              if (
                arn[0] !== 'arn' ||
                arn[1] !== 'aws' ||
                arn[2] !== 'lambda' ||
                arn[4] !== s.account ||
                !s.cfg.regions.includes(region) ||
                !/^function:[\w-]+$/.test(arn.slice(5).join(':'))
              )
                throw new ConnectorError(
                  'invalid_config',
                  'Lambda scope is outside the configured account/regions',
                );
              const dims = [{ Name: 'FunctionName', Value: arn[6]! }];
              points.push(
                ...(await metrics(
                  s,
                  region,
                  [
                    query('invocations', 'AWS/Lambda', 'Invocations', dims, 'Sum'),
                    query('errors', 'AWS/Lambda', 'Errors', dims, 'Sum'),
                    query('throttles', 'AWS/Lambda', 'Throttles', dims, 'Sum'),
                    query('duration_max_ms', 'AWS/Lambda', 'Duration', dims, 'Maximum'),
                    query('concurrency_max', 'AWS/Lambda', 'ConcurrentExecutions', dims, 'Maximum'),
                  ],
                  scope,
                  start,
                  end,
                )),
              );
            } else if (scope.resourceType === 'aws_s3_bucket' && s.cfg.services.includes('s3')) {
              if (!/^arn:aws:s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(id))
                throw new ConnectorError('invalid_config', 'Invalid S3 scope');
              const bucket = id.slice('arn:aws:s3:::'.length);
              const api = s.client(new S3Client(s.settings(s.cfg.regions[0]!)));
              const location = await api.send(
                new GetBucketLocationCommand({ Bucket: bucket, ExpectedBucketOwner: s.account }),
                { abortSignal: s.signal },
              );
              const r =
                location.LocationConstraint === 'EU'
                  ? 'eu-west-1'
                  : location.LocationConstraint || 'us-east-1';
              if (!s.cfg.regions.includes(r))
                throw new ConnectorError('invalid_config', 'S3 bucket is outside selected regions');
              const cw = s.client(new CloudWatchClient(s.settings(r)));
              const storage = await pages(async (token) => {
                const result = await cw.send(
                  new ListMetricsCommand({
                    Namespace: 'AWS/S3',
                    MetricName: 'BucketSizeBytes',
                    Dimensions: [{ Name: 'BucketName', Value: bucket }],
                    NextToken: token,
                  }),
                  { abortSignal: s.signal },
                );
                return { items: result.Metrics ?? [], next: result.NextToken };
              });
              const types = [
                ...new Set(
                  storage.flatMap(
                    (m) =>
                      m.Dimensions?.filter((d) => d.Name === 'StorageType')
                        .map((d) => d.Value!)
                        .filter(Boolean) ?? [],
                  ),
                ),
              ];
              if (types.length > 100)
                throw new ConnectorError('provider_unavailable', 'S3 storage metric limit reached');
              const queries = types.map((t, i) =>
                query(
                  `storage_${i}`,
                  'AWS/S3',
                  'BucketSizeBytes',
                  [
                    { Name: 'BucketName', Value: bucket },
                    { Name: 'StorageType', Value: t },
                  ],
                  'Average',
                ),
              );
              queries.push(
                query(
                  'objects',
                  'AWS/S3',
                  'NumberOfObjects',
                  [
                    { Name: 'BucketName', Value: bucket },
                    { Name: 'StorageType', Value: 'AllStorageTypes' },
                  ],
                  'Average',
                ),
              );
              const rows = await metrics(s, r, queries, scope, start, end);
              points.push(...rows.filter((p) => p.metric === 'objects'));
              for (let i = 0; i < days; i++) {
                const day = shift(start, i);
                const values = rows.filter((p) => p.day === day && p.metric.startsWith('storage_'));
                if (types.length && values.length === types.length && values.every((v) => v.value !== null))
                  points.push({
                    ...scope,
                    metric: 'storage_bytes',
                    day,
                    value: values.reduce((sum, p) => sum + p.value!, 0),
                    completeness: day === today ? 'partial' : 'complete',
                  });
              }
            } else if (scope.resourceType === 'aws_amplify_branch' && s.cfg.services.includes('amplify')) {
              const match = /^arn:aws:amplify:([^:]+):(\d{12}):apps\/(d[a-z0-9]+)\/branches\/(.+)$/.exec(id);
              if (!match || match[2] !== s.account || !s.cfg.regions.includes(match[1]!))
                throw new ConnectorError(
                  'invalid_config',
                  'Amplify scope is outside the configured account/regions',
                );
              const api = s.client(new AmplifyClient(s.settings(match[1]!)));
              const jobs = await pages(async (token) => {
                const result = await api.send(
                  new ListJobsCommand({
                    appId: match[3],
                    branchName: match[4],
                    maxResults: 50,
                    nextToken: token,
                  }),
                  { abortSignal: s.signal },
                );
                const items = result.jobSummaries ?? [];
                // Jobs arrive newest first: stop once a page reaches builds older than the sync window,
                // so a long build history neither costs a full scan nor hits the pagination limit.
                const older = items.some((j) => j.startTime && date(j.startTime) < start);
                return { items, next: older ? undefined : result.nextToken };
              });
              for (let i = 0; i < days; i++) {
                const day = shift(start, i);
                const mine = jobs.filter((j) => j.startTime && date(j.startTime) === day);
                for (const [metric, status] of [
                  ['builds_succeeded', 'SUCCEED'],
                  ['builds_failed', 'FAILED'],
                ] as const)
                  points.push({
                    ...scope,
                    metric,
                    day,
                    value: mine.filter((j) => j.status === status).length,
                    completeness:
                      day === today ||
                      mine.some((j) => !['SUCCEED', 'FAILED', 'CANCELLED'].includes(j.status ?? ''))
                        ? 'partial'
                        : 'complete',
                  });
              }
            } else
              throw new ConnectorError('invalid_config', 'AWS resource service is disabled or unsupported');
          }),
        );
        return { points, gaps: [...new Set(gaps)] };
      } finally {
        s.close();
      }
    },
  };
}

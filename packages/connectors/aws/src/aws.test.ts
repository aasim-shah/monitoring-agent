import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { S3Client } from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { AmplifyClient } from '@aws-sdk/client-amplify';
import type { ExecutionContext } from '@pcp/connector-sdk';
import { createAwsConnector, AWS_READ_POLICY } from './index.js';
const mockSend = (prototype: object) =>
  vi.spyOn(prototype as { send(command: { input: unknown }): Promise<unknown> }, 'send');
const now = () => new Date('2026-10-26T12:00:00Z');
const ctx = (config: Record<string, unknown> = {}): ExecutionContext => ({
  authenticatedOrganizationId: 'org',
  connectionId: 'conn',
  executionLocation: 'cloud',
  requestId: 'req',
  deadline: new Date(Date.now() + 60000).toISOString(),
  credentials: async () => ({}),
  config: {
    roleArn: 'arn:aws:iam::123456789012:role/ReadOnly',
    externalId: 'server-generated-external-id',
    regions: ['us-east-1'],
    services: ['s3', 'lambda', 'amplify'],
    ...config,
  },
});
const connector = () => createAwsConnector({ now });
beforeEach(() => {
  vi.restoreAllMocks();
  mockSend(STSClient.prototype).mockImplementation(async (command) =>
    command instanceof AssumeRoleCommand
      ? {
          Credentials: {
            AccessKeyId: 'temporary',
            SecretAccessKey: 'temporary-secret',
            SessionToken: 'temporary-token',
          },
        }
      : { Account: '123456789012' },
  );
});
describe('AWS read-only boundaries', () => {
  it('assumes only the configured role with the external ID and a read session ceiling', async () => {
    await connector().validate(ctx());
    const call = vi.mocked(STSClient.prototype.send).mock.calls[0]![0] as AssumeRoleCommand;
    expect(call.input).toMatchObject({
      RoleArn: ctx().config.roleArn,
      ExternalId: ctx().config.externalId,
      Policy: JSON.stringify(AWS_READ_POLICY),
    });
    expect(connector().capabilities()).not.toContain('actions');
    expect(connector().executeAction).toBeUndefined();
    expect(AWS_READ_POLICY.Statement[0]!.Action.every((a) => /:(List|Get)/.test(a))).toBe(true);
    expect(JSON.stringify(AWS_READ_POLICY)).not.toMatch(
      /GetObject|GetFunction|Secret|Put|Update|Delete|Invoke/,
    );
    // Free APIs only: no Cost Explorer, no GetMetricData (outside the CloudWatch free tier).
    expect(JSON.stringify(AWS_READ_POLICY)).not.toMatch(/ce:|GetMetricData/);
  });
  it('says plainly when the platform itself has no AWS credentials to assume the role', async () => {
    vi.mocked(STSClient.prototype.send).mockRejectedValue(
      Object.assign(new Error('Could not load credentials from any providers'), {
        name: 'CredentialsProviderError',
      }),
    );
    await expect(connector().validate(ctx())).rejects.toMatchObject({
      reason: 'provider_unavailable',
      message: expect.stringContaining('platform has no AWS credentials'),
    });
  });
  it('rejects malformed region/role config and missing external IDs', () => {
    expect(connector().validateConfig!({ ...ctx().config, regions: ['http://localhost'] }).ok).toBe(false);
    expect(connector().validateConfig!({ ...ctx().config, externalId: '' }).ok).toBe(false);
  });
  it('never queries out-of-account or unselected-region Lambda scopes', async () => {
    const send = mockSend(CloudWatchClient.prototype);
    const result = await connector().sync!(ctx(), {
      days: 2,
      scopes: [
        {
          resourceType: 'aws_lambda_function',
          externalId: 'arn:aws:lambda:us-east-1:999999999999:function:secret',
        },
      ],
    });
    expect(send).not.toHaveBeenCalled();
    expect(result.points).toEqual([]);
    expect(result.gaps[0]).toContain('outside');
  });
  it('reads Lambda with the free GetMetricStatistics call and never substitutes zero for a missing day', async () => {
    const send = mockSend(CloudWatchClient.prototype).mockImplementation(async (command) => {
      const input = command.input as { MetricName: string; Statistics: string[] };
      return input.MetricName === 'Errors'
        ? { Datapoints: [{ Timestamp: new Date('2026-10-25T00:00:00Z'), Sum: 9 }] }
        : { Datapoints: [] };
    });
    const r = await connector().sync!(ctx(), {
      days: 2,
      scopes: [
        {
          resourceType: 'aws_lambda_function',
          externalId: 'arn:aws:lambda:us-east-1:123456789012:function:api',
        },
      ],
    });
    expect(send.mock.calls.every(([c]) => c instanceof GetMetricStatisticsCommand)).toBe(true);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      Namespace: 'AWS/Lambda',
      Dimensions: [{ Name: 'FunctionName', Value: 'api' }],
      Period: 86400,
    });
    expect(r.points).toEqual([
      expect.objectContaining({ metric: 'errors', day: '2026-10-25', value: 9, completeness: 'complete' }),
    ]);
  });
  it('does not offer costs: the costs service is rejected and Cost Explorer is never reached', async () => {
    expect(connector().validateConfig!({ ...ctx().config, services: ['costs'] }).ok).toBe(false);
    const r = await connector().sync!(ctx(), {
      days: 2,
      scopes: [{ resourceType: 'aws_cost_account', externalId: 'aws-cost:123456789012' }],
    });
    expect(r.points).toEqual([]);
    expect(r.gaps[0]).toContain('disabled or unsupported');
  });
});
describe('AWS discovery and daily sync', () => {
  it('paginates functions, scopes Amplify branches, and retains discovery denials', async () => {
    mockSend(S3Client.prototype).mockRejectedValue(
      Object.assign(new Error('sensitive provider message'), { name: 'AccessDenied' }),
    );
    const lambda = mockSend(LambdaClient.prototype)
      .mockResolvedValueOnce({
        Functions: [{ FunctionName: 'a', FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:a' }],
        NextMarker: 'next',
      })
      .mockResolvedValueOnce({
        Functions: [{ FunctionName: 'b', FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:b' }],
      });
    mockSend(AmplifyClient.prototype)
      .mockResolvedValueOnce({
        apps: [{ appId: 'dabc', appArn: 'arn:aws:amplify:us-east-1:123456789012:apps/dabc', name: 'web' }],
      })
      .mockResolvedValueOnce({ branches: [{ branchName: 'main' }] });
    const r = await connector().discover!(ctx());
    expect(lambda).toHaveBeenCalledTimes(2);
    expect(r.observations.some((o) => o.externalId?.endsWith('/branches/main'))).toBe(true);
    const coverage = r.observations.find((o) => o.resourceType === 'aws_coverage');
    expect(coverage?.attributes.gaps).toEqual([expect.stringContaining('S3 discovery:')]);
    expect(JSON.stringify(coverage)).not.toContain('sensitive provider message');
  });
  it('combines S3 storage classes only when every class has data and validates bucket ownership', async () => {
    const s3 = mockSend(S3Client.prototype).mockResolvedValue({ LocationConstraint: undefined });
    const cw = mockSend(CloudWatchClient.prototype)
      .mockResolvedValueOnce({
        Metrics: ['StandardStorage', 'StandardIAStorage'].map((Value) => ({
          Dimensions: [{ Name: 'StorageType', Value }],
        })),
      })
      .mockResolvedValueOnce({ Datapoints: [{ Timestamp: new Date('2026-10-25'), Average: 100 }] })
      .mockResolvedValueOnce({ Datapoints: [{ Timestamp: new Date('2026-10-25'), Average: 20 }] })
      .mockResolvedValueOnce({ Datapoints: [{ Timestamp: new Date('2026-10-25'), Average: 7 }] });
    const r = await connector().sync!(ctx(), {
      days: 2,
      scopes: [{ resourceType: 'aws_s3_bucket', externalId: 'arn:aws:s3:::bucket' }],
    });
    expect(s3.mock.calls[0]![0].input).toMatchObject({ ExpectedBucketOwner: '123456789012' });
    expect(cw).toHaveBeenCalledTimes(4);
    expect(r.points.find((p) => p.metric === 'storage_bytes')?.value).toBe(120);
    expect(r.points.filter((p) => p.day === '2026-10-26')).toEqual([]);
  });
  it('takes bucket regions from ListBuckets without a per-bucket location call', async () => {
    const s3 = mockSend(S3Client.prototype).mockResolvedValue({
      Buckets: [
        { Name: 'here', BucketRegion: 'us-east-1' },
        { Name: 'there', BucketRegion: 'eu-west-1' },
      ],
    });
    const r = await connector().discover!(ctx({ services: ['s3'] }));
    expect(s3).toHaveBeenCalledTimes(1);
    expect(r.observations.map((o) => o.externalId)).toEqual(['arn:aws:s3:::here']);
  });
  it('stops reading Amplify jobs once a page reaches builds older than the sync window', async () => {
    const amplify = mockSend(AmplifyClient.prototype)
      .mockResolvedValueOnce({
        jobSummaries: [
          { status: 'SUCCEED', startTime: new Date('2026-10-26T01:00:00Z') },
          { status: 'FAILED', startTime: new Date('2026-10-25T01:00:00Z') },
        ],
        nextToken: 'page-2',
      })
      .mockResolvedValueOnce({
        jobSummaries: [{ status: 'SUCCEED', startTime: new Date('2026-10-20T01:00:00Z') }],
        nextToken: 'page-3',
      });
    const r = await connector().sync!(ctx({ services: ['amplify'] }), {
      days: 2,
      scopes: [
        {
          resourceType: 'aws_amplify_branch',
          externalId: 'arn:aws:amplify:us-east-1:123456789012:apps/dabc/branches/main',
        },
      ],
    });
    expect(amplify).toHaveBeenCalledTimes(2);
    expect(r.gaps).toEqual([]);
    expect(r.points.find((p) => p.metric === 'builds_failed' && p.day === '2026-10-25')?.value).toBe(1);
  });
  it('skips remaining scopes under one gap once the deadline passes', async () => {
    mockSend(CloudWatchClient.prototype).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { Datapoints: [{ Timestamp: new Date('2026-10-25'), Sum: 1 }] };
    });
    const r = await connector().sync!(
      { ...ctx({ services: ['lambda'] }), deadline: new Date(Date.now() + 10).toISOString() },
      {
        days: 2,
        scopes: Array.from({ length: 8 }, (_, i) => ({
          resourceType: 'aws_lambda_function',
          externalId: `arn:aws:lambda:us-east-1:123456789012:function:f${i}`,
        })),
      },
    );
    expect(r.gaps).toEqual([expect.stringContaining('time limit reached')]);
    // A function cut off mid-read publishes nothing rather than half its metrics.
    expect(r.points).toEqual([]);
  });
  it('continues other scoped resources after one is denied', async () => {
    mockSend(S3Client.prototype).mockRejectedValue(Object.assign(new Error(), { name: 'AccessDenied' }));
    mockSend(CloudWatchClient.prototype).mockImplementation(async (command) =>
      (command.input as { MetricName: string }).MetricName === 'Errors'
        ? { Datapoints: [{ Timestamp: new Date('2026-10-25'), Sum: 2 }] }
        : { Datapoints: [] },
    );
    const r = await connector().sync!(ctx(), {
      days: 2,
      scopes: [
        { resourceType: 'aws_s3_bucket', externalId: 'arn:aws:s3:::denied' },
        {
          resourceType: 'aws_lambda_function',
          externalId: 'arn:aws:lambda:us-east-1:123456789012:function:api',
        },
      ],
    });
    expect(r.gaps).toHaveLength(1);
    expect(r.points[0]?.value).toBe(2);
  });
});

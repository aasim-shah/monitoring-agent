import type { KpiDefinition } from './kpis.js';
const definition = (
  resourceType: string,
  metric: string,
  label: string,
  unit: KpiDefinition['unit'],
  aggregation: KpiDefinition['aggregation'],
  caveats: string[] = [],
): KpiDefinition => ({
  key: `aws.${metric}`,
  resourceType,
  metric,
  label,
  unit,
  aggregation,
  definition: `${label}, from AWS read APIs for the selected resource.`,
  window: 'day',
  source:
    resourceType === 'aws_cost_account'
      ? 'AWS Cost Explorer'
      : resourceType === 'aws_amplify_branch'
        ? 'AWS Amplify'
        : 'AWS CloudWatch',
  population: 'aws_resource',
  timezone: 'UTC',
  caveats: ['Daily buckets use UTC, independently of the report timezone.', ...caveats],
});
export const AWS_KPI_DEFINITIONS: KpiDefinition[] = [
  definition('aws_s3_bucket', 'storage_bytes', 'Storage', 'bytes', 'latest', [
    'Daily S3 metrics can arrive late; includes versions, metadata, and incomplete uploads.',
  ]),
  definition('aws_s3_bucket', 'objects', 'Objects', 'count', 'latest', [
    'Includes versions and delete markers; not a sum across days.',
  ]),
  definition('aws_lambda_function', 'invocations', 'Invocations', 'count', 'sum'),
  definition('aws_lambda_function', 'errors', 'Errors', 'count', 'sum'),
  definition('aws_lambda_function', 'throttles', 'Throttles', 'count', 'sum'),
  definition('aws_lambda_function', 'duration_max_ms', 'Peak duration', 'ms', 'max'),
  definition('aws_lambda_function', 'concurrency_max', 'Peak concurrency', 'count', 'max'),
  definition('aws_amplify_branch', 'builds_succeeded', 'Successful builds', 'count', 'sum', [
    'Builds are grouped by start date; in-progress days remain partial.',
  ]),
  definition('aws_amplify_branch', 'builds_failed', 'Failed builds', 'count', 'sum'),
  definition('aws_cost_account', 'cost_usd', 'Unblended cost', 'USD', 'sum', [
    'Provisional billing data can change. Account-wide unless a cost allocation tag is configured; not an invoice or a savings estimate.',
  ]),
];

'use client';
import { useParams } from 'next/navigation';
import { KpiSources } from '@/components/analytics/kpi-page';
export default function AwsPage() {
  const { orgId, productId } = useParams<{ orgId: string; productId: string }>();
  return (
    <KpiSources
      orgId={orgId}
      productId={productId}
      title="AWS"
      provider="AWS"
      intro="Read-only S3, Lambda, and Amplify statistics from free AWS APIs. Days use UTC."
      resourceTypes={['aws_s3_bucket', 'aws_lambda_function', 'aws_amplify_branch']}
      chartKeys={{
        aws_s3_bucket: 'aws.storage_bytes',
        aws_lambda_function: 'aws.invocations',
        aws_amplify_branch: 'aws.builds_failed',
      }}
      emptyHint="buckets, functions, and Amplify branches"
    />
  );
}

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
      intro="Read-only S3, Lambda, Amplify, and cost statistics. Days use UTC. Costs are provisional and account-wide unless filtered by an activated allocation tag."
      resourceTypes={['aws_s3_bucket', 'aws_lambda_function', 'aws_amplify_branch', 'aws_cost_account']}
      chartKeys={{
        aws_s3_bucket: 'aws.storage_bytes',
        aws_lambda_function: 'aws.invocations',
        aws_amplify_branch: 'aws.builds_failed',
        aws_cost_account: 'aws.cost_usd',
      }}
      emptyHint="buckets, functions, Amplify branches, and billing accounts"
    />
  );
}

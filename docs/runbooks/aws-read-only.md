# AWS read-only integration

The first release supports S3 general-purpose bucket daily storage and object counts, Lambda daily invocations/errors/throttles/peak duration/peak concurrency, and Amplify branch build outcomes. It calls **free AWS APIs only**: listing calls (S3, Lambda, Amplify, STS) and CloudWatch `GetMetricStatistics`, which is inside the CloudWatch free tier of 1 million API requests a month. It never calls Cost Explorer ($0.01 a request) or `GetMetricData` (outside the free tier), so connecting an account adds no AWS charges in normal use.

## Platform setup

Run the API and worker with an AWS workload role whose policy permits `sts:AssumeRole` for the customer role ARNs. Both processes need credentials through the AWS SDK default credential chain. For local Docker only, `.env.example` documents platform AWS environment credentials. Customer access keys are never requested or stored. Give customers the platform's IAM role ARN for their trust policy. This release supports the commercial `aws` partition, up to ten explicitly selected regions per connection.

## Customer setup

1. Create a dedicated IAM role with the read policy below. Restrict resources further where the AWS action supports resource-level permissions. Omit service permissions for services you do not connect.
2. In a product's Integrations screen, choose AWS. Enter the role ARN, comma-separated regions, and desired services (`s3`, `lambda`, `amplify`).
3. Save. The API generates a unique external ID for this connection, ignoring caller-supplied values. Initial validation may fail until you complete the trust policy. Copy the external ID shown on the connection detail page.
4. Add a trust statement like the following, replacing the principal and external ID. Select **Validate now**, then discover resources and save the resources belonging to the product.
5. Open the product's AWS screen for daily charts and Reports & Schedules for AWS analysis in subsequent reports.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::PLATFORM_ACCOUNT_ID:role/PLATFORM_ROLE" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "sts:ExternalId": "GENERATED_CONNECTION_EXTERNAL_ID" } }
  }]
}
```

Customer role permissions (also applied as an inline STS session ceiling):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "s3:ListAllMyBuckets", "s3:GetBucketLocation",
      "lambda:ListFunctions",
      "amplify:ListApps", "amplify:ListBranches", "amplify:ListJobs",
      "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics"
    ],
    "Resource": "*"
  }]
}
```

The connector assumes a 15-minute session for each execution and destroys clients afterwards. Its capability list has no actions. It does not request S3 object contents, Lambda code, secrets, or logs, and does not create metric configurations, deploy applications, invoke functions, or change resources. AWS list responses are reduced to resource identifiers and names; environment variables and other configuration fields are never persisted, exposed in the UI, or sent to AI. Role access revocation or removing the connection stops future reads.

## Interpretation and limits

- All AWS points use UTC dates. Daily report AWS sections explicitly identify their own UTC date even when the enclosing report uses another timezone. They are not rebucketed into an arbitrary local day.
- Costs are not collected: every AWS billing API is charged per request. A free month-to-date figure (CloudWatch `AWS/Billing EstimatedCharges` through `GetMetricStatistics`) is possible later, but it needs "Receive CloudWatch billing alerts" turned on in the account's billing preferences.
- S3 storage and object counts are gauges: the range card uses the latest available daily observation. Storage sums published storage-type metrics; an incomplete set of daily samples is omitted. No-data days stay missing. Request/error metrics require a separately configured S3 metrics setup and are not collected in this release.
- Lambda charts show daily counts and daily maximum duration/concurrency; range cards use the maximum for peaks. Absent AWS samples remain missing, including zero-traffic days when AWS publishes nothing.
- Amplify builds are grouped by start date. Days with in-progress builds remain partial. Discovery stores only app/branch identifiers and names, never full app configuration.
- Sync runs hourly. The existing worker requests 28 days initially and revisits the latest 3 days on subsequent runs (the connector accepts up to 90 days). Build outcomes can be revised later. Reports retain their snapshots; regenerate to capture later revisions.
- Discovery pagination and requests are bounded; permission failures appear as named inventory coverage observations. Sync gaps are saved on the sync run and appear in AWS charts and report coverage. Other permitted services continue when one fails. Previously collected values can remain visible with stale/partial coverage after a failed read.
- Free-tier budget: each sync makes one `GetMetricStatistics` request per metric per resource (5 per Lambda function, 2 to 3 per bucket), about 3,600 a month per Lambda function with hourly syncs. The free tier is shared with any other CloudWatch API use in the account. This release does not install collectors or enable billable AWS metric streams.

## Validation

SDK-mocked tests cover the session ceiling, cross-account scope rejection, pagination, free-API-only reads (no Cost Explorer, no GetMetricData), missing days left missing, S3 ownership and storage classes, and per-resource failures. Report tests cover evidence-backed comparisons, provisional data, UTC labeling, and all delivery renderers. API integration tests cover generated external IDs and scoped persisted AWS KPIs. A live account smoke test is still required before rollout.

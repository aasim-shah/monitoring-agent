import { expect, it } from 'vitest';
import { aggregate, kpisFor } from './kpis.js';
it('uses the latest S3 gauge, maximum Lambda peak, and summed USD costs', () => {
  expect(aggregate(kpisFor('aws_s3_bucket')[0]!, [100, 120, null])).toBe(120);
  expect(
    aggregate(kpisFor('aws_lambda_function').find((d) => d.metric === 'duration_max_ms')!, [8, 2, null]),
  ).toBe(8);
  expect(aggregate(kpisFor('aws_cost_account')[0]!, [1.2, 2.3, null])).toBe(3.5);
  expect(aggregate(kpisFor('aws_cost_account')[0]!, [null])).toBeNull();
});

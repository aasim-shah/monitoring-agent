import { describe, expect, it } from 'vitest';
import { jobId } from './index.js';

describe('jobId', () => {
  it('is deterministic per kind, organization, entity, and window', () => {
    expect(jobId('connection-validate', 'org-1', 'conn-1')).toBe(
      jobId('connection-validate', 'org-1', 'conn-1'),
    );
    expect(jobId('connection-validate', 'org-1', 'conn-1', '2026-10-22')).not.toBe(
      jobId('connection-validate', 'org-1', 'conn-1'),
    );
    expect(jobId('connection-validate', 'org-1', 'conn-1')).not.toContain(':');
  });

  it('names one daily report per schedule and local date (WB-15 report:<org>:<schedule>:<localDate>)', () => {
    expect(jobId('report-generate', 'org-1', 'sched-1', '2026-10-25')).toBe(
      'report-generate__org-1__sched-1__2026-10-25',
    );
  });
});

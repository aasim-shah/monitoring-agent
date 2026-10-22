import { describe, expect, it } from 'vitest';
import { redactAttributes } from './redact.js';

describe('redactAttributes (BR-10-08, TC-10-08)', () => {
  it('redacts secret-looking keys and values, recursively', () => {
    expect(
      redactAttributes({
        hostname: 'vps-1',
        password: 'hunter2',
        apiToken: 'abc',
        nested: { dsn: 'postgres://app:s3cret@db:5432/app', note: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' },
        list: ['ok', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
        port: 5432,
      }),
    ).toEqual({
      hostname: 'vps-1',
      password: '[redacted]',
      apiToken: '[redacted]',
      nested: { dsn: 'postgres://app:[redacted]@db:5432/app', note: '[redacted]' },
      list: ['ok', '[redacted]'],
      port: 5432,
    });
  });
});

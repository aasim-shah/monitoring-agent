import type { ConnectionReason } from '@pcp/shared-contracts';

export type ConnectorErrorReason = ConnectionReason | 'invalid_config';

/** A provider failure with a diagnosable reason (spec §9.1), not a generic error. */
export class ConnectorError extends Error {
  readonly retryAfterSeconds?: number;

  constructor(
    readonly reason: ConnectorErrorReason,
    message: string,
    opts: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'ConnectorError';
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

import { ConnectorError, type ExecutionContext, type TemplateResult } from '@pcp/connector-sdk';

/** BR-07-04: at most 1,000 rows and 5 s per statement. */
export const MAX_ROWS = 1000;
export const STATEMENT_TIMEOUT_MS = 5000;
export const CONNECT_TIMEOUT_MS = 5000;

export interface DbConfig {
  host: string;
  port: number;
  database?: string;
  /** TLS to the database (default on). */
  tls: boolean;
  /** Verify the server certificate when TLS is on (default on). */
  tlsVerify: boolean;
  /** Plaintext on a private network, explicitly allowed (audited by the control plane). */
  allowInsecure: boolean;
  /** An admin acknowledged that this user can write (UC-07-06). */
  writeOverrideAcknowledged: boolean;
  /** Identifiers templates use (`{{table}}`, `{{column}}`, `{{collection}}`, `{{field}}`). */
  templateParams: Record<string, string>;
}

const invalid = (message: string) => new ConnectorError('invalid_config', message);

export function parseDbConfig(config: Record<string, unknown>, defaultPort: number): DbConfig {
  const host = config.host;
  if (typeof host !== 'string' || !/^[A-Za-z0-9.:_[\]-]{1,253}$/.test(host))
    throw invalid('host is required');
  const port = config.port === undefined ? defaultPort : Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('port must be 1-65535');
  const tls = config.tls !== false;
  const allowInsecure = config.allowInsecure === true;
  if (!tls && !allowInsecure)
    throw invalid('TLS is off; set allowInsecure to allow plaintext on a private network');
  const params = (config.templateParams ?? {}) as Record<string, unknown>;
  return {
    host,
    port,
    database: typeof config.database === 'string' && config.database ? config.database : undefined,
    tls,
    tlsVerify: config.tlsVerify !== false,
    allowInsecure,
    writeOverrideAcknowledged: config.writeOverrideAcknowledged === true,
    templateParams: Object.fromEntries(
      Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string'),
    ),
  };
}

export async function dbCredentials(ctx: ExecutionContext): Promise<{ username: string; password: string }> {
  const c = await ctx.credentials();
  if (!c.username) throw invalid('the secret file has no username');
  return { username: c.username, password: c.password ?? '' };
}

/** Fills `{{name}}` with quoted identifiers from config; a missing identifier is a config error. */
export function fillIdentifiers(
  query: string,
  params: Record<string, string>,
  quote: (s: string) => string,
): string {
  return query.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = params[name];
    if (!value) throw invalid(`template needs templateParams.${name}`);
    return quote(value);
  });
}

/** JSON-safe rows: bigint → number when safe else string, Date → ISO string, Buffer → length. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint')
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctor === 'ObjectId' || ctor === 'Decimal128' || ctor === 'Long') return String(value);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

export function capRows(rows: unknown[]): TemplateResult {
  return {
    rows: rows.slice(0, MAX_ROWS).map((r) => jsonSafe(r) as Record<string, unknown>),
    truncated: rows.length > MAX_ROWS,
  };
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EAI_AGAIN',
]);

/** Maps driver errors to diagnosable reasons (WB-07 §8: network vs TLS vs authentication vs database). */
export function classify(err: unknown, engine: string): ConnectorError {
  if (err instanceof ConnectorError) return err;
  const e = err as { code?: string | number; message?: string; errno?: number; codeName?: string };
  const message = (e.message ?? String(err)).slice(0, 500);
  const code = String(e.code ?? '');
  if (
    /does not support SSL|SSL connection is required|ssl.*not enabled|Server does not support secure connnection|server does not support TLS|SSL routines|wrong version number/i.test(
      message,
    )
  )
    return new ConnectorError(
      'tls_unavailable',
      `${engine}: TLS is required but the server does not offer it`,
    );
  if (
    NETWORK_CODES.has(code) ||
    (/timeout|timed out|ECONNREFUSED|getaddrinfo|connect ETIMEDOUT|Server selection timed out/i.test(
      message,
    ) &&
      !/statement timeout|canceling statement/i.test(message))
  )
    return new ConnectorError(
      'network_unreachable',
      `${engine}: cannot reach the database (${code || 'timeout'})`,
    );
  if (
    ['28P01', '28000', 'ER_ACCESS_DENIED_ERROR', '18'].includes(code) ||
    e.codeName === 'AuthenticationFailed' ||
    /authentication failed|Access denied for user/i.test(message)
  )
    return new ConnectorError('authentication_failed', `${engine}: authentication failed`);
  if (code === '25006' || /read-only transaction|READ ONLY transaction/i.test(message))
    return new ConnectorError('permission_denied', `${engine}: the read-only session refused a write`);
  if (
    ['42501', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', '13'].includes(code) ||
    e.codeName === 'Unauthorized'
  )
    return new ConnectorError('permission_denied', `${engine}: ${message}`);
  if (
    code === '57014' ||
    /maximum statement execution time|operation exceeded time limit|MaxTimeMSExpired/i.test(message)
  )
    return new ConnectorError(
      'provider_unavailable',
      `${engine}: query exceeded ${STATEMENT_TIMEOUT_MS / 1000} s`,
    );
  return new ConnectorError('provider_unavailable', `${engine}: ${message}`);
}

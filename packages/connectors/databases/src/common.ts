import { isIP } from 'node:net';
import {
  ConnectorError,
  assertPublicDestination,
  type ExecutionContext,
  type TemplateResult,
} from '@pcp/connector-sdk';

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

export interface DbCredentials {
  username: string;
  password: string;
  /** Present when the admin pasted a full connection string (managed databases). */
  connection?: ParsedConnection;
}

/** Credentials from the secret file (private) or the encrypted store (managed): a connection string or username/password. */
export async function dbCredentials(ctx: ExecutionContext): Promise<DbCredentials> {
  const c = await ctx.credentials();
  if (c.connectionString) {
    const connection = parseConnectionString(c.connectionString);
    return { username: connection.username, password: connection.password, connection };
  }
  if (!c.username) throw invalid('the credentials have no username');
  return { username: c.username, password: c.password ?? '' };
}

export interface ParsedConnection {
  engine: 'postgres' | 'mysql' | 'mongodb';
  host: string;
  port: number;
  database?: string;
  username: string;
  password: string;
  /** mongodb+srv: hosts come from DNS SRV records. */
  srv: boolean;
  /** The original URI (MongoDB keeps its options, e.g. replicaSet, authSource). */
  uri?: string;
}

const DEFAULT_PORT = { postgres: 5432, mysql: 3306, mongodb: 27017 } as const;

/** postgres(ql)://, mysql://, mongodb(+srv)://. The password never goes into config. */
export function parseConnectionString(uri: string): ParsedConnection {
  const scheme = /^([a-z+]+):\/\//i.exec(uri.trim())?.[1]?.toLowerCase();
  const engine =
    scheme === 'postgres' || scheme === 'postgresql'
      ? 'postgres'
      : scheme === 'mysql'
        ? 'mysql'
        : scheme === 'mongodb' || scheme === 'mongodb+srv'
          ? 'mongodb'
          : undefined;
  if (!engine)
    throw invalid('the connection string must start with postgres://, mysql://, or mongodb(+srv)://');
  const m = /^[a-z+]+:\/\/(?:([^:@/]*)(?::([^@]*))?@)?([^/?#]+)(?:\/([^?#]*))?/i.exec(uri.trim());
  if (!m) throw invalid('the connection string is not a valid URI');
  const decode = (v: string | undefined) => {
    try {
      return decodeURIComponent(v ?? '');
    } catch {
      return v ?? '';
    }
  };
  const first = m[3]!.split(',')[0]!;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(first);
  const [host, port] = bracketed
    ? [bracketed[1]!, bracketed[2]]
    : [first.replace(/:\d+$/, ''), /:(\d+)$/.exec(first)?.[1]];
  return {
    engine,
    host,
    port: port ? Number(port) : DEFAULT_PORT[engine],
    ...(m[4] ? { database: decode(m[4]) } : {}),
    username: decode(m[1]),
    password: decode(m[2]),
    srv: scheme === 'mongodb+srv',
    ...(engine === 'mongodb' ? { uri: uri.trim() } : {}),
  };
}

/**
 * Managed databases are reached from the control plane over the internet: TLS is
 * mandatory and the host must resolve to public addresses only (BR-07-06), so a
 * connection cannot be aimed at the platform's own private services. Returns the
 * vetted address to connect to (pinned: no second lookup).
 */
export async function targetAddress(
  ctx: ExecutionContext,
  cfg: DbConfig,
  host: string,
  port: number,
): Promise<string> {
  if (ctx.executionLocation !== 'cloud') return host;
  if (!cfg.tls) throw invalid('managed databases are reached over the internet: TLS is required');
  const url = new URL(`https://${isIP(host) === 6 ? `[${host}]` : host}:${port}/`);
  return (await assertPublicDestination(url, { allowPrivate: false })).address;
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

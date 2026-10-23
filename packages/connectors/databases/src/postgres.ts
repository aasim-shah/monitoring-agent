import {
  ConnectorError,
  defineTemplate,
  type Connector,
  type ExecutionContext,
  type ReadOnlyTemplate,
} from '@pcp/connector-sdk';
import { isIP } from 'node:net';
import pg from 'pg';
import {
  CONNECT_TIMEOUT_MS,
  MAX_ROWS,
  STATEMENT_TIMEOUT_MS,
  capRows,
  classify,
  dbCredentials,
  fillIdentifiers,
  jsonSafe,
  parseDbConfig,
  targetAddress,
} from './common.js';

export const POSTGRES_TEMPLATES: ReadOnlyTemplate[] = [
  defineTemplate({
    name: 'table_row_estimates',
    description: 'Estimated rows per table (from planner statistics; no table scans).',
    engine: 'postgres',
    query: `SELECT n.nspname AS "schema", c.relname AS "table", greatest(c.reltuples, 0)::bigint AS estimate
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            ORDER BY c.reltuples DESC`,
  }),
  defineTemplate({
    name: 'rows_created_per_day',
    description: 'Rows per day in a table by a timestamp column (e.g. signups per day).',
    engine: 'postgres',
    query: `SELECT date_trunc('day', {{column}}) AS day, count(*) AS count
            FROM {{table}} WHERE {{column}} >= $1 AND {{column}} < $2 GROUP BY 1 ORDER BY 1`,
  }),
];

const ENGINE = 'postgresql';

/** Opens a read-only session with a 5 s statement timeout (BR-07-03, BR-07-04). */
async function connect(ctx: ExecutionContext): Promise<pg.Client> {
  const cfg = parseDbConfig(ctx.config, 5432);
  const { username, password, connection } = await dbCredentials(ctx);
  const host = connection?.host ?? cfg.host;
  const port = connection?.port ?? cfg.port;
  const address = await targetAddress(ctx, cfg, host, port);
  const client = new pg.Client({
    host: address,
    port,
    database: connection?.database ?? cfg.database ?? 'postgres',
    user: username,
    password,
    // TLS follows config, never sslmode in a pasted string; SNI and verification use the hostname.
    ssl: cfg.tls ? { rejectUnauthorized: cfg.tlsVerify, ...(isIP(host) ? {} : { servername: host }) } : false,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS + 1000,
    application_name: 'pcp-monitor',
  });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    return client;
  } catch (err) {
    await client.end().catch(() => {});
    throw classify(err, ENGINE);
  }
}

async function withClient<T>(ctx: ExecutionContext, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = await connect(ctx);
  try {
    return await fn(client);
  } catch (err) {
    throw classify(err, ENGINE);
  } finally {
    await client.end().catch(() => {});
  }
}

const PRIVILEGES = `
  SELECT r.rolsuper AS superuser,
         has_database_privilege(current_database(), 'CREATE') AS db_create,
         EXISTS (SELECT 1 FROM pg_namespace n
                 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
                   AND has_schema_privilege(n.oid, 'CREATE')) AS schema_create,
         (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
                 OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))) AS writable_tables
  FROM pg_roles r WHERE r.rolname = current_user`;

export function createPostgresConnector(templates: ReadOnlyTemplate[] = POSTGRES_TEMPLATES): Connector {
  return {
    type: 'postgres',
    version: '1.0.0',
    displayName: 'PostgreSQL',
    executionLocations: ['private', 'cloud'],
    credentialFields: [
      { name: 'username', label: 'Username', secret: false },
      { name: 'password', label: 'Password', secret: true },
    ],
    templates,
    capabilities: () => ['config_validation', 'validate', 'health'],
    configSchema: () => DB_CONFIG_SCHEMA,
    validateConfig(config) {
      try {
        parseDbConfig(config as Record<string, unknown>, 5432);
        return { ok: true };
      } catch (e) {
        return { ok: false, errors: [(e as Error).message] };
      }
    },

    async validate(ctx) {
      const cfg = parseDbConfig(ctx.config, 5432);
      return withClient(ctx, async (c) => {
        const { rows } = await c.query(PRIVILEGES);
        const p = rows[0] as {
          superuser: boolean;
          db_create: boolean;
          schema_create: boolean;
          writable_tables: number;
        };
        const can = [
          p.superuser && 'is a superuser',
          p.db_create && 'can CREATE in the database',
          p.schema_create && 'can CREATE in a schema',
          p.writable_tables > 0 && `can write to ${p.writable_tables} table(s)`,
        ].filter(Boolean) as string[];
        if (can.length && !cfg.writeOverrideAcknowledged)
          throw new ConnectorError(
            'permission_denied',
            `the database user ${can.join(', ')}; use a read-only user`,
          );
        const { rows: who } = await c.query('SELECT current_user AS u, current_database() AS d');
        return {
          ok: true,
          accountId: `${who[0].u}@${cfg.host}/${who[0].d}`,
          ...(can.length ? { missingPermissions: [] } : {}),
        };
      });
    },

    async health(ctx) {
      return withClient(ctx, async (c) => {
        const { rows: s } = await c.query(`
          SELECT (SELECT sum(numbackends)::int FROM pg_stat_database) AS connections,
                 current_setting('max_connections')::int AS max_connections,
                 pg_is_in_recovery() AS standby,
                 CASE WHEN pg_is_in_recovery() THEN extract(epoch FROM now() - pg_last_xact_replay_timestamp())
                      ELSE (SELECT max(extract(epoch FROM replay_lag)) FROM pg_stat_replication) END AS lag,
                 current_setting('server_version') AS version`);
        const { rows: dbs } = await c.query(`
          SELECT datname AS name, pg_database_size(datname) AS bytes FROM pg_database
          WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT')
          ORDER BY 2 DESC LIMIT 50`);
        let slowQueries: unknown = 'extension not installed';
        try {
          const { rows: top } = await c.query(`
            SELECT left(query, 300) AS query, calls, round(total_exec_time::numeric, 1) AS total_ms,
                   round(mean_exec_time::numeric, 1) AS mean_ms
            FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10`);
          slowQueries = top.map(jsonSafe);
        } catch {
          // pg_stat_statements is optional (WB-07 §8).
        }
        const h = s[0];
        return {
          ok: true,
          data: {
            engine: ENGINE,
            version: h.version,
            connections: h.connections,
            maxConnections: h.max_connections,
            role: h.standby ? 'standby' : 'primary',
            replicationLagSeconds: h.lag === null ? null : Number(h.lag),
            databases: dbs.map((d) => ({ name: d.name, bytes: Number(d.bytes) })),
            slowQueries,
          },
        };
      });
    },

    async runTemplate(ctx, name, params) {
      const t = templates.find((x) => x.name === name);
      if (!t || t.engine !== 'postgres')
        throw new ConnectorError('invalid_config', `unknown template ${name}`);
      const cfg = parseDbConfig(ctx.config, 5432);
      return withClient(ctx, async (c) => {
        const body = fillIdentifiers(t.query, cfg.templateParams, (id) => c.escapeIdentifier(id)).replace(
          /;\s*$/,
          '',
        );
        // The CTE keeps the row cap in the database; the read-only session refuses any write.
        const sql = `WITH t AS (${body}) SELECT * FROM t LIMIT ${MAX_ROWS + 1}`;
        const { rows } = await c.query(sql, /\$1\b/.test(body) ? [params.from, params.to] : []);
        return capRows(rows);
      });
    },
  };
}

export const postgresConnector = createPostgresConnector();

export const DB_CONFIG_SCHEMA = {
  type: 'object',
  required: ['host'],
  additionalProperties: true,
  properties: {
    host: { type: 'string' },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    database: { type: 'string' },
    tls: { type: 'boolean', default: true },
    tlsVerify: { type: 'boolean', default: true },
    allowInsecure: { type: 'boolean', default: false },
    templateParams: { type: 'object', additionalProperties: { type: 'string' } },
  },
};

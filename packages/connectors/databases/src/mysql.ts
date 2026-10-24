import {
  ConnectorError,
  defineTemplate,
  type Connector,
  type ExecutionContext,
  type ReadOnlyTemplate,
} from '@pcp/connector-sdk';
import { isIP } from 'node:net';
import mysql from 'mysql2/promise';
import {
  CONNECT_TIMEOUT_MS,
  MAX_ROWS,
  STATEMENT_TIMEOUT_MS,
  capRows,
  classify,
  dbCredentials,
  fillIdentifiers,
  parseDbConfig,
  targetAddress,
} from './common.js';
import { DB_CONFIG_SCHEMA } from './postgres.js';

export const MYSQL_TEMPLATES: ReadOnlyTemplate[] = [
  defineTemplate({
    name: 'table_row_estimates',
    description: 'Estimated rows per table (information_schema statistics).',
    engine: 'mysql',
    query: `SELECT table_schema AS \`schema\`, table_name AS \`table\`, table_rows AS estimate
            FROM information_schema.TABLES
            WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema')
            ORDER BY table_rows DESC`,
  }),
  defineTemplate({
    name: 'rows_created_per_day',
    description: 'Rows per day in a table by a datetime column.',
    engine: 'mysql',
    query: `SELECT DATE({{column}}) AS day, COUNT(*) AS count FROM {{table}}
            WHERE {{column}} >= ? AND {{column}} < ? GROUP BY 1 ORDER BY 1`,
  }),
];

const ENGINE = 'mysql';
const quote = (id: string) => `\`${id.replace(/`/g, '``')}\``;

/** Privileges that can change data or schema. */
const WRITE_GRANTS =
  /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|TRIGGER|EXECUTE|EVENT|LOCK TABLES|FILE|SUPER|GRANT OPTION)\b/i;
const SYSTEM_SCHEMAS = /\bON\s+`?(information_schema|performance_schema|sys)`?\./i;

async function withConnection<T>(ctx: ExecutionContext, fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const cfg = parseDbConfig(ctx.config, 3306);
  const { username, password, connection } = await dbCredentials(ctx);
  const host = connection?.host ?? cfg.host;
  const port = connection?.port ?? cfg.port;
  let conn: mysql.Connection;
  try {
    const address = await targetAddress(ctx, cfg, host, port);
    conn = await mysql.createConnection({
      host: address,
      port,
      user: username,
      password,
      database: connection?.database ?? cfg.database,
      ssl: cfg.tls
        ? { rejectUnauthorized: cfg.tlsVerify, ...(isIP(host) ? {} : { servername: host }) }
        : undefined,
      connectTimeout: CONNECT_TIMEOUT_MS,
      dateStrings: false,
    });
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${STATEMENT_TIMEOUT_MS}`);
  } catch (err) {
    throw classify(err, ENGINE);
  }
  try {
    return await fn(conn);
  } catch (err) {
    throw classify(err, ENGINE);
  } finally {
    await conn.end().catch(() => {});
  }
}

export function createMysqlConnector(templates: ReadOnlyTemplate[] = MYSQL_TEMPLATES): Connector {
  return {
    type: 'mysql',
    version: '1.0.0',
    displayName: 'MySQL',
    executionLocations: ['private', 'cloud'],
    // A pasted connection string (managed databases) or username/password.
    credentialFields: [
      { name: 'connectionString', label: 'Connection string', secret: true, required: false },
      { name: 'username', label: 'Username', secret: false, required: false },
      { name: 'password', label: 'Password', secret: true, required: false },
    ],
    templates,
    capabilities: () => ['config_validation', 'validate', 'health'],
    configSchema: () => DB_CONFIG_SCHEMA,
    validateConfig(config) {
      try {
        parseDbConfig(config as Record<string, unknown>, 3306);
        return { ok: true };
      } catch (e) {
        return { ok: false, errors: [(e as Error).message] };
      }
    },

    async validate(ctx) {
      const cfg = parseDbConfig(ctx.config, 3306);
      return withConnection(ctx, async (c) => {
        const [grants] = (await c.query('SHOW GRANTS')) as unknown as [Array<Record<string, string>>];
        const writing = grants
          .map((g) => Object.values(g)[0] ?? '')
          .filter((g) => !SYSTEM_SCHEMAS.test(g))
          .map((g) => WRITE_GRANTS.exec(g.split(/\s+ON\s+/i)[0] ?? '')?.[1])
          .filter(Boolean) as string[];
        if (writing.length && !cfg.writeOverrideAcknowledged)
          throw new ConnectorError(
            'permission_denied',
            `the database user has ${[...new Set(writing.map((w) => w.toUpperCase()))].join(', ')}; use a read-only user`,
          );
        const [[who]] = (await c.query('SELECT CURRENT_USER() AS u')) as unknown as [[{ u: string }]];
        return { ok: true, accountId: `${who.u}/${cfg.database ?? ''}` };
      });
    },

    async health(ctx) {
      return withConnection(ctx, async (c) => {
        const [status] = (await c.query(
          "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected', 'Slow_queries', 'Uptime')",
        )) as unknown as [Array<{ Variable_name: string; Value: string }>];
        const s = Object.fromEntries(status.map((r) => [r.Variable_name, Number(r.Value)]));
        const [[vars]] = (await c.query(
          'SELECT @@max_connections AS max, @@version AS version',
        )) as unknown as [[{ max: number; version: string }]];
        let lag: number | null = null;
        try {
          const [replica] = (await c.query('SHOW REPLICA STATUS')) as unknown as [
            Array<Record<string, unknown>>,
          ];
          if (replica[0])
            lag = replica[0].Seconds_Behind_Source === null ? null : Number(replica[0].Seconds_Behind_Source);
        } catch {
          // Needs REPLICATION CLIENT; leave unknown.
        }
        const [schemas] = (await c.query(`
          SELECT table_schema AS name, COALESCE(SUM(data_length + index_length), 0) AS bytes
          FROM information_schema.TABLES
          WHERE table_schema NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema')
          GROUP BY table_schema ORDER BY bytes DESC LIMIT 50`)) as unknown as [
          Array<{ name: string; bytes: string }>,
        ];
        // Per-table estimates for the daily report (M15b); InnoDB's table_rows is approximate.
        const [tables] = (await c.query(`
          SELECT CONCAT(table_schema, '.', table_name) AS name, COALESCE(table_rows, 0) AS \`rows\`
          FROM information_schema.TABLES
          WHERE table_type = 'BASE TABLE'
            AND table_schema NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema')
          ORDER BY table_rows DESC, name LIMIT 50`)) as unknown as [Array<{ name: string; rows: string }>];
        return {
          ok: true,
          data: {
            engine: ENGINE,
            version: vars.version,
            connections: s.Threads_connected,
            maxConnections: Number(vars.max),
            replicationLagSeconds: lag,
            schemas: schemas.map((x) => ({ name: x.name, bytes: Number(x.bytes) })),
            tables: tables.map((t) => ({ name: t.name, rows: Number(t.rows) })),
            tablesApproximate: true,
            slowQueries: s.Slow_queries,
            uptimeSeconds: s.Uptime,
          },
        };
      });
    },

    async runTemplate(ctx, name, params) {
      const t = templates.find((x) => x.name === name);
      if (!t || t.engine !== 'mysql') throw new ConnectorError('invalid_config', `unknown template ${name}`);
      const cfg = parseDbConfig(ctx.config, 3306);
      return withConnection(ctx, async (c) => {
        const body = fillIdentifiers(t.query, cfg.templateParams, quote).replace(/;\s*$/, '');
        const args =
          (body.match(/\?/g) ?? []).length === 2 ? [new Date(params.from), new Date(params.to)] : [];
        const [rows] = (await c.query(
          `SELECT * FROM (${body}) AS t LIMIT ${MAX_ROWS + 1}`,
          args,
        )) as unknown as [unknown[]];
        return capRows(rows);
      });
    },
  };
}

export const mysqlConnector = createMysqlConnector();

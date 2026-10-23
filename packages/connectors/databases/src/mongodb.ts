import {
  ConnectorError,
  defineTemplate,
  type Connector,
  type ExecutionContext,
  type ReadOnlyTemplate,
} from '@pcp/connector-sdk';
import { resolveSrv } from 'node:dns/promises';
import { MongoClient, type Document } from 'mongodb';
import {
  CONNECT_TIMEOUT_MS,
  MAX_ROWS,
  STATEMENT_TIMEOUT_MS,
  capRows,
  classify,
  dbCredentials,
  parseDbConfig,
  targetAddress,
  type ParsedConnection,
} from './common.js';
import { DB_CONFIG_SCHEMA } from './postgres.js';

/** `{{field}}` → field name, `${{field}}` → `$field`, `$$from`/`$$to` → the window bounds. */
export const MONGODB_TEMPLATES: ReadOnlyTemplate[] = [
  defineTemplate({
    name: 'documents_per_day',
    description: 'Documents per day in a collection by a date field (e.g. incidents per day).',
    engine: 'mongodb',
    pipeline: [
      { $match: { '{{field}}': { $gte: '$$from', $lt: '$$to' } } },
      { $group: { _id: { $dateTrunc: { date: '${{field}}', unit: 'day' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, day: '$_id', count: 1 } },
    ],
  }),
];

const ENGINE = 'mongodb';

/** Actions that change data, schema, users, or the cluster. */
const WRITE_ACTIONS = new Set([
  'insert',
  'update',
  'remove',
  'createCollection',
  'dropCollection',
  'createIndex',
  'dropIndex',
  'dropDatabase',
  'renameCollectionSameDB',
  'collMod',
  'convertToCapped',
  'emptycapped',
  'bypassDocumentValidation',
  'applyOps',
  'createUser',
  'dropUser',
  'grantRole',
  'revokeRole',
  'createRole',
  'dropRole',
  'changePassword',
  'compact',
  'reIndex',
  'enableSharding',
  'shutdown',
  'fsync',
]);

const FIELD = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;

function fill(value: unknown, params: Record<string, string>, window: { from: Date; to: Date }): unknown {
  const name = (key: string) => {
    const v = params[key];
    if (!v || !FIELD.test(v))
      throw new ConnectorError('invalid_config', `template needs a valid templateParams.${key}`);
    return v;
  };
  const str = (s: string): unknown => {
    if (s === '$$from') return window.from;
    if (s === '$$to') return window.to;
    return s.replace(/\$?\{\{(\w+)\}\}/g, (m, key: string) =>
      m.startsWith('$') ? `$${name(key)}` : name(key),
    );
  };
  if (typeof value === 'string') return str(value);
  if (Array.isArray(value)) return value.map((v) => fill(v, params, window));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [str(k) as string, fill(v, params, window)]),
    );
  return value;
}

/** Every host a MongoDB URI would reach, for the cloud destination check. */
async function mongoHosts(c: ParsedConnection): Promise<Array<{ host: string; port: number }>> {
  if (c.srv) {
    const records = await resolveSrv(`_mongodb._tcp.${c.host}`).catch(() => {
      throw new ConnectorError('network_unreachable', `mongodb: no SRV records for ${c.host}`);
    });
    return records.map((r) => ({ host: r.name, port: r.port }));
  }
  const list = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(c.uri ?? '')?.[1] ?? `${c.host}:${c.port}`;
  return list.split(',').map((h) => {
    const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(h)!;
    return { host: m[1]!, port: m[2] ? Number(m[2]) : 27017 };
  });
}

async function withClient<T>(ctx: ExecutionContext, fn: (c: MongoClient, database: string) => Promise<T>): Promise<T> {
  const cfg = parseDbConfig(ctx.config, 27017);
  const { username, password, connection } = await dbCredentials(ctx);
  const database = connection?.database || cfg.database;
  if (!database) throw new ConnectorError('invalid_config', 'database is required');
  const authSource = typeof ctx.config.authSource === 'string' ? ctx.config.authSource : 'admin';
  const options = {
    tls: cfg.tls,
    tlsAllowInvalidCertificates: cfg.tls && !cfg.tlsVerify,
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    socketTimeoutMS: STATEMENT_TIMEOUT_MS + 2000,
    readPreference: 'secondaryPreferred' as const,
    appName: 'pcp-monitor',
  };
  let client: MongoClient;
  if (connection?.uri) {
    if (ctx.executionLocation === 'cloud')
      for (const h of await mongoHosts(connection)) await targetAddress(ctx, cfg, h.host, h.port);
    // The URI keeps its own options (replicaSet, authSource); ours bound time and force TLS.
    client = new MongoClient(connection.uri, options);
  } else {
    await targetAddress(ctx, cfg, cfg.host, cfg.port);
    client = new MongoClient(`mongodb://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${cfg.port}`, {
      ...options,
      auth: { username, password },
      authSource,
      directConnection: true,
    });
  }
  try {
    await client.connect();
    return await fn(client, database);
  } catch (err) {
    throw classify(err, ENGINE);
  } finally {
    await client.close().catch(() => {});
  }
}

export function createMongodbConnector(templates: ReadOnlyTemplate[] = MONGODB_TEMPLATES): Connector {
  return {
    type: 'mongodb',
    version: '1.0.0',
    displayName: 'MongoDB',
    executionLocations: ['private', 'cloud'],
    credentialFields: [
      { name: 'username', label: 'Username', secret: false },
      { name: 'password', label: 'Password', secret: true },
    ],
    templates,
    capabilities: () => ['config_validation', 'validate', 'health'],
    configSchema: () => ({
      ...DB_CONFIG_SCHEMA,
      required: ['host', 'database'],
      properties: { ...DB_CONFIG_SCHEMA.properties, authSource: { type: 'string', default: 'admin' } },
    }),
    validateConfig(config) {
      try {
        const cfg = parseDbConfig(config as Record<string, unknown>, 27017);
        if (!cfg.database) return { ok: false, errors: ['database is required'] };
        return { ok: true };
      } catch (e) {
        return { ok: false, errors: [(e as Error).message] };
      }
    },

    async validate(ctx) {
      const cfg = parseDbConfig(ctx.config, 27017);
      return withClient(ctx, async (c, database) => {
        const status = await c.db('admin').command({ connectionStatus: 1, showPrivileges: true });
        const privileges = (status.authInfo?.authenticatedUserPrivileges ?? []) as Array<{
          resource: { db?: string; collection?: string; cluster?: boolean; anyResource?: boolean };
          actions: string[];
        }>;
        const writes = new Set(privileges.flatMap((p) => p.actions.filter((a) => WRITE_ACTIONS.has(a))));
        if (writes.size && !cfg.writeOverrideAcknowledged)
          throw new ConnectorError(
            'permission_denied',
            `the database user can ${[...writes].slice(0, 6).join(', ')}; use a user with the read and clusterMonitor roles`,
          );
        const user = status.authInfo?.authenticatedUsers?.[0];
        return { ok: true, accountId: `${user?.user ?? ''}@${cfg.host}/${database}` };
      });
    },

    async health(ctx) {
      return withClient(ctx, async (c, database) => {
        const admin = c.db('admin');
        const server = await admin.command({ serverStatus: 1, repl: 1, metrics: 0, locks: 0, wiredTiger: 0 });
        let replicaSet: Document | null = null;
        try {
          const rs = await admin.command({ replSetGetStatus: 1 });
          const primary = (rs.members as Document[]).find((m) => m.stateStr === 'PRIMARY');
          replicaSet = {
            name: rs.set,
            members: (rs.members as Document[]).map((m) => ({
              name: m.name,
              state: m.stateStr,
              lagSeconds:
                primary && m.optimeDate
                  ? Math.max(0, (primary.optimeDate.getTime() - m.optimeDate.getTime()) / 1000)
                  : null,
            })),
          };
        } catch {
          // Standalone server (NoReplicationEnabled).
        }
        const stats = await c.db(database).command({ dbStats: 1 });
        return {
          ok: true,
          data: {
            engine: ENGINE,
            version: server.version,
            connections: server.connections?.current,
            availableConnections: server.connections?.available,
            uptimeSeconds: server.uptime,
            replicaSet,
            database: {
              name: stats.db,
              collections: stats.collections,
              objects: stats.objects,
              dataSizeBytes: stats.dataSize,
              storageSizeBytes: stats.storageSize,
              indexSizeBytes: stats.indexSize,
            },
          },
        };
      });
    },

    async runTemplate(ctx, name, params) {
      const t = templates.find((x) => x.name === name);
      if (!t || t.engine !== 'mongodb')
        throw new ConnectorError('invalid_config', `unknown template ${name}`);
      const cfg = parseDbConfig(ctx.config, 27017);
      const collection = cfg.templateParams.collection;
      if (!collection || !FIELD.test(collection))
        throw new ConnectorError('invalid_config', 'template needs templateParams.collection');
      const window = { from: new Date(params.from), to: new Date(params.to) };
      const pipeline = [
        ...(fill(t.pipeline, cfg.templateParams, window) as Document[]),
        { $limit: MAX_ROWS + 1 },
      ];
      return withClient(ctx, async (c, database) => {
        const rows = await c
          .db(database)
          .collection(collection)
          .aggregate(pipeline, { maxTimeMS: STATEMENT_TIMEOUT_MS, allowDiskUse: false })
          .toArray();
        return capRows(rows);
      });
    },
  };
}

export const mongodbConnector = createMongodbConnector();

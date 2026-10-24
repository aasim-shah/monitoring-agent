import { z } from 'zod';

const HOST_PORT = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/;

const hostPort = z
  .string()
  .max(256)
  .refine((s) => {
    const m = HOST_PORT.exec(s);
    return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 65535;
  }, 'endpoint must be host:port');

const httpUrl = z
  .string()
  .max(256)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'endpoint must be an http(s) URL without credentials');

export interface CredentialField {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
}

export interface Pack {
  id: string;
  name: string;
  description: string;
  defaultEndpoint: string | null;
  credentialFields: CredentialField[];
  settings: z.ZodType<Record<string, unknown>>;
  /** JSON Schema of `settings`, for the dashboard form. */
  settingsSchema: Record<string, unknown>;
}

const endpointSettings = (endpoint: z.ZodType<string>, hint: string) => ({
  settings: z.object({ endpoint }).strict() as z.ZodType<Record<string, unknown>>,
  settingsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['endpoint'],
    properties: { endpoint: { type: 'string', maxLength: 256, description: hint } },
  },
});

const userPass = (userRequired: boolean): CredentialField[] => [
  { name: 'username', label: 'Username', secret: false, required: userRequired },
  { name: 'password', label: 'Password', secret: true, required: userRequired },
];

/**
 * Monitoring packs (spec §8.10, WB-11). Receivers connect on loopback by default;
 * credentials are entered in the dashboard and sealed to the agent (BR-11-02, BR-11-03).
 */
export const PACKS: Pack[] = [
  {
    id: 'redis',
    name: 'Redis',
    description: 'Memory, operations per second, connected clients, and keyspace hit ratio.',
    defaultEndpoint: '127.0.0.1:6379',
    credentialFields: [
      { name: 'password', label: 'Password (if requirepass is set)', secret: true, required: false },
    ],
    ...endpointSettings(hostPort, 'host:port'),
  },
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    description: 'Connections, commits per second, and database size. Use a user with the pg_monitor role.',
    defaultEndpoint: '127.0.0.1:5432',
    credentialFields: userPass(true),
    ...endpointSettings(hostPort, 'host:port'),
  },
  {
    id: 'mysql',
    name: 'MySQL',
    description: 'Connections and queries per second. Use a user with PROCESS and REPLICATION CLIENT.',
    defaultEndpoint: '127.0.0.1:3306',
    credentialFields: userPass(true),
    ...endpointSettings(hostPort, 'host:port'),
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    description: 'Connections and operations per second. Use a user with the clusterMonitor role.',
    defaultEndpoint: '127.0.0.1:27017',
    credentialFields: userPass(false),
    ...endpointSettings(hostPort, 'host:port'),
  },
  {
    id: 'kafka',
    name: 'Kafka',
    description: 'Consumer lag and partitions per topic.',
    defaultEndpoint: '127.0.0.1:9092',
    credentialFields: [],
    ...endpointSettings(hostPort, 'broker host:port'),
  },
  {
    id: 'nginx',
    name: 'nginx',
    description: 'Requests per second and active connections, from the stub_status page.',
    defaultEndpoint: 'http://127.0.0.1/nginx_status',
    credentialFields: [],
    ...endpointSettings(httpUrl, 'stub_status URL'),
  },
  {
    id: 'nodejs',
    name: 'Node.js',
    description: 'CPU and memory of each Node.js process.',
    defaultEndpoint: null,
    credentialFields: [],
    settings: z.object({}).strict() as z.ZodType<Record<string, unknown>>,
    settingsSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export const packById = (id: string) => PACKS.find((p) => p.id === id);

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

/**
 * Level 2 guided setup (spec §8.9, WB-11 UC-11-04): changes the customer makes to their own software
 * for deeper metrics. The platform shows them and checks for the proof metric; it never runs them
 * (BR-11-04).
 */
export interface Guide {
  summary: string;
  steps: Array<{ text: string; command?: string }>;
  /** Metric name pattern (PromQL regex) that proves the change works on this host. */
  proof: string;
  proofLabel: string;
  troubleshooting: string[];
}

export interface Pack {
  guide?: Guide;
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
    guide: {
      summary:
        'Broker internals (request rates, under-replicated partitions, controller state) through the JMX exporter.',
      steps: [
        {
          text: 'Download the Prometheus JMX exporter javaagent and the Kafka rules file onto the broker host.',
          command:
            'sudo mkdir -p /opt/jmx && sudo curl -fsSLo /opt/jmx/jmx_prometheus_javaagent.jar https://repo1.maven.org/maven2/io/prometheus/jmx/jmx_prometheus_javaagent/1.0.1/jmx_prometheus_javaagent-1.0.1.jar && sudo curl -fsSLo /opt/jmx/kafka.yml https://raw.githubusercontent.com/prometheus/jmx_exporter/release-1.0.1/example_configs/kafka-2_0_0.yml',
        },
        {
          text: 'Add the javaagent to the broker, bound to loopback only, then restart the broker (one at a time in a cluster).',
          command:
            'export KAFKA_OPTS="$KAFKA_OPTS -javaagent:/opt/jmx/jmx_prometheus_javaagent.jar=127.0.0.1:7071:/opt/jmx/kafka.yml"',
        },
        { text: 'The agent already scrapes 127.0.0.1:7071 while the Kafka pack is enabled.' },
      ],
      proof: 'kafka_server_.+',
      proofLabel: 'kafka_server_* metrics from the JMX exporter',
      troubleshooting: [
        'curl -s 127.0.0.1:7071/metrics | head shows kafka_server_ lines on the broker host.',
        'KAFKA_OPTS is set in the environment the broker service actually starts with (systemd unit or kafka-server-start.sh).',
        'Nothing else uses port 7071.',
      ],
    },
  },
  // Level 1 managed exporters (M18.3, spec §8.9): installed by pcp-helper after an approved action
  // (host.install_exporter), which then enables this pack; the agent scrapes them on loopback.
  {
    id: 'redis-exporter',
    name: 'Redis (managed exporter)',
    description:
      'redis_exporter on 127.0.0.1:9121: keys per database, slow log, evictions. Installed after approval.',
    defaultEndpoint: '127.0.0.1:9121',
    credentialFields: [],
    ...endpointSettings(hostPort, 'host:port'),
  },
  {
    id: 'kafka-exporter',
    name: 'Kafka (managed exporter)',
    description:
      'kafka_exporter on 127.0.0.1:9308: consumer-group lag, partitions, brokers. Installed after approval.',
    defaultEndpoint: '127.0.0.1:9308',
    credentialFields: [],
    ...endpointSettings(hostPort, 'host:port'),
  },
  {
    id: 'nginx',
    name: 'nginx',
    description: 'Requests per second and active connections, from the stub_status page.',
    defaultEndpoint: 'http://127.0.0.1/nginx_status',
    credentialFields: [],
    ...endpointSettings(httpUrl, 'stub_status URL'),
    guide: {
      summary: 'Expose nginx stub_status on loopback so the agent can read requests and connections.',
      steps: [
        {
          text: 'Add a loopback-only status location to a server block (for example /etc/nginx/conf.d/pcp-status.conf).',
          command:
            'server {\n  listen 127.0.0.1:80;\n  location = /nginx_status {\n    stub_status;\n    allow 127.0.0.1;\n    deny all;\n  }\n}',
        },
        {
          text: 'Check the configuration and reload nginx (no restart, no dropped connections).',
          command: 'sudo nginx -t && sudo nginx -s reload',
        },
      ],
      proof: 'nginx_requests.*',
      proofLabel: 'nginx request counters',
      troubleshooting: [
        'curl -s http://127.0.0.1/nginx_status shows "Active connections".',
        'The pack endpoint matches that URL.',
        'nginx -V lists --with-http_stub_status_module.',
      ],
    },
  },
  {
    id: 'nodejs',
    name: 'Node.js',
    description: 'CPU and memory of each Node.js process.',
    defaultEndpoint: null,
    credentialFields: [],
    settings: z.object({}).strict() as z.ZodType<Record<string, unknown>>,
    settingsSchema: { type: 'object', additionalProperties: false, properties: {} },
    guide: {
      summary:
        'Request rates, latency, and errors per route from the OpenTelemetry Node.js SDK, sent to this agent on loopback.',
      steps: [
        {
          text: 'In the app directory, add the OpenTelemetry SDK and automatic instrumentation.',
          command:
            'npm install @opentelemetry/api @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-metrics-otlp-http',
        },
        {
          text: 'Start the app with the SDK loaded and metrics sent to the agent (systemd Environment=, PM2 env, or your shell). Use your service name.',
          command:
            'export NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"\nexport OTEL_SERVICE_NAME=my-api\nexport OTEL_METRICS_EXPORTER=otlp\nexport OTEL_TRACES_EXPORTER=none\nexport OTEL_LOGS_EXPORTER=none\nexport OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nexport OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318',
        },
        { text: 'Restart the app, then send it a few requests.' },
      ],
      proof: 'http_server_(request_)?duration.*_count',
      proofLabel: 'HTTP server request duration from the SDK',
      troubleshooting: [
        'The app runs on the same host as the agent (127.0.0.1:4318 is local).',
        'NODE_OPTIONS reaches the app process: check /proc/<pid>/environ or the PM2/systemd environment.',
        'The agent is 0.4.0 or later with the Node.js pack applied.',
        'The app received HTTP requests since it restarted.',
      ],
    },
  },
];

export const packById = (id: string) => PACKS.find((p) => p.id === id);

/**
 * Alert rule templates (WB-13 §4): users pick a template and set its parameters; they never
 * write PromQL. Metric templates compile to vmalert; the others run in the worker's tick.
 */
export type TemplateId =
  | 'host_cpu_high'
  | 'host_memory_high'
  | 'host_disk_full'
  | 'log_error_spike'
  | 'agent_heartbeat_missing'
  | 'connection_degraded';

export type Severity = 'critical' | 'warning' | 'info';
export type Params = Record<string, number>;

export interface ParamSpec {
  name: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  default: number;
}

export interface Template {
  id: TemplateId;
  label: string;
  description: string;
  kind: 'metric' | 'heartbeat' | 'connection';
  params: ParamSpec[];
  defaultSeverity: Severity;
  /** PromQL for metric templates; `> threshold` included. Scope comes from vmalert group params. */
  expr?: (p: Params) => string;
}

const threshold = (d: number): ParamSpec => ({
  name: 'threshold',
  label: 'Above',
  unit: '%',
  min: 1,
  max: 100,
  default: d,
});
const forMinutes = (d: number): ParamSpec => ({
  name: 'forMinutes',
  label: 'For at least',
  unit: 'min',
  min: 1,
  max: 1440,
  default: d,
});

export const TEMPLATES: Record<TemplateId, Template> = {
  host_cpu_high: {
    id: 'host_cpu_high',
    label: 'Server CPU high',
    description: 'CPU use on a server stays above the threshold.',
    kind: 'metric',
    params: [threshold(90), forMinutes(10)],
    defaultSeverity: 'warning',
    expr: (p) =>
      `100 * (1 - avg by (agent_id) (system_cpu_utilization_ratio{state="idle"})) > ${p.threshold}`,
  },
  host_memory_high: {
    id: 'host_memory_high',
    label: 'Server memory high',
    description: 'Memory use on a server stays above the threshold.',
    kind: 'metric',
    params: [threshold(90), forMinutes(10)],
    defaultSeverity: 'warning',
    expr: (p) => `100 * avg by (agent_id) (system_memory_utilization_ratio{state="used"}) > ${p.threshold}`,
  },
  host_disk_full: {
    id: 'host_disk_full',
    label: 'Disk almost full',
    description: 'A filesystem on a server is fuller than the threshold.',
    kind: 'metric',
    params: [threshold(90), forMinutes(5)],
    defaultSeverity: 'critical',
    expr: (p) => `100 * max by (agent_id, mountpoint) (system_filesystem_utilization_ratio) > ${p.threshold}`,
  },
  log_error_spike: {
    id: 'log_error_spike',
    label: 'Log errors spike',
    description: 'A monitored service writes more error lines per minute than the threshold.',
    kind: 'metric',
    params: [
      { name: 'perMinute', label: 'More than', unit: 'errors/min', min: 1, max: 100_000, default: 10 },
      forMinutes(5),
    ],
    defaultSeverity: 'warning',
    // increase_pure: a counter appears with its first burst (M11.2), which rate() would drop.
    expr: (p) =>
      `sum by (agent_id, service) (increase_pure({__name__=~"log_lines(_total)?",level="error"}[5m])) / 5 > ${p.perMinute}`,
  },
  agent_heartbeat_missing: {
    id: 'agent_heartbeat_missing',
    label: 'Agent heartbeat missing',
    description: 'An agent has not reported for longer than the limit (the server may be down or offline).',
    kind: 'heartbeat',
    params: [{ name: 'minutes', label: 'Silent for', unit: 'min', min: 2, max: 1440, default: 5 }],
    defaultSeverity: 'critical',
  },
  connection_degraded: {
    id: 'connection_degraded',
    label: 'Integration failing',
    description: 'A connection stays degraded or failing for longer than the limit.',
    kind: 'connection',
    params: [{ name: 'minutes', label: 'Failing for', unit: 'min', min: 1, max: 1440, default: 15 }],
    defaultSeverity: 'warning',
  },
};

/** Added by "Add recommended rules"; connection_degraded only when the product has connections. */
export const RECOMMENDED: TemplateId[] = [
  'host_cpu_high',
  'host_memory_high',
  'host_disk_full',
  'log_error_spike',
  'agent_heartbeat_missing',
];

export function isTemplateId(id: string): id is TemplateId {
  return Object.hasOwn(TEMPLATES, id);
}

/** Defaults for missing params, clamped ranges; anything not in the template is refused. */
export function validateParams(template: TemplateId, input: Record<string, unknown>): Params {
  if (!isTemplateId(template)) throw new Error(`unknown template ${String(template)}`);
  const spec = TEMPLATES[template].params;
  for (const key of Object.keys(input))
    if (!spec.some((p) => p.name === key)) throw new Error(`unknown parameter ${key}`);
  const out: Params = {};
  for (const p of spec) {
    const raw = input[p.name] ?? p.default;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error(`${p.name} must be a number`);
    out[p.name] = Math.min(p.max, Math.max(p.min, raw));
  }
  return out;
}

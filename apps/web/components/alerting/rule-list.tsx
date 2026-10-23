'use client';

import { Button } from '@/components/ui/button';
import { SeverityBadge, type Severity } from './labels';

export interface ParamSpec {
  name: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  default: number;
}

export interface AlertTemplate {
  id: string;
  label: string;
  description: string;
  kind: 'metric' | 'heartbeat' | 'connection';
  defaultSeverity: Severity;
  params: ParamSpec[];
}

export interface RuleRow {
  id: string;
  name: string;
  template: string;
  params: Record<string, number>;
  severity: Severity;
  enabled: boolean;
}

/** "Above 90 % · For at least 10 min", from the template's parameter labels. */
export function describeParams(rule: RuleRow, templates: AlertTemplate[]): string {
  const t = templates.find((x) => x.id === rule.template);
  if (!t) return '';
  return t.params.map((p) => `${p.label} ${rule.params[p.name] ?? p.default} ${p.unit}`).join(' · ');
}

/** Alert rules of a product (WB-13 §8): template rules only, enable toggle, delete. */
export function RuleList({
  rules,
  templates,
  canManage,
  onToggle,
  onDelete,
  onAddRecommended,
}: {
  rules: RuleRow[];
  templates: AlertTemplate[];
  canManage: boolean;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onAddRecommended: () => Promise<void>;
}) {
  return (
    <div className="space-y-3">
      {rules.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-border bg-card px-4 py-6 text-sm">
          <p className="text-muted-foreground">
            No alert rules yet. The recommended set covers CPU, memory, disk, log errors, and agents that stop
            reporting.
          </p>
          {canManage ? <Button onClick={onAddRecommended}>Add recommended rules</Button> : null}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Rule</th>
                <th className="px-4 py-2 font-medium">Condition</th>
                <th className="px-4 py-2 font-medium">Severity</th>
                <th className="px-4 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rules.map((r) => (
                <tr key={r.id} aria-label={r.name} className={r.enabled ? '' : 'opacity-60'}>
                  <td className="px-4 py-2 font-medium">{r.name}</td>
                  <td className="px-4 py-2 text-muted-foreground">{describeParams(r, templates)}</td>
                  <td className="px-4 py-2">
                    <SeverityBadge severity={r.severity} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canManage ? (
                      <div className="flex items-center justify-end gap-3">
                        <label className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            role="switch"
                            aria-label="Enabled"
                            checked={r.enabled}
                            onChange={(e) => onToggle(r.id, e.target.checked)}
                          />
                          {r.enabled ? 'On' : 'Off'}
                        </label>
                        <Button size="sm" variant="ghost" onClick={() => onDelete(r.id)}>
                          Delete
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage && rules.length > 0 ? (
        <Button size="sm" variant="outline" onClick={onAddRecommended}>
          Add recommended rules
        </Button>
      ) : null}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import type { Severity } from './labels';
import type { AlertTemplate } from './rule-list';

export interface NewRule {
  template: string;
  params: Record<string, number>;
  severity: Severity;
}

const selectClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';

const defaults = (t: AlertTemplate) => Object.fromEntries(t.params.map((p) => [p.name, String(p.default)]));

/** Pick a template and set its parameters (UC-13-01); no free-form query. */
export function AddRuleDialog({
  templates,
  onSubmit,
}: {
  templates: AlertTemplate[];
  onSubmit: (rule: NewRule) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const template = templates.find((t) => t.id === templateId);
  const [values, setValues] = useState<Record<string, string>>(template ? defaults(template) : {});
  const [severity, setSeverity] = useState<Severity>(template?.defaultSeverity ?? 'warning');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const choose = (id: string) => {
    const t = templates.find((x) => x.id === id);
    setTemplateId(id);
    if (t) {
      setValues(defaults(t));
      setSeverity(t.defaultSeverity);
    }
    setError(null);
  };

  const submit = async () => {
    if (!template) return;
    const params: Record<string, number> = {};
    for (const p of template.params) {
      const n = Number(values[p.name]);
      if (!Number.isFinite(n) || n < p.min || n > p.max) {
        setError(`${p.label} must be between ${p.min} and ${p.max}`);
        return;
      }
      params[p.name] = n;
    }
    setError(null);
    setPending(true);
    try {
      await onSubmit({ template: template.id, params, severity });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Add rule</Button>
      </DialogTrigger>
      <DialogContent aria-describedby="add-rule-description">
        <DialogTitle>Add alert rule</DialogTitle>
        <DialogDescription id="add-rule-description">{template?.description}</DialogDescription>
        <div className="portal-feature-section space-y-4">
          {error ? <Alert>{error}</Alert> : null}
          <Field id="rule-template" label="Template">
            <select
              id="rule-template"
              className={selectClass}
              value={templateId}
              onChange={(e) => choose(e.target.value)}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          {template?.params.map((p) => (
            <Field key={`${template.id}-${p.name}`} id={`rule-${p.name}`} label={`${p.label} (${p.unit})`}>
              <Input
                id={`rule-${p.name}`}
                type="number"
                min={p.min}
                max={p.max}
                value={values[p.name] ?? ''}
                onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}
              />
            </Field>
          ))}
          <Field id="rule-severity" label="Severity">
            <select
              id="rule-severity"
              className={selectClass}
              value={severity}
              onChange={(e) => setSeverity(e.target.value as Severity)}
            >
              <option value="critical">Critical (escalates after 15 min)</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          </Field>
          <Button className="w-full" disabled={pending} onClick={submit}>
            {pending ? 'Saving…' : 'Save rule'}
          </Button>
        </div>
        <div className="flex justify-end">
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

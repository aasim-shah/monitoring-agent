'use client';

import { PageHeading } from '@/components/shell/page-heading';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { INTEGRATIONS, isIntegration } from '@/lib/integrations';
import { relativeTime } from '@/lib/relative-time';
import { CredentialInputs, filled, missingCredential, type CredentialField } from './connect-dialog';

export interface Scope {
  externalId: string;
  resourceType: string;
  name: string;
  productId: string;
  environmentId?: string | null;
}

export interface ConnectionDetailData {
  connection: {
    id: string;
    provider: string;
    displayName: string;
    status: string;
    statusReason: string | null;
    missingPermissions?: string[];
    scopes: Scope[];
  };
  productId: string;
  webhookUrl: string;
  inventory: Array<{ externalId: string; resourceType: string; name: string; attributes: unknown }>;
  deliveries: Array<{
    id: string;
    deliveryId: string;
    eventType: string;
    result: string;
    detail?: string | null;
    receivedAt: string;
  }>;
  events: Array<{
    id: string;
    kind: string;
    title: string;
    url?: string | null;
    actor?: string | null;
    externalId: string;
    occurredAt: string;
  }>;
  runs: Array<{
    id: string;
    kind: string;
    status: string;
    errorMessage?: string | null;
    items?: number | null;
    createdAt: string;
  }>;
  credentialFields?: CredentialField[];
}

export interface DetailActions {
  onValidate?: () => Promise<void>;
  onDiscover?: () => Promise<void>;
  onDelete?: () => Promise<void>;
  onReplaceCredentials?: (credentials: Record<string, string>) => Promise<void>;
}

const REASONS: Record<string, string> = {
  reauthorization_required: 'The token was rejected. Replace the credentials.',
  provider_unavailable: 'The provider did not answer. Retrying.',
  rate_limited: 'Rate limited by the provider. Retrying later.',
  network_unreachable: 'The address cannot be reached from the platform.',
  invalid_config: 'Configuration error.',
};

function statusTone(status: string) {
  if (status === 'connected') return 'border-success/40 text-success';
  if (status === 'degraded') return 'border-amber-500/40 text-amber-600';
  if (['revoked', 'disconnected'].includes(status)) return 'border-destructive/40 text-destructive';
  return 'animate-pulse';
}

const resourceLabel: Record<string, string> = {
  cloudflare_zone: 'zones',
  dns_record: 'DNS records',
  certificate_pack: 'certificate packs',
  github_repository: 'repositories',
  github_workflow: 'workflows',
  github_deployment: 'deployments',
  github_release: 'releases',
  prometheus_server: 'servers',
  prometheus_target: 'targets',
  grafana_dashboard: 'dashboards',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={title}
      className="portal-detail-card space-y-4 rounded-lg border border-border bg-card p-6"
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function ConnectionDetail({
  data,
  canConfigure,
  onScope,
  actions,
}: {
  data: ConnectionDetailData;
  canConfigure: boolean;
  /** Receives the full scope list: other products' scopes are kept as they are. */
  onScope: (scopes: Scope[]) => Promise<void>;
  actions: DetailActions;
}) {
  const { connection: c, productId } = data;
  const spec = isIntegration(c.provider) ? INTEGRATIONS[c.provider] : null;
  const scopeTypes = spec?.scopeTypes ?? [];
  const scopable = data.inventory.filter((i) => scopeTypes.includes(i.resourceType));
  const others = Object.entries(
    data.inventory
      .filter((i) => !scopeTypes.includes(i.resourceType))
      .reduce<
        Record<string, number>
      >((m, i) => ({ ...m, [i.resourceType]: (m[i.resourceType] ?? 0) + 1 }), {}),
  );
  const mine = c.scopes.filter((s) => s.productId === productId);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(mine.map((s) => s.externalId)));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creds, setCreds] = useState<Record<string, string>>({});

  const run = async (label: string, fn?: () => Promise<void>, done?: string) => {
    if (!fn) return;
    setError(null);
    setNotice(null);
    setBusy(label);
    try {
      await fn();
      if (done) setNotice(done);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const saveScope = () =>
    run(
      'scope',
      () =>
        onScope([
          ...c.scopes.filter((s) => s.productId !== productId),
          ...scopable
            .filter((i) => selected.has(i.externalId))
            .map((i) => ({
              externalId: i.externalId,
              resourceType: i.resourceType,
              name: i.name,
              productId,
            })),
        ]),
      'Scope saved. Assets update on the next discovery.',
    );

  const reason =
    c.statusReason === 'permission_denied' && c.missingPermissions?.length
      ? `The token is missing: ${c.missingPermissions.join(', ')}`
      : c.statusReason
        ? (REASONS[c.statusReason] ?? c.statusReason)
        : null;

  return (
    <div className="portal-feature-section space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <PageHeading title={<>{c.displayName}</>} eyebrow="Product detail" />
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{spec?.title ?? c.provider}</span>
            <Badge className={cn(statusTone(c.status))}>{c.status.replace(/_/g, ' ')}</Badge>
          </div>
        </div>
        {canConfigure ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => run('validate', actions.onValidate, 'Validation started.')}
            >
              Validate now
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => run('discover', actions.onDiscover, 'Discovery started.')}
            >
              Discover now
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm(`Delete ${c.displayName}? The stored token is destroyed.`))
                  void run('delete', actions.onDelete);
              }}
            >
              Delete
            </Button>
          </div>
        ) : null}
      </div>
      {reason ? <Alert>{reason}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Section title="Discovered resources">
        {data.inventory.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing discovered yet. Run discovery after validation.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Choose what belongs to this product. Only chosen items appear in its assets, AI answers, and
              reports.
            </p>
            <ul className="space-y-1">
              {scopable.map((i) => (
                <li key={i.externalId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    id={`scope-${i.externalId}`}
                    checked={selected.has(i.externalId)}
                    disabled={!canConfigure}
                    onChange={(e) =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(i.externalId);
                        else n.delete(i.externalId);
                        return n;
                      })
                    }
                  />
                  <label htmlFor={`scope-${i.externalId}`}>{i.name}</label>
                </li>
              ))}
            </ul>
            {others.length ? (
              <p className="text-xs text-muted-foreground">
                Also found: {others.map(([t, n]) => `${n} ${resourceLabel[t] ?? t}`).join(', ')}.
              </p>
            ) : null}
            {canConfigure && scopable.length ? (
              <Button size="sm" onClick={saveScope} disabled={busy !== null}>
                Save scope
              </Button>
            ) : null}
          </>
        )}
      </Section>

      {spec?.webhook ? (
        <Section title="Webhook">
          <p className="text-xs text-muted-foreground">{spec.webhook}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 text-xs break-all">{data.webhookUrl}</code>
            <Button
              size="sm"
              variant="outline"
              aria-label="Copy webhook URL"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(data.webhookUrl);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use a long random secret there and enter the same value as the webhook secret under Replace
            credentials. Unsigned or wrongly signed deliveries are refused.
          </p>
          {data.deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deliveries yet.</p>
          ) : (
            <table aria-label="Webhook deliveries" className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Received</th>
                  <th className="py-1 font-medium">Event</th>
                  <th className="py-1 font-medium">Delivery</th>
                  <th className="py-1 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((d) => (
                  <tr key={d.id} className="border-t border-border">
                    <td className="py-1">{relativeTime(d.receivedAt)}</td>
                    <td className="py-1">{d.eventType}</td>
                    <td className="py-1 font-mono">{d.deliveryId}</td>
                    <td className="py-1" title={d.detail ?? undefined}>
                      {d.result}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      ) : null}

      <Section title="Recent changes">
        {data.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No changes received yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-2">
                <Badge>{e.kind.replace(/_/g, ' ')}</Badge>
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noreferrer" className="underline">
                    {e.title}
                  </a>
                ) : (
                  <span>{e.title}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {e.actor ? `${e.actor} · ` : ''}
                  {relativeTime(e.occurredAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Sync history">
        {data.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <table aria-label="Sync history" className="w-full text-left text-xs">
            <tbody>
              {data.runs.slice(0, 15).map((r) => (
                <tr key={r.id} className="border-t border-border first:border-t-0">
                  <td className="py-1">{relativeTime(r.createdAt)}</td>
                  <td className="py-1">{r.kind}</td>
                  <td className={cn('py-1', r.status === 'failed' && 'text-destructive')}>{r.status}</td>
                  <td className="py-1 text-muted-foreground">
                    {r.errorMessage ?? (r.items != null ? `${r.items} items` : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {canConfigure && data.credentialFields?.length && actions.onReplaceCredentials ? (
        <Section title="Replace credentials">
          <p className="text-xs text-muted-foreground">
            Stored encrypted and never shown again. Saving replaces every field and validates again.
          </p>
          <CredentialInputs
            fields={data.credentialFields}
            values={creds}
            idPrefix="replace"
            onChange={(name, value) => setCreds((x) => ({ ...x, [name]: value }))}
          />
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              const missing = missingCredential(data.credentialFields!, creds);
              if (missing) return setError(missing);
              void run(
                'credentials',
                async () => {
                  await actions.onReplaceCredentials!(filled(creds));
                  setCreds({});
                },
                'Credentials replaced. Validation started.',
              );
            }}
          >
            Save credentials
          </Button>
        </Section>
      ) : null}
    </div>
  );
}

import { Badge } from '@/components/ui/badge';
import type { ActionRow } from './action-list';
import { describeAction, STATUS_LABEL, STATUS_TONE } from './format';

export interface ActionDetailData extends ActionRow {
  reason: string | null;
  approvals: Array<{ id: string; userId: string; decision: string; note: string | null; createdAt: string }>;
  executions: Array<{
    id: string;
    location: string;
    adapter: string;
    adapterVersion: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    verification: { activeState?: string | null; verified?: boolean } | null;
    error: string | null;
  }>;
}

const at = (iso: string) => new Date(iso).toLocaleString();

/** One action (UC-16-09): timeline from proposal to verified result. */
export function ActionDetail({ action }: { action: ActionDetailData }) {
  const label = describeAction(action.capability, action.params, action.host);
  const steps: Array<{ when: string; text: string }> = [
    { when: action.createdAt, text: `Proposed${action.proposedByAi ? ' by the AI assistant' : ''}` },
    ...action.approvals.map((a) => ({
      when: a.createdAt,
      text: `${a.decision === 'approve' ? 'Approved' : 'Rejected'}${a.note ? `: ${a.note}` : ''}`,
    })),
    ...action.executions.flatMap((e) => [
      {
        when: e.startedAt,
        text:
          e.location === 'agent'
            ? `Executed on the host by pcp-helper (${e.adapter} ${e.adapterVersion})`
            : `Executed by the platform (${e.adapter} ${e.adapterVersion})`,
      },
      ...(e.finishedAt
        ? [
            {
              when: e.finishedAt,
              text: e.verification?.verified
                ? `Verified: the unit is ${e.verification.activeState}`
                : e.status === 'expired'
                  ? 'Expired: the host did not run the task in time'
                  : `Verification failed: the unit is ${e.verification?.activeState ?? 'unknown'}`,
            },
          ]
        : []),
    ]),
  ];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{label}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Badge className={STATUS_TONE[action.status]}>{STATUS_LABEL[action.status] ?? action.status}</Badge>
          {action.proposedByAi ? <Badge>Proposed by AI</Badge> : null}
          {action.production ? <Badge>Production</Badge> : null}
        </div>
      </div>
      {action.reason ? <p className="text-sm">{action.reason}</p> : null}
      {action.impactSummary ? (
        <section aria-label="Impact" className="rounded-lg border border-border bg-card p-4 text-sm">
          <h2 className="font-semibold">Impact (dry run)</h2>
          <p className="text-muted-foreground">{action.impactSummary}</p>
        </section>
      ) : null}
      <ol aria-label="Timeline" className="space-y-2 rounded-lg border border-border bg-card p-4 text-sm">
        {steps.map((s, i) => (
          <li key={i}>
            <span className="text-muted-foreground">{at(s.when)}</span> · <span>{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

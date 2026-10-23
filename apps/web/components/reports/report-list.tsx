import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { NARRATIVE_LABEL } from './format';

export interface ReportRow {
  id: string;
  localDate: string;
  version: number;
  narrativeStatus: 'verified' | 'deferred' | 'disabled';
  late: boolean;
  scheduleName: string | null;
  createdAt: string;
}

/** Report history (UC-15-04): one row per version, newest first. */
export function ReportList({ reports, href }: { reports: ReportRow[]; href: (id: string) => string }) {
  if (reports.length === 0)
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        No reports yet. The first one arrives after the next scheduled run, or use Run now.
      </p>
    );
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Day</th>
            <th className="px-4 py-2 font-medium">Summary</th>
            <th className="px-4 py-2 font-medium">Schedule</th>
            <th className="px-4 py-2 font-medium">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {reports.map((r) => (
            <tr key={r.id} aria-label={`${r.localDate} · v${r.version}`}>
              <td className="px-4 py-2 font-medium">
                {`${r.localDate} · v${r.version}`}
                {r.late ? <Badge className="ml-2 border-warning/40 text-warning">Late</Badge> : null}
              </td>
              <td className="px-4 py-2">
                <Badge
                  className={r.narrativeStatus === 'verified' ? 'border-success/40 text-success' : undefined}
                >
                  {NARRATIVE_LABEL[r.narrativeStatus]}
                </Badge>
              </td>
              <td className="px-4 py-2 text-muted-foreground">{r.scheduleName ?? 'Deleted schedule'}</td>
              <td className="px-4 py-2 text-right">
                <Link className="underline" href={href(r.id)}>
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

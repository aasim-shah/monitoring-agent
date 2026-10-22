import { Empty } from '../states/empty';
import { Button } from '../ui/button';

export interface AuditRow {
  id: string;
  action: string;
  actorType: string;
  actorId?: string | null;
  targetType: string;
  targetId?: string | null;
  createdAt: string;
}

export function AuditTable({
  entries,
  hasMore,
  onLoadMore,
  loadingMore,
}: {
  entries: AuditRow[];
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
}) {
  if (entries.length === 0) return <Empty title="No audit entries yet" />;
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Target</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-border">
                <td className="whitespace-nowrap px-3 py-2">{new Date(e.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2 font-mono">{e.action}</td>
                <td className="px-3 py-2">
                  {e.actorType}
                  {e.actorId ? (
                    <span className="ml-1 font-mono text-xs text-muted-foreground">
                      {e.actorId.slice(0, 8)}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  {e.targetType}
                  {e.targetId ? (
                    <span className="ml-1 font-mono text-xs text-muted-foreground">
                      {e.targetId.slice(0, 8)}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore ? (
        <Button variant="outline" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
}

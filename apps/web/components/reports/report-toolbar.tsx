'use client';

import { useState } from 'react';
import { Search } from 'lucide-react';
import { ReportList, type ReportRow } from './report-list';

export function ReportHistory({ reports, href }: { reports: ReportRow[]; href: (id: string) => string }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const filtered = reports.filter(
    (r) =>
      (status === 'all' || r.narrativeStatus === status) &&
      `${r.localDate} ${r.scheduleName ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="portal-feature-section space-y-4">
      <div className="portal-report-toolbar">
        <label className="portal-search">
          <Search size={18} />
          <span className="sr-only">Search reports by date or schedule</span>
          <input
            type="search"
            placeholder="Search date or schedule…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">Summary status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All summaries</option>
            <option value="verified">Verified</option>
            <option value="deferred">Deferred</option>
            <option value="disabled">AI off</option>
          </select>
        </label>
        <span className="text-xs text-muted-foreground" role="status">
          {filtered.length} reports
        </span>
      </div>
      {reports.length && !filtered.length ? (
        <div className="portal-no-results">
          No matching reports. Try a different date or clear the filters.
        </div>
      ) : (
        <ReportList reports={filtered} href={href} />
      )}
    </div>
  );
}

// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReportHistory } from './report-toolbar';

const reports = [
  {
    id: 'a',
    localDate: '2026-10-24',
    version: 1,
    narrativeStatus: 'verified' as const,
    late: false,
    scheduleName: 'Morning brief',
    createdAt: '2026-10-25T03:00:00Z',
  },
  {
    id: 'b',
    localDate: '2026-10-23',
    version: 2,
    narrativeStatus: 'deferred' as const,
    late: false,
    scheduleName: 'Evening brief',
    createdAt: '2026-10-24T03:00:00Z',
  },
];
describe('report history filters', () => {
  it('combines schedule search with summary status and shows no matching results', () => {
    render(<ReportHistory reports={reports} href={(id) => `/reports/${id}`} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Morning' } });
    expect(screen.getByText('2026-10-24 · v1')).toBeInTheDocument();
    expect(screen.queryByText('2026-10-23 · v2')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'deferred' } });
    expect(screen.getByText(/No matching reports/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(screen.getByText('2026-10-23 · v2')).toBeInTheDocument();
  });
});

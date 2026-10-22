// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StaleBanner } from './stale-banner';

afterEach(cleanup);
const now = new Date('2026-10-22T12:00:00Z');

describe('StaleBanner', () => {
  it('is silent while samples are fresh', () => {
    const { container } = render(<StaleBanner lastSampleAt="2026-10-22T11:59:10Z" now={now} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says when data stopped, after 2 minutes (TC-04-13)', () => {
    render(<StaleBanner lastSampleAt="2026-10-22T11:55:00Z" now={now} />);
    expect(screen.getByRole('status')).toHaveTextContent(/No data since .*5 min ago/);
  });

  it('explains the wait before the first sample', () => {
    render(<StaleBanner lastSampleAt={null} now={now} />);
    expect(screen.getByRole('status')).toHaveTextContent(/No metrics yet/);
  });
});

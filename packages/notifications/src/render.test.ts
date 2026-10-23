import { describe, expect, it } from 'vitest';
import { render } from './render.js';

const incident = {
  id: 'inc-1',
  productId: 'prod-1',
  title: 'Server CPU high on vps-1',
  severity: 'critical' as const,
  status: 'open' as const,
  summary: 'Server CPU high on vps-1. Latest value 97.3. Correlated with 1 asset: Orders API (potential).',
  startedAt: new Date('2026-10-23T10:00:00Z'),
};
const link = 'https://monitor.example.com/orgs/o/products/prod-1/incidents/inc-1';

describe('render', () => {
  it('builds subject, text, Slack text, and JSON with the incident link', () => {
    const m = render('opened', incident, link);
    expect(m.subject).toBe('[CRITICAL] Server CPU high on vps-1 — opened');
    expect(m.text).toContain(incident.summary);
    expect(m.text).toContain(link);
    expect(m.slack.text).toContain('*[CRITICAL] Server CPU high on vps-1*');
    expect(m.slack.text).toContain(`<${link}|Open the incident>`);
    expect(m.json).toMatchObject({
      type: 'incident.opened',
      incident: { id: 'inc-1', severity: 'critical' },
      link,
    });
    expect(render('resolved', { ...incident, status: 'resolved' }, link).subject).toBe(
      '[CRITICAL] Server CPU high on vps-1 — resolved',
    );
    expect(render('escalated', incident, link).subject).toBe(
      '[CRITICAL] Server CPU high on vps-1 — still unacknowledged after 15 min',
    );
  });

  it('renders a test message without an incident', () => {
    const m = render('test', null, 'https://monitor.example.com');
    expect(m.subject).toBe('Product Control Plane test notification');
    expect(m.json).toEqual({ type: 'test', link: 'https://monitor.example.com' });
  });
});

import { describe, expect, it } from 'vitest';
import { isValidLocalTime, isValidTimezone, nextRunAt, previousWindow, reportWindow } from './window.js';

const iso = (d: Date) => d.toISOString();

describe('report windows (D21, WB-15 UC-15-07, Review Focus #1)', () => {
  it('TC-15-01: Berlin 08:00 on 2026-10-26 fires at 07:00Z and covers the 25 h day', () => {
    expect(iso(nextRunAt('Europe/Berlin', '08:00', new Date('2026-10-25T07:00:00Z')))).toBe(
      '2026-10-26T07:00:00.000Z',
    );
    const w = reportWindow('Europe/Berlin', new Date('2026-10-26T07:00:00Z'));
    expect({ ...w, start: iso(w.start), end: iso(w.end) }).toEqual({
      timezone: 'Europe/Berlin',
      localDate: '2026-10-25',
      start: '2026-10-24T22:00:00.000Z',
      end: '2026-10-25T23:00:00.000Z',
      hours: 25,
    });
  });

  it('TC-15-02: Berlin 08:00 on 2027-03-29 covers the 23 h day', () => {
    const w = reportWindow('Europe/Berlin', new Date('2027-03-29T06:00:00Z'));
    expect([w.localDate, iso(w.start), iso(w.end), w.hours]).toEqual([
      '2027-03-28',
      '2027-03-27T23:00:00.000Z',
      '2027-03-28T22:00:00.000Z',
      23,
    ]);
  });

  it('Karachi (no DST) runs at 03:00Z over 24 h', () => {
    const run = nextRunAt('Asia/Karachi', '08:00', new Date('2026-10-23T12:00:00Z'));
    expect(iso(run)).toBe('2026-10-24T03:00:00.000Z');
    const w = reportWindow('Asia/Karachi', run);
    expect([w.localDate, iso(w.start), iso(w.end), w.hours]).toEqual([
      '2026-10-23',
      '2026-10-22T19:00:00.000Z',
      '2026-10-23T19:00:00.000Z',
      24,
    ]);
  });

  it('runs later the same day when the local time has not passed yet', () => {
    expect(iso(nextRunAt('Asia/Karachi', '08:00', new Date('2026-10-23T02:00:00Z')))).toBe(
      '2026-10-23T03:00:00.000Z',
    );
  });

  it('shifts a local time inside the spring-forward gap by the gap (Review Focus #5)', () => {
    expect(iso(nextRunAt('Europe/Berlin', '02:30', new Date('2027-03-27T12:00:00Z')))).toBe(
      '2027-03-28T01:30:00.000Z',
    );
  });

  it('the previous window is the local day before', () => {
    const p = previousWindow(reportWindow('Europe/Berlin', new Date('2026-10-26T07:00:00Z')));
    expect([p.localDate, iso(p.start), iso(p.end), p.hours]).toEqual([
      '2026-10-24',
      '2026-10-23T22:00:00.000Z',
      '2026-10-24T22:00:00.000Z',
      24,
    ]);
  });

  it('validates timezones and local times', () => {
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('Mars/Base')).toBe(false);
    expect(isValidLocalTime('08:00')).toBe(true);
    expect(isValidLocalTime('25:00')).toBe(false);
    expect(isValidLocalTime('8:00')).toBe(false);
  });
});

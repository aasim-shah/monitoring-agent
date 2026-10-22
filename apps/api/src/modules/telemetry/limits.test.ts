import { describe, expect, it } from 'vitest';
import { planRange, toGrid } from './limits.js';

const now = new Date('2026-10-22T12:00:00Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000);

describe('planRange (BR-04-06)', () => {
  it('raises the step so no series exceeds 11,000 points (TC-04-07)', () => {
    const plan = planRange(ago(30 * 86400), now, 15, now);
    expect((30 * 86400) / plan.stepSeconds).toBeLessThanOrEqual(11_000);
    expect(plan.stepSeconds).toBeGreaterThanOrEqual(236);
  });

  it('keeps the requested step when it fits', () => {
    expect(planRange(ago(3600), now, 30, now).stepSeconds).toBe(30);
  });

  it('aligns the grid to multiples of the step, as VictoriaMetrics does', () => {
    const plan = planRange(new Date('2026-10-22T11:00:17Z'), new Date('2026-10-22T12:00:17Z'), 60, now);
    expect(plan.startS % 60).toBe(0);
    expect(plan.endS % 60).toBe(0);
    expect(plan.startS).toBe(Date.parse('2026-10-22T11:00:00Z') / 1000);
    expect(plan.endS).toBe(Date.parse('2026-10-22T12:01:00Z') / 1000);
  });

  it('marks ranges older than raw retention as partial (TC-04-08)', () => {
    expect(planRange(ago(3600), now, 60, now).gaps).toEqual([]);
    const plan = planRange(ago(20 * 86400), now, 3600, now);
    expect(plan.gaps).toEqual([`retention: no raw data before ${ago(15 * 86400).toISOString()}`]);
  });

  it('rejects ranges over 400 days or reversed', () => {
    expect(() => planRange(ago(401 * 86400), now, 3600, now)).toThrow(/400 days/);
    expect(() => planRange(now, ago(60), 60, now)).toThrow(/before/);
  });
});

describe('toGrid (BR-04-07)', () => {
  it('fills missing steps with null, never zero', () => {
    const start = 1000;
    const points = toGrid(
      [
        [1060, '5'],
        [1180, '7.5'],
      ],
      start,
      start + 180,
      60,
    );
    expect(points).toEqual([
      [1000, null],
      [1060, 5],
      [1120, null],
      [1180, 7.5],
    ]);
  });

  it('maps NaN to null', () => {
    expect(toGrid([[0, 'NaN']], 0, 0, 60)).toEqual([[0, null]]);
  });
});

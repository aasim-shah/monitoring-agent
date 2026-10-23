import { DateTime, IANAZone } from 'luxon';

export interface ReportWindow {
  timezone: string;
  /** The local calendar day the report covers, YYYY-MM-DD. */
  localDate: string;
  start: Date;
  end: Date;
  /** 23, 24, or 25 on DST transition days. */
  hours: number;
}

const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isValidTimezone = (tz: string) => IANAZone.isValidZone(tz);
export const isValidLocalTime = (t: string) => LOCAL_TIME.test(t);

function windowFor(timezone: string, day: DateTime): ReportWindow {
  const start = day.startOf('day');
  const end = start.plus({ days: 1 }).startOf('day');
  return {
    timezone,
    localDate: start.toISODate()!,
    start: start.toJSDate(),
    end: end.toJSDate(),
    hours: Math.round(end.diff(start, 'hours').hours),
  };
}

/** The prior complete local day before `runAt` in `timezone` (D21, master plan §3). */
export function reportWindow(timezone: string, runAt: Date): ReportWindow {
  return windowFor(timezone, DateTime.fromJSDate(runAt, { zone: timezone }).minus({ days: 1 }));
}

/** The window of one local calendar day (YYYY-MM-DD), for retries and regeneration. */
export function localDayWindow(timezone: string, localDate: string): ReportWindow {
  return windowFor(timezone, DateTime.fromISO(localDate, { zone: timezone }));
}

/** The local day before a window, for period comparisons. */
export function previousWindow(w: ReportWindow): ReportWindow {
  return windowFor(w.timezone, DateTime.fromJSDate(w.start, { zone: w.timezone }).minus({ days: 1 }));
}

/**
 * The first instant strictly after `after` whose local wall time is `localTime`. A wall time
 * inside a spring-forward gap is shifted forward by the gap (02:30 becomes 03:30), as Luxon does.
 */
export function nextRunAt(timezone: string, localTime: string, after: Date): Date {
  const m = LOCAL_TIME.exec(localTime);
  if (!m || !isValidTimezone(timezone)) throw new Error(`invalid schedule ${localTime} ${timezone}`);
  const day = DateTime.fromJSDate(after, { zone: timezone }).startOf('day');
  for (let i = 0; i < 3; i++) {
    const candidate = day.plus({ days: i }).set({ hour: Number(m[1]), minute: Number(m[2]) });
    if (candidate.toMillis() > after.getTime()) return candidate.toJSDate();
  }
  throw new Error('unreachable: a local time occurs within three days');
}

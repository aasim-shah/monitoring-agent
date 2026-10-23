/** "Mon 26 Oct, 08:00" in a timezone. */
export function formatLocal(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(iso));
}

/** "07:00" in UTC. */
export function formatUtcTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

export const NARRATIVE_LABEL = {
  verified: 'Verified summary',
  deferred: 'Narrative deferred',
  disabled: 'AI off',
} as const;

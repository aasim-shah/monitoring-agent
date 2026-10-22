import { Alert } from '@/components/ui/alert';
import { relativeTime } from '@/lib/relative-time';

const STALE_AFTER_MS = 2 * 60_000;

/** Says plainly when metrics stopped or have not started; charts then show gaps, not zeros. */
export function StaleBanner({ lastSampleAt, now = new Date() }: { lastSampleAt: string | null; now?: Date }) {
  if (lastSampleAt === null)
    return (
      <Alert tone="info">
        No metrics yet. They start about a minute after the agent is installed with its collector.
      </Alert>
    );
  if (now.getTime() - new Date(lastSampleAt).getTime() <= STALE_AFTER_MS) return null;
  return (
    <Alert tone="info">
      No data since {new Date(lastSampleAt).toLocaleString()} ({relativeTime(lastSampleAt, now)}). The agent
      or its network may be down; a missing agent alone does not mean the server is down.
    </Alert>
  );
}

import { ApiError } from '@pcp/api-client';
import { errorMessage } from '@/lib/api';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert className="flex items-start justify-between gap-4">
      <div>
        <p className="font-medium">{errorMessage(error)}</p>
        {error instanceof ApiError && error.requestId ? (
          <p className="mt-1 text-xs opacity-80">Request ID: {error.requestId}</p>
        ) : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </Alert>
  );
}

'use client';

import { Card, CardTitle } from '@/components/ui/card';

export interface AiSettings {
  disabled: boolean;
  available: boolean;
  provider?: string | null;
  model?: string | null;
}

/** Organization switch for the AI assistant (UC-14-06); dashboards and alerts never depend on it. */
export function AiSettingsCard({
  settings,
  onChange,
}: {
  settings: AiSettings;
  onChange: (disabled: boolean) => Promise<void>;
}) {
  return (
    <Card className="space-y-3">
      <CardTitle>AI assistant</CardTitle>
      {settings.available ? (
        <p className="text-sm text-muted-foreground">
          Answers come from {settings.provider} ({settings.model}). Only tool results about your products are
          sent: never credentials, connection strings, or log text.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">No AI provider is configured on this platform.</p>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          role="switch"
          aria-label="AI assistant"
          checked={!settings.disabled}
          onChange={(e) => onChange(!e.target.checked)}
        />
        {settings.disabled ? 'Off: AI buttons are hidden for everyone' : 'On'}
      </label>
    </Card>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import { formatLocal, formatUtcTime } from './format';

export interface NewSchedule {
  name: string;
  timezone: string;
  localTime: string;
  channelIds: string[];
  recipients: string[];
}
export interface ChannelOption {
  id: string;
  name: string;
  kind: 'email' | 'slack' | 'webhook';
}
export interface SchedulePreview {
  nextRunAt: string;
  localDate: string;
  windowHours: number;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 10;
const selectClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';

function timezones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
  return all.includes(current) ? all : [current, ...all];
}

/** A daily report schedule (UC-15-01) with a live "next run" preview in local time and UTC. */
export function ScheduleDialog({
  channels,
  defaultTimezone,
  onPreview,
  onSubmit,
}: {
  channels: ChannelOption[];
  defaultTimezone: string;
  onPreview: (timezone: string, localTime: string) => Promise<SchedulePreview>;
  onSubmit: (schedule: NewSchedule) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [localTime, setLocalTime] = useState('08:00');
  const [picked, setPicked] = useState<string[]>([]);
  const [recipients, setRecipients] = useState('');
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const zones = useMemo(() => timezones(defaultTimezone), [defaultTimezone]);

  useEffect(() => {
    if (!open || !TIME.test(localTime)) return setPreview(null);
    let live = true;
    onPreview(timezone, localTime)
      .then((p) => live && setPreview(p))
      .catch(() => live && setPreview(null));
    return () => {
      live = false;
    };
  }, [open, timezone, localTime, onPreview]);

  const reset = () => {
    setName('');
    setTimezone(defaultTimezone);
    setLocalTime('08:00');
    setPicked([]);
    setRecipients('');
    setError(null);
  };

  const submit = async () => {
    if (!name.trim()) return setError('Enter a name');
    if (!TIME.test(localTime)) return setError('Use a 24-hour time such as 08:00');
    const list = recipients
      .split(/[,\s]+/)
      .map((r) => r.trim())
      .filter(Boolean);
    if (picked.length === 0 && list.length === 0) return setError('Choose a channel or add a recipient');
    if (list.length > MAX_RECIPIENTS) return setError(`At most ${MAX_RECIPIENTS} recipients`);
    const bad = list.find((r) => !EMAIL.test(r));
    if (bad) return setError(`${bad} is not an email address`);
    setError(null);
    setPending(true);
    try {
      await onSubmit({ name: name.trim(), timezone, localTime, channelIds: picked, recipients: list });
      setOpen(false);
      reset();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">Add schedule</Button>
      </DialogTrigger>
      <DialogContent aria-describedby="schedule-description">
        <DialogTitle>Daily report schedule</DialogTitle>
        <DialogDescription id="schedule-description">
          Each morning at this local time, a report of the previous complete local day goes to the channels
          and recipients you choose.
        </DialogDescription>
        <div className="space-y-4">
          {error ? <Alert>{error}</Alert> : null}
          <Field id="schedule-name" label="Name">
            <Input id="schedule-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="schedule-timezone" label="Timezone">
              <select
                id="schedule-timezone"
                className={selectClass}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="schedule-time" label="Local time" hint="24-hour, e.g. 08:00">
              <Input id="schedule-time" value={localTime} onChange={(e) => setLocalTime(e.target.value)} />
            </Field>
          </div>
          <p role="status" className="text-sm text-muted-foreground">
            {preview
              ? `Next run: ${formatLocal(preview.nextRunAt, timezone)} (${formatUtcTime(preview.nextRunAt)} UTC) · covers ${preview.windowHours} h`
              : 'Next run: —'}
          </p>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Channels</legend>
            {channels.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No notification channels yet; add recipients below.
              </p>
            ) : (
              channels.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.includes(c.id)}
                    onChange={(e) =>
                      setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))
                    }
                  />
                  {c.name}
                </label>
              ))
            )}
          </fieldset>
          <Field
            id="schedule-recipients"
            label="Recipients"
            hint="Email addresses, separated by commas (up to 10)."
          >
            <Input
              id="schedule-recipients"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
            />
          </Field>
          <Button className="w-full" disabled={pending} onClick={submit}>
            {pending ? 'Saving…' : 'Save schedule'}
          </Button>
        </div>
        <div className="flex justify-end">
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

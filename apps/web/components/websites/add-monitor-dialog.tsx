'use client';

import { useState } from 'react';
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

export interface NewMonitor {
  url: string;
  intervalSeconds: number;
}

function isHttpUrl(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Adds a public URL (UC-09-01); the list then shows the TXT record that proves control of the domain. */
export function AddMonitorDialog({ onSubmit }: { onSubmit: (monitor: NewMonitor) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [interval, setIntervalText] = useState('60');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reset = () => {
    setUrl('');
    setIntervalText('60');
    setError(null);
  };

  const submit = async () => {
    if (!isHttpUrl(url.trim())) return setError('Enter an http:// or https:// URL');
    const seconds = Number(interval);
    if (!Number.isInteger(seconds) || seconds < 30) return setError('Check at most every 30 seconds');
    if (seconds > 3600) return setError('Check at least once an hour');
    setError(null);
    setPending(true);
    try {
      await onSubmit({ url: url.trim(), intervalSeconds: seconds });
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
        <Button size="sm">Add website</Button>
      </DialogTrigger>
      <DialogContent aria-describedby="add-monitor-description">
        <DialogTitle>Add website or API</DialogTitle>
        <DialogDescription id="add-monitor-description">
          A public URL. Next you add a DNS TXT record to prove you control the domain; checks start once it is
          found.
        </DialogDescription>
        <div className="space-y-4">
          {error ? <Alert>{error}</Alert> : null}
          <Field id="monitor-url" label="URL" hint="For example https://shop.example.com/health">
            <Input id="monitor-url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field id="monitor-interval" label="Check every (seconds)" hint="30 to 3600; default 60.">
            <Input
              id="monitor-interval"
              inputMode="numeric"
              value={interval}
              onChange={(e) => setIntervalText(e.target.value)}
            />
          </Field>
          <Button className="w-full" disabled={pending} onClick={submit}>
            {pending ? 'Saving…' : 'Start monitoring'}
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

'use client';

import { useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';

/** FileReader rather than Blob.text(): it works in every browser the portal supports. */
const readText = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The file could not be read'));
    reader.readAsText(file);
  });

/**
 * Picks a Google Cloud service account JSON key and hands its text to `onUpload`. The key never
 * leaves the browser except in that one request; nothing is kept in page state after it.
 */
export function ServiceAccountUpload({
  label,
  onUpload,
}: {
  label: string;
  onUpload: (key: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="space-y-2">
      <input
        ref={input}
        aria-label="Service account JSON key"
        tabIndex={-1}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        disabled={pending}
        onChange={async (e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (!file) return;
          setError(null);
          if (file.size > 16 * 1024) {
            setError('This file is too large to be a service account key');
            return;
          }
          setPending(true);
          try {
            await onUpload(await readText(file));
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setPending(false);
          }
        }}
      />
      <Button size="sm" variant="outline" disabled={pending} onClick={() => input.current?.click()}>
        {pending ? 'Checking the key…' : label}
      </Button>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

/** How to create the key, so a customer who cannot pass Google's sign-in still connects. */
export function ServiceAccountHowTo() {
  return (
    <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
      <li>Google Cloud console → IAM &amp; Admin → Service accounts → Create service account.</li>
      <li>Open it → Keys → Add key → Create new key → JSON. Upload that file here.</li>
      <li>
        Enable the Google Analytics Admin, Analytics Data, Search Console, Firebase Management, and Play
        Developer Reporting APIs in the same project.
      </li>
      <li>After upload, add the service account email in each Google product (shown on the next page).</li>
    </ol>
  );
}

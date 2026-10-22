import { MAILPIT_URL } from './env';

interface Summary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

/** Waits for a message to `to` whose subject contains `subject`; returns its text body. */
export async function waitForMail(to: string, subject: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=200`);
    const { messages } = (await res.json()) as { messages: Summary[] };
    const hit = messages.find((m) => m.Subject.includes(subject) && m.To.some((t) => t.Address === to));
    if (hit) {
      const full = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
      };
      return full.Text;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no mail "${subject}" to ${to} within ${timeoutMs} ms`);
}

/** Path and query of the first link in a mail body (links point at APP_ORIGIN). */
export function linkPath(text: string): string {
  const match = /https?:\/\/\S+/.exec(text);
  if (!match) throw new Error('no link in mail');
  const url = new URL(match[0]);
  return url.pathname + url.search;
}

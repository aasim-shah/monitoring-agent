import type { Mail, Mailer } from '../src/modules/mail/mailer.js';

/** Captures outgoing mail in tests. */
export class MemoryMailer implements Mailer {
  readonly messages: Mail[] = [];

  async send(mail: Mail): Promise<void> {
    this.messages.push(mail);
  }

  to(email: string): Mail[] {
    return this.messages.filter((m) => m.to === email);
  }

  /** Token from the most recent link sent to `email`. */
  lastToken(email: string): string {
    const mail = this.to(email).at(-1);
    const match = mail && /token=([A-Za-z0-9_-]+)/.exec(mail.text);
    if (!match) throw new Error(`no token mailed to ${email}`);
    return match[1]!;
  }
}

import { Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export const MAILER = Symbol('MAILER');

export class SmtpMailer implements Mailer {
  private readonly transport;
  /** Connect, greeting, and socket limit. Sign-up waits on mail; nodemailer's default is 2 minutes. */
  readonly timeoutMs: number;

  constructor(
    smtpUrl: string,
    private readonly from: string,
    opts: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.transport = nodemailer.createTransport({
      url: smtpUrl,
      connectionTimeout: this.timeoutMs,
      greetingTimeout: this.timeoutMs,
      socketTimeout: this.timeoutMs,
    });
  }

  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}

/** Used when SMTP_URL is unset: logs that mail was not sent, never the body (it contains tokens). */
export class UnconfiguredMailer implements Mailer {
  private readonly logger = new Logger('Mailer');

  async send(mail: Mail): Promise<void> {
    this.logger.warn(`SMTP_URL not configured; mail "${mail.subject}" was not sent`);
  }
}

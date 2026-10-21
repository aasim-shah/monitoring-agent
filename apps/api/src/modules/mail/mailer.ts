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

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
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

import { Global, Module } from '@nestjs/common';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG } from '../../tokens.js';
import { MAILER, SmtpMailer, UnconfiguredMailer } from './mailer.js';

@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) =>
        c.smtpUrl ? new SmtpMailer(c.smtpUrl, c.mailFrom) : new UnconfiguredMailer(),
    },
  ],
  exports: [MAILER],
})
export class MailModule {}

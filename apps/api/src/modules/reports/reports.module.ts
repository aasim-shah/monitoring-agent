import { Module } from '@nestjs/common';
import { createQueues } from '@pcp/jobs';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG } from '../../tokens.js';
import { AuditingModule } from '../auditing/auditing.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService, REPORT_QUEUES } from './reports.service.js';

@Module({
  imports: [AuditingModule],
  controllers: [ReportsController],
  providers: [
    { provide: REPORT_QUEUES, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createQueues(c.redisUrl) },
    ReportsService,
  ],
})
export class ReportsModule {}

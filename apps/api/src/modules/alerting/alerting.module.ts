import { Module } from '@nestjs/common';
import { createQueues } from '@pcp/jobs';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG } from '../../tokens.js';
import { AuditingModule } from '../auditing/auditing.module.js';
import { DiscoveryModule } from '../discovery/discovery.module.js';
import { AlertingController } from './alerting.controller.js';
import { ChannelsService } from './channels.service.js';
import { IncidentsService } from './incidents.service.js';
import { RulesService } from './rules.service.js';
import { ALERT_QUEUES } from './tokens.js';

@Module({
  imports: [AuditingModule, DiscoveryModule],
  controllers: [AlertingController],
  providers: [
    { provide: ALERT_QUEUES, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createQueues(c.redisUrl) },
    RulesService,
    IncidentsService,
    ChannelsService,
  ],
})
export class AlertingModule {}

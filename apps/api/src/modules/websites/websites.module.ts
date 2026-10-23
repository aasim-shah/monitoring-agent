import { resolveTxt } from 'node:dns/promises';
import { Module } from '@nestjs/common';
import { TXT_RESOLVER } from '../../tokens.js';
import { AuditingModule } from '../auditing/auditing.module.js';
import { DiscoveryModule } from '../discovery/discovery.module.js';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { WebsitesController } from './websites.controller.js';
import { WebsitesService } from './websites.service.js';

@Module({
  imports: [AuditingModule, DiscoveryModule, TelemetryModule],
  controllers: [WebsitesController],
  providers: [{ provide: TXT_RESOLVER, useValue: resolveTxt }, WebsitesService],
})
export class WebsitesModule {}

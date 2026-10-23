import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { AuditingModule } from '../auditing/auditing.module.js';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';

@Module({
  imports: [AssetsModule, AuditingModule, TelemetryModule],
  controllers: [AiController],
  providers: [AiService],
})
export class AiModule {}

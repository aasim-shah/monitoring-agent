import { Module } from '@nestjs/common';
import { TelemetryController } from './telemetry.controller.js';
import { TelemetryQueryService } from './query.service.js';

@Module({
  controllers: [TelemetryController],
  providers: [TelemetryQueryService],
  exports: [TelemetryQueryService],
})
export class TelemetryModule {}

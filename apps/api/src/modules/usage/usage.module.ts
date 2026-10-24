import { Module } from '@nestjs/common';
import { InternalUsageController, UsageController } from './usage.controller.js';
import { UsageService } from './usage.service.js';

@Module({
  controllers: [InternalUsageController, UsageController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}

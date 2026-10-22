import { Module } from '@nestjs/common';
import { AgentConfigController } from './agent-config.controller.js';
import { PacksController } from './packs.controller.js';
import { PacksService } from './packs.service.js';

@Module({
  controllers: [PacksController, AgentConfigController],
  providers: [PacksService],
})
export class PacksModule {}

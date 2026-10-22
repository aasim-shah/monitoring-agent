import { Module } from '@nestjs/common';
import { DiscoveryModule } from '../discovery/discovery.module.js';
import { AgentConfigController } from './agent-config.controller.js';
import { PacksController } from './packs.controller.js';
import { PacksService } from './packs.service.js';

@Module({
  imports: [DiscoveryModule],
  controllers: [PacksController, AgentConfigController],
  providers: [PacksService],
})
export class PacksModule {}

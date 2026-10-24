import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { DiscoveryModule } from '../discovery/discovery.module.js';
import { LiveBoostService } from './live-boost.service.js';
import { AgentConfigController } from './agent-config.controller.js';
import { PacksController } from './packs.controller.js';
import { PacksService } from './packs.service.js';

@Module({
  imports: [DiscoveryModule, AgentsModule],
  controllers: [PacksController, AgentConfigController],
  providers: [PacksService, LiveBoostService],
})
export class PacksModule {}

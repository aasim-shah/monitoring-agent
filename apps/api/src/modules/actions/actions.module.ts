import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { AuditingModule } from '../auditing/auditing.module.js';
import { ActionsController } from './actions.controller.js';
import { ActionsService } from './actions.service.js';

@Module({
  imports: [AgentsModule, AuditingModule],
  controllers: [ActionsController],
  providers: [ActionsService],
  exports: [ActionsService],
})
export class ActionsModule {}

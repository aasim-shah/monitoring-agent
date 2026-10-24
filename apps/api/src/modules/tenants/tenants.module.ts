import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { UsageModule } from '../usage/usage.module.js';
import { LifecycleService } from './lifecycle.service.js';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';

@Module({
  imports: [AgentsModule, UsageModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService, LifecycleService],
  exports: [OrganizationsService],
})
export class TenantsModule {}

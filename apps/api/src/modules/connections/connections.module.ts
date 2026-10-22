import { Module, type DynamicModule } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { AgentsModule } from '../agents/agents.module.js';
import { PrivateOpsService } from './private-ops.service.js';
import { connectorProviders } from './registry.provider.js';

@Module({})
export class ConnectionsModule {
  static register(env: Record<string, string | undefined>): DynamicModule {
    return {
      module: ConnectionsModule,
      imports: [AgentsModule],
      controllers: [CatalogController, ConnectionsController],
      providers: [...connectorProviders(env), PrivateOpsService, ConnectionsService],
    };
  }
}
